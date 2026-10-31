/** Real local-model smoke + isolated HTTP API; no user credentials, browser, canvas or audio. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { serve } from "../../apps/local-api/node_modules/@hono/node-server/dist/index.mjs";
import { createApp } from "../../apps/local-api/src/app.js";
import { HttpDecisionProvider, LOCAL_CHOICE_PROMPT } from "../../apps/local-api/src/decision/provider.js";

const output = process.argv[2];
if (!output) throw new Error("Provide a fresh evidence directory");
await fs.mkdir(output, { recursive: false });
const token = randomUUID();
const provider = new HttpDecisionProvider("http://127.0.0.1:8790/v1/chat/completions", {
  name: "local", protocol: "local-chat", model: "MiniCPM5-1B", timeoutMs: 10_000,
});
const app = createApp({ config: {
  port: 8788, host: "127.0.0.1", token, tokenGenerated: false, tokenPath: "unused",
  allowedOrigins: ["http://localhost:5174"], stepfunBaseUrl: "https://api.stepfun.com/step_plan/v1",
  requestTimeoutMs: 1000, bodyLimitBytes: 65536, searchEnabled: false, decisionProviderTimeoutMs: 10_000,
}, decisionProvider: provider });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 8788 });
const ctx = { canvasId: "TEST-DEC-01", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [],
  cards: [{ id: "TEST-note", type: "NoteCard", displayProps: { text: "TEST" }, sourceDataSummary: {}, layout: { x: 0, y: 0 } }] };
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const request = async (text: string) => {
  const before = performance.now();
  const reply = await fetch("http://127.0.0.1:8788/api/intent", { method: "POST", headers,
    body: JSON.stringify({ text, canvasContext: ctx }) });
  return { input: text, httpStatus: reply.status, body: await reply.json(), roundtripMs: performance.now() - before };
};
try {
  const direct = await provider.decide("展开便笺");
  const routed = await request("展开便笺");
  const status = await (await fetch("http://127.0.0.1:8788/api/decision/status", { headers })).json();
  const stopped = await (await fetch("http://127.0.0.1:8788/api/decision/stop", { method: "POST", headers })).json();
  const afterStop = await request("展开便笺");
  const rule = await request("十分钟倒计时");
  const report = { createdAt: new Date().toISOString(), model: "MiniCPM5-1B-Q8_0", engine: "llama.cpp b9660",
    promptSha256: createHash("sha256").update(LOCAL_CHOICE_PROMPT).digest("hex"),
    direct, routed, status, stopped, afterStop, rule,
    scope: "Real local model and HTTP API, synthetic TEST context; no connected main planner; not model accuracy acceptance." };
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (direct.state !== "deferred" || direct.choiceId !== "expand" || routed.body.kind !== "unknown"
    || status.lastState !== "deferred" || stopped.enabled !== false || afterStop.body.kind !== "unknown"
    || rule.body.kind !== "envelope" || rule.body.usedProvider !== "rules") process.exitCode = 1;
} finally {
  app.dispose();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
