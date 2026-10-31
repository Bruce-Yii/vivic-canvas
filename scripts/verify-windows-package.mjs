import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw Error("Run on native Windows.");
const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.resolve(process.argv[2] ?? "");
const cacheRoot = await fs.realpath(path.join(root, ".cache"));
if (!(await fs.realpath(source)).startsWith(cacheRoot + path.sep)) throw Error("Choose a fresh package inside this worktree's .cache.");
const folder = path.join(cacheRoot, `windows-install-verification-${Date.now()}`);
const installed = path.join(folder, "Installed Vivic");
await fs.mkdir(folder);
const report = { at: new Date().toISOString(), native: "win32-x64", source, installed, microphone: false, playback: false, checks: [], passed: false };
const shell = (file, args = []) => new Promise((resolve, reject) => {
  const proc = spawn("powershell.exe", ["-NoProfile", "-File", file, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  for (const stream of [proc.stdout, proc.stderr]) stream.on("data", chunk => { out = (out + chunk).slice(-6000); });
  proc.once("error", reject); proc.once("exit", code => resolve({ code, output: out }));
});
const check = (name, pass, detail = {}) => { report.checks.push({ name, pass, ...detail }); if (!pass) throw Error(name); };
let running = false;
try {
  const install = await shell(path.join(source, "Install-Vivic.ps1"), ["-Destination", installed, "-NoShortcuts"]);
  check("isolated-install-with-spaces", install.code === 0);
  const sentinel = createServer((_req, res) => res.end("test sentinel"));
  await new Promise(resolve => sentinel.listen(0, "127.0.0.1", resolve));
  try {
    const port = sentinel.address().port;
    const rejected = await shell(path.join(installed, "Start-Vivic.ps1"), ["-NoOpen", "-Port", String(port)]);
    check("occupied-port-preserved", rejected.code !== 0 && await (await fetch(`http://127.0.0.1:${port}`)).text() === "test sentinel");
  } finally { await new Promise(resolve => sentinel.close(resolve)); }
  const port = 18888, base = `http://127.0.0.1:${port}`;
  const start = await shell(path.join(installed, "Start-Vivic.ps1"), ["-NoOpen", "-Port", String(port)]);
  running = start.code === 0; check("installed-service-start", running);
  const state = JSON.parse((await fs.readFile(path.join(installed, ".launcher.json"), "utf8")).replace(/^\uFEFF/, ""));
  const second = await shell(path.join(installed, "Start-Vivic.ps1"), ["-NoOpen", "-Port", String(port)]);
  const stateAgain = JSON.parse((await fs.readFile(path.join(installed, ".launcher.json"), "utf8")).replace(/^\uFEFF/, ""));
  check("repeat-start-reuses-owned-process", second.code === 0 && state.pid === stateAgain.pid);
  for (const route of ["/healthz", "/launcher", "/", "/display", "/mobile"]) {
    const res = await fetch(base + route, { signal: AbortSignal.timeout(10000) }); await res.arrayBuffer();
    check(`installed-route-${route}`, res.status === 200, { status: res.status });
  }
  const metadata = await (await fetch(base + "/downloads/android.json")).json();
  const apkResponse = await fetch(base + "/downloads/Vivic-Remote.apk");
  const apk = Buffer.from(await apkResponse.arrayBuffer());
  check("installed-production-apk-download", apkResponse.ok && apk.length === metadata.bytes && createHash("sha256").update(apk).digest("hex") === metadata.sha256, { version: metadata.version, bytes: apk.length, sha256: metadata.sha256 });
  check("stop-owned-service", (await shell(path.join(installed, "Stop-Vivic.ps1"))).code === 0); running = false;
  let stopped = false;
  for (let i = 0; i < 20; i++) {
    try { await fetch(base + "/healthz", { signal: AbortSignal.timeout(1000) }); } catch { stopped = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  check("port-closed-after-stop", stopped);
  report.passed = true;
} finally {
  if (running) await shell(path.join(installed, "Stop-Vivic.ps1")).catch(() => {});
  await fs.writeFile(path.join(folder, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, report: path.join(folder, "result.json") }));
}
