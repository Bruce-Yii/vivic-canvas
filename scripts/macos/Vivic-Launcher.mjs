import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("./", import.meta.url));
const node = path.join(root, "runtime/node");
const entry = path.join(root, "apps/local-api/src/index.ts");
const guardianEntries = ["processSupervisor.mjs", "startluxSupervisor.mjs", "workerSupervisor.mjs"].map(name => path.join(root, "apps/local-api/src/runtime", name));
const statePath = path.join(root, ".launcher.json");
const lockPath = path.join(root, ".launcher.lock");
const exec = promisify(execFile);
const psOptions = { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 1024 * 1024 };

async function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const { stdout } = await exec("/bin/ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="], psOptions);
    const match = stdout.trim().match(/^(.{24})\s+(.+)$/);
    return match ? { pid, birth: match[1], command: match[2] } : null;
  } catch { return null; }
}
async function sameIdentity(record, expectedCommand) {
  if (!record || typeof record.birth !== "string" || record.command !== expectedCommand) return false;
  const current = await identity(record.pid);
  return !!current && current.birth === record.birth && current.command === expectedCommand;
}
const apiCommand = record => typeof record?.instance === "string" && /^[0-9a-f-]{36}$/.test(record.instance)
  ? `${node} --import tsx ${entry} --vivic-instance=${record.instance}` : "";
