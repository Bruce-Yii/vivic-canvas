#!/usr/bin/env node
/** Launch web/API together and clean up only the process trees created here. */
import { spawn } from "node:child_process";
import { accessSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const windows = process.platform === "win32";
// pnpm run supplies its actual JS/native entry even when pnpm.cmd is a PATH shim.
const pnpmEntry = process.env.npm_execpath;
const jsEntry = /\.(?:c|m)?js$/i.test(pnpmEntry ?? "");
const manager = pnpmEntry ? { command: jsEntry ? process.execPath : pnpmEntry, prefix: jsEntry ? [pnpmEntry] : [], shell: windows && /\.(?:cmd|bat)$/i.test(pnpmEntry) }
  : { command: windows ? "pnpm.cmd" : "pnpm", prefix: [], shell: windows };
if (pnpmEntry) accessSync(path.resolve(pnpmEntry));

const tasks = [
  { name: "web", args: ["--filter", "@vivic/web", "dev"] },
  { name: "api", args: ["--filter", "@vivic/local-api", "dev"] },
];

const children = [];
let shuttingDown = false;

const stopTree = child => new Promise(resolve => {
  if (!child.pid) { resolve(); return; }
  if (windows) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => { child.kill("SIGTERM"); resolve(); });
    killer.once("exit", resolve);
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { resolve(); return; }
    // A wrapper may exit before its children. Keep the grace timer alive so
    // descendants that ignore TERM are also stopped, even after that exit.
    setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      resolve();
    }, 1000);
  }
});

async function shutdown(code, reason = "signal") {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[dev] ${reason} ended; stopping all…`);
  await Promise.all(children.map(stopTree));
  process.exit(code);
}

for (const { name, args } of tasks) {
  if (shuttingDown) break;
  const child = spawn(manager.command, [...manager.prefix, ...args], {
    shell: manager.shell, detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    if (stream) readline.createInterface({ input: stream }).on("line", line => console.log(`[${name}] ${line}`));
  }
  child.once("error", error => {
    console.error(`[${name}] failed to start: ${error.message}`);
    void shutdown(1, name);
  });
  child.once("exit", (code, signal) => { void shutdown(code ?? (signal ? 1 : 0), name); });
}

process.on("SIGINT", () => { void shutdown(0, "SIGINT"); });
process.on("SIGTERM", () => { void shutdown(0, "SIGTERM"); });
