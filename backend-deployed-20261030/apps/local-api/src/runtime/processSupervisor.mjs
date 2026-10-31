import { spawn } from "node:child_process";

// Private IPC only: no HTTP listener, shell, file-based PID lookup or unrelated process cleanup.
let engine;
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (!engine || engine.exitCode !== null) process.exit(0);
  engine.kill();
  const force = setTimeout(() => { engine.kill("SIGKILL"); }, 1000);
  force.unref();
}
process.once("disconnect", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.once("message", config => {
  if (stopping || !process.connected) return stop();
  if (!config || typeof config.executable !== "string" || !Array.isArray(config.args)
    || config.args.some(arg => typeof arg !== "string") || typeof config.cwd !== "string") process.exit(1);
  engine = spawn(config.executable, config.args, { cwd: config.cwd, env: process.env,
    windowsHide: true, stdio: "ignore" });
  engine.once("error", () => process.exit(1));
  engine.once("exit", code => process.exit(stopping ? 0 : code || 1));
});
if (!process.connected) stop();