const owned = record => sameIdentity(record, apiCommand(record));
const guardianCommands = new Set(guardianEntries.map(entry => `${node} ${entry}`));
async function guardians(pid) {
  const { stdout } = await exec("/bin/ps", ["-ww", "-axo", "pid=,ppid=,command="], psOptions);
  const found = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match && Number(match[2]) === pid && guardianCommands.has(match[3])) {
      const candidate = await identity(Number(match[1]));
      if (candidate && guardianCommands.has(candidate.command)) found.push(candidate);
    }
  }
  return found;
}
async function writeState(record) {
  await fs.writeFile(`${statePath}.tmp`, JSON.stringify(record), { mode: 0o600 });
  await fs.rename(`${statePath}.tmp`, statePath);
}
async function readState() {
  try { return JSON.parse(await fs.readFile(statePath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Launcher state is unreadable. Inspect .launcher.json before retrying.");
  }
}
async function lock() {
  try { await fs.mkdir(lockPath, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    // Never delete a possibly-live lock based on a PID or a timeout alone.
    throw new Error("Another launcher may be busy. Retry shortly. If a launcher crashed, inspect .launcher.lock/owner.json and remove only that lock directory after confirming its process has exited.");
  }
  try {
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(await identity(process.pid)), { mode: 0o600 });
  } catch (error) { await fs.rmdir(lockPath).catch(() => {}); throw error; }
  return async () => {
    await fs.unlink(path.join(lockPath, "owner.json"));
    await fs.rmdir(lockPath);
  };
}
async function portAvailable(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(new Error(`Port ${port} is occupied. Choose --port <another-port> or close that app yourself.`)));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function healthy(record) {
  const url = `http://127.0.0.1:${record.port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!await owned(record)) return false;
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000), redirect: "error" });
      const data = await response.json();
      if (response.ok && data.service === "vivic-local-api" && await owned(record)) return true;
    } catch { /* Readiness has a finite timeout; errors remain in runtime.err.log. */ }
    await delay(500);
  }
  return false;
}
async function waitStopped(record) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!await sameIdentity(record, record.command)) return;
    await delay(250);
  }
  throw new Error("Vivic is still closing. Wait a moment and run Stop-Vivic.command again. The launcher did not force-stop another process.");
}
async function stop(record) {
  const ownedGuardians = Array.isArray(record?.guardians) ? record.guardians : [];
  if (await owned(record)) {
    // Keep the exact guardian identities so a retry can finish waiting even
    // after the API has exited. No process-name scan or process-group kill.
    ownedGuardians.push(...await guardians(record.pid));
    record.guardians = ownedGuardians;
    await writeState(record);
    if (await owned(record)) process.kill(record.pid, "SIGTERM");
    await waitStopped(record);
  }
  for (const guardian of ownedGuardians) {
    if (guardianCommands.has(guardian.command) && await sameIdentity(guardian, guardian.command)) await waitStopped(guardian);
  }
  await fs.rm(statePath, { force: true });
}
async function openLauncher(record, noOpen) {
  const url = `http://127.0.0.1:${record.port}/launcher`;
  console.info(`Vivic is ready: ${url}`);
  if (!noOpen) await exec("/usr/bin/open", [url]);
}
async function start(port, noOpen) {
  const previous = await readState();
  if (previous && await owned(previous)) {
    if (!Number.isInteger(previous.port) || previous.port < 1024 || previous.port > 65535) throw new Error("Invalid launcher state port.");
    if (!await healthy(previous)) throw new Error("Vivic is running but not healthy. Run Stop-Vivic.command, then retry. See runtime.err.log.");
    return openLauncher(previous, noOpen);
  }
  if (previous?.guardians) {
    for (const guardian of previous.guardians) {
      if (guardianCommands.has(guardian.command) && await sameIdentity(guardian, guardian.command)) throw new Error("The previous model is still closing. Run Stop-Vivic.command before restarting.");
    }
  }
  await portAvailable(port);
  const instance = randomUUID();
  const out = await fs.open(path.join(root, "runtime.out.log"), "a", 0o600);
  const err = await fs.open(path.join(root, "runtime.err.log"), "a", 0o600);
  let child;
  let created;
  try {
    child = spawn(node, ["--import", "tsx", entry, `--vivic-instance=${instance}`], {
      cwd: path.join(root, "apps/local-api"), detached: true,
      stdio: ["ignore", out.fd, err.fd],
      env: { ...process.env, PORT: String(port), VIVIC_ALLOWED_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}` },
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    const expected = apiCommand({ instance });
    for (let attempt = 0; attempt < 20; attempt++) {
      const snapshot = await identity(child.pid);
      if (snapshot?.command === expected) { created = { ...snapshot, port, instance }; break; }
      await delay(50);
    }
    if (!created) throw new Error("Vivic exited before its process identity could be checked. See runtime.err.log.");
    await writeState(created);
    console.info("Starting Vivic and checking its local service...");
    if (!await healthy(created)) throw new Error("Vivic could not become ready. See runtime.err.log, then retry Start-Vivic.command.");
  } catch (error) {
    if (created) await stop(created);
    // A child handle belongs to this spawn, even before the state was written.
    else if (child && child.exitCode === null) child.kill("SIGTERM");
    throw error;
  } finally { await out.close(); await err.close(); }
  // An OS browser-opening failure must not discard the healthy API or secrets.
  await openLauncher(created, noOpen);
}
async function install(destination) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.resolve(destination || path.join(homedir(), "Applications", `Vivic ${stamp}.app`));
  if (!target.endsWith(".app")) throw new Error("Choose a new .app destination, for example ~/Applications/Vivic.app.");
  const source = await fs.realpath(root);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const parent = await fs.realpath(path.dirname(target));
  const resolved = path.join(parent, path.basename(target));
  if (resolved === source || resolved.startsWith(`${source}${path.sep}`)) throw new Error("Choose an installation outside the source package.");
  await fs.mkdir(resolved); // Exclusive: never overwrite another installation.
  const contents = path.join(resolved, "Contents");
  const packageRoot = path.join(contents, "Resources/package");
  await fs.mkdir(packageRoot, { recursive: true });
  const allowed = new Set(["apps", "runtime", "release.json", "README.txt", "LICENSES.md", "VIVIC-NOTICE.txt", "Start-Vivic.command", "Stop-Vivic.command", "Install-Vivic.command", "Vivic-Launcher.mjs"]);
  // Keep deployment-relative links relative to the installed bundle. Resolving
  // them here would leave command shims pointing into the extracted ZIP folder.
  await fs.cp(source, packageRoot, { recursive: true, verbatimSymlinks: true, filter: candidate => {
    const relative = path.relative(source, candidate);
    if (!relative) return true;
    const components = relative.split(path.sep);
    return allowed.has(components[0]) && !components.some(name => name === ".git" || name === ".cache" || name.startsWith(".env") || name.endsWith(".log") || name.startsWith(".launcher"));
  } });
  await fs.mkdir(path.join(contents, "MacOS"));
  await fs.writeFile(path.join(contents, "MacOS/Vivic"), '#!/bin/bash\nset -euo pipefail\ntaskRoot="$(cd -- "$(dirname -- "$0")/../Resources/package" && pwd -P)"\nexec "$taskRoot/Start-Vivic.command" "$@"\n', { mode: 0o755 });
  await fs.writeFile(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Vivic</string><key>CFBundleIdentifier</key><string>com.vivic.local-preview</string><key>CFBundleName</key><string>Vivic</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSMinimumSystemVersion</key><string>13.5</string><key>LSUIElement</key><true/></dict></plist>\n`);
  console.info(`Installed: ${resolved}`);
  console.info(`Open this Vivic.app to start. To stop: ${path.join(packageRoot, "Stop-Vivic.command")}`);
}

try {
  if (process.platform !== "darwin") throw new Error("This launcher runs only on macOS.");
  const receipt = JSON.parse(await fs.readFile(path.join(root, "release.json"), "utf8"));
  if (receipt.platform !== `darwin-${process.arch}`) throw new Error("The package does not match this Node architecture.");
  if (createHash("sha256").update(await fs.readFile(node)).digest("hex") !== receipt.nodeSha256) throw new Error("Node runtime verification failed.");
  const [action, ...options] = process.argv.slice(2);
  if (action === "install") {
    if (options.length && (options.length !== 2 || options[0] !== "--destination")) throw new Error("Usage: ./Install-Vivic.command [--destination <new.app>]");
    await install(options[1]);
  } else {
    let port = 18787, noOpen = false;
    for (let i = 0; i < options.length; i++) {
      if (action === "start" && options[i] === "--no-open") noOpen = true;
      else if (action === "start" && options[i] === "--port" && /^\d+$/.test(options[i + 1] || "")) port = Number(options[++i]);
      else throw new Error("Usage: ./Start-Vivic.command [--no-open] [--port 18788] or ./Stop-Vivic.command");
    }
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be between 1024 and 65535.");
    if (action !== "start" && action !== "stop") throw new Error("Unknown launcher action.");
    const release = await lock();
    try {
      if (action === "start") await start(port, noOpen);
      else {
        const record = await readState();
        if (record) await stop(record);
        console.info(record ? "Vivic and its owned local model have stopped." : "This Vivic package is already stopped.");
      }
    } finally { await release(); }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
