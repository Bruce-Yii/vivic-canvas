import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { createHash } from "node:crypto";

// Run on the matching Mac after package-macos.mjs. No browser, mic, speech,
// model downloads, real canvas or user connection preferences are used.
if (process.platform !== "darwin") throw new Error("This smoke check requires an actual Mac.");
const repo = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.length !== 3) throw new Error("Usage: node scripts/package-macos-smoke.mjs <package-directory>");
const root = path.resolve(process.argv[2]);
const evidence = path.join(repo, ".cache", `macos-smoke-${process.arch}-${Date.now()}`);
await fs.mkdir(evidence, { recursive: true });
const env = { ...process.env, VIVIC_PREFERENCES: "off", VIVIC_MANAGED_DECISION: "off", VIVIC_RUNTIME_ROOT: path.join(evidence, "models") };
const exec = promisify(execFile);
const commandAt = (directory, name, args = []) => exec("/bin/bash", [path.join(directory, `${name}-Vivic.command`), ...args], { env, timeout: 50_000 });
const command = (name, args = []) => commandAt(root, name, args);
const occupied = createServer();
await new Promise((resolve, reject) => { occupied.once("error", reject); occupied.listen(0, "127.0.0.1", resolve); });
const occupiedPort = occupied.address().port;
const free = createServer();
await new Promise((resolve, reject) => { free.once("error", reject); free.listen(0, "127.0.0.1", resolve); });
const port = free.address().port;
await new Promise(resolve => free.close(resolve));
let sentinel;
let installed;
try {
  await assert.rejects(command("Start", ["--no-open", "--port", String(occupiedPort)]), /occupied/);
  assert.equal(occupied.listening, true, "The other app must remain running");
  await command("Start", ["--no-open", "--port", String(port)]);
  const state = JSON.parse(await fs.readFile(path.join(root, ".launcher.json"), "utf8"));
  assert.equal(state.port, port);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).service, "vivic-local-api");
  const launcher = await fetch(`http://127.0.0.1:${port}/launcher`);
  assert.equal(launcher.status, 200);
  assert.match(await launcher.text(), /<html/i);
  await command("Start", ["--no-open", "--port", String(port)]);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, ".launcher.json"), "utf8")).pid, state.pid, "Repeated start reuses its owned API");

  const destination = path.join(evidence, "Vivic Space Test.app");
  await command("Install", ["--destination", destination]);
  await assert.rejects(command("Install", ["--destination", destination]), /EEXIST/);
  installed = path.join(destination, "Contents/Resources/package");
  await assert.rejects(fs.stat(path.join(installed, ".launcher.json")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(installed, "apps/local-api/.env.local")), { code: "ENOENT" });
  const installedRoot = await fs.realpath(installed);
  async function verifyInstalledLinks(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink()) {
        const resolved = await fs.realpath(file);
        assert.ok(resolved.startsWith(installedRoot + path.sep), `Installed symlink escaped its app: ${path.relative(installedRoot, file)}`);
      } else if (item.isDirectory()) await verifyInstalledLinks(file);
    }
  }
  await verifyInstalledLinks(installedRoot);
  await exec("/usr/bin/plutil", ["-lint", path.join(destination, "Contents/Info.plist")]);
  await exec("/bin/bash", ["-n", path.join(destination, "Contents/MacOS/Vivic")]);
  await command("Stop");
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }));
  await command("Stop");

  // Installing the bundle is insufficient: its copied native dependencies,
  // relative assets and executable entry must also work from the .app path.
  await exec(path.join(destination, "Contents/MacOS/Vivic"), ["--no-open", "--port", String(port)], { env, timeout: 50_000 });
  const installedState = JSON.parse(await fs.readFile(path.join(installed, ".launcher.json"), "utf8"));
  assert.equal(installedState.port, port);
  assert.ok(installedState.command.includes(installed), "The installed app owns its own service");
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).service, "vivic-local-api");
  for (const route of ["/", "/launcher", "/display", "/mobile"]) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`);
    assert.equal(response.status, 200, `Installed route ${route}`);
    assert.match(await response.text(), /<html/i, `Installed HTML ${route}`);
  }
  const androidMetadata = await fetch(`http://127.0.0.1:${port}/downloads/android.json`);
  assert.equal(androidMetadata.status, 200, "Installed Android download metadata");
  const android = await androidMetadata.json();
  const androidResponse = await fetch(`http://127.0.0.1:${port}/downloads/Vivic-Remote.apk`);
  assert.equal(androidResponse.status, 200, "Installed Android APK download");
  const apk = Buffer.from(await androidResponse.arrayBuffer());
  assert.equal(apk.length, android.bytes);
  assert.equal(createHash("sha256").update(apk).digest("hex"), android.sha256);
  await commandAt(installed, "Stop");
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }));

  // A forged/stale PID receipt must never authorize stopping an unrelated app.
  sentinel = spawn(path.join(root, "runtime/node"), ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => { sentinel.once("spawn", resolve); sentinel.once("error", reject); });
  const { stdout } = await exec("/bin/ps", ["-ww", "-p", String(sentinel.pid), "-o", "lstart=", "-o", "command="], { env: { ...process.env, LC_ALL: "C" } });
  const match = stdout.trim().match(/^(.{24})\s+(.+)$/);
  assert.ok(match);
  await fs.writeFile(path.join(root, ".launcher.json"), JSON.stringify({ pid: sentinel.pid, birth: match[1], command: match[2], instance: "00000000-0000-0000-0000-000000000000", port }));
  await command("Stop");
  process.kill(sentinel.pid, 0);
  await fs.writeFile(path.join(evidence, "result.json"), JSON.stringify({ platform: process.platform, arch: process.arch,
    passed: ["occupied-port isolation", "bundled API health and launcher", "repeat-start identity", "space-containing app installation", "no credential/state copy", "no install overwrite", "installed symlinks stay inside app", "plist", "installed app executable", "installed app health and four HTML routes", "installed Android APK download and hash", "installed app owned stop", "owned stop", "repeat stop", "stale PID isolation"],
    modelDownloaded: false, browserOpened: false, microphoneUsed: false, speechPlayed: false }, null, 2));
  console.info(`macOS package smoke passed: ${evidence}`);
} finally {
  if (installed) await commandAt(installed, "Stop").catch(() => {});
  await command("Stop").catch(() => {});
  if (sentinel?.exitCode === null) sentinel.kill("SIGTERM");
  await new Promise(resolve => occupied.close(resolve));
}
