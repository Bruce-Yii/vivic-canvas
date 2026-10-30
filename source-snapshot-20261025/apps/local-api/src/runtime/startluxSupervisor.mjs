import { spawn } from "node:child_process";
// A single API-owned guardian owns both actual processes; IPC EOF also releases them.
const children = new Set();
let stopping = false, worker, initialized = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (!children.size) process.exit(0);
  for (const child of children) child.kill();
  const force = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 1000);
  force.unref();
}
process.once("disconnect", stop); process.once("SIGTERM", stop); process.once("SIGINT", stop);
function own(executable, args, env, pipes = false) {
  const child = spawn(executable, args, { env: { ...process.env, ...env }, windowsHide:true, stdio: pipes ? ["pipe","pipe","ignore"] : "ignore" });
  children.add(child);
  child.once("error", stop);
  child.once("close", () => { children.delete(child); if (!stopping) stop(); if (!children.size) process.exit(stopping ? 0 : 1); });
  return child;
}
process.on("message", message => {
  if (stopping || !process.connected || !message || typeof message !== "object") return;
  if (message.kind === "engine" && !initialized) {
    initialized = true;
    own(message.executable, message.args, message.env);
  } else if (message.kind === "worker" && initialized && !worker) {
    worker = own(message.executable, message.args, message.env, true);
    let buffer = "";
    worker.stdout.on("data", data => {
      buffer += data.toString("utf8"); if (buffer.length > 65536) return stop();
      const lines = buffer.split("\n"); buffer = lines.pop();
      for (const line of lines) {
        try { const parsed = JSON.parse(line); if (process.connected) process.send(parsed); } catch { stop(); }
      }
    });
    worker.stdin.on("error", stop);
    worker.stdin.write(JSON.stringify(message.config) + "\n");
  } else if (message.kind === "request" && worker && Number.isSafeInteger(message.id)) {
    const line = JSON.stringify({id:message.id,payload:message.payload});
    if (Buffer.byteLength(line, "utf8") > 131072) return stop();
    worker.stdin.write(line + "\n");
  }
});
if (!process.connected) stop();
