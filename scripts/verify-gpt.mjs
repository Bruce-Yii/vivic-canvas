// Run: pnpm --filter @vivic/local-api exec tsx ../../scripts/verify-gpt.mjs
// Explicit Pi OAuth reuse; no token output, new login flow, audio or canvas dispatch.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { GptProvider } from "../apps/local-api/src/gpt/provider.ts";
import { searchGpt } from "../apps/local-api/src/gpt/search.ts";
import { CredentialStore } from "../apps/local-api/src/credentials.ts";
import { runIntent } from "../apps/local-api/src/intent/pipeline.ts";

const directory = new URL("../evidence/phase3-gpt/", import.meta.url);
await mkdir(directory, { recursive: true });
const report = { checkedAt: new Date().toISOString(), audioPlayed: false, microphoneCaptured: false,
  actionsDispatched: false, cases: [], authentication: "existing Pi OAuth through the pinned provider" };
const save = () => writeFile(new URL("live.json", directory), JSON.stringify(report, null, 2) + "\n");
const gpt = new GptProvider();
async function check(name, run) {
  const result = { name, ok: false }; const began = performance.now();
  try { await run(result); result.ok = true; }
  catch (error) { result.error = error instanceof Error ? error.message : "Verification failed"; }
  result.elapsedMs = Math.round(performance.now() - began);
  report.cases.push(result); await save(); console.log(JSON.stringify({ name, ok: result.ok, elapsedMs: result.elapsedMs, error: result.error }));
}
await check("real-pi-oauth-inference", async out => {
  const connected = await gpt.connect("pi"); out.status = gpt.status(); assert.equal(connected, true, out.status.lastError);
});
if (gpt.status().connected) {
  const version = gpt.generation();
  const deps = { credentials: new CredentialStore(), stepfun: { baseUrl: "https://api.stepfun.com/step_plan/v1" },
    planner: { provider: "gpt", connected: true, generate: (messages, signal) => gpt.generate(messages, signal), isCurrent: () => gpt.isCurrent(version) } };
  const context = { canvasId: "gpt-live-isolated", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [] };
  await check("real-gpt-multiple-reminders", async out => {
    const text = "请安排三个提醒：八分钟后喝水，十分钟后休息，十三分钟后开会。";
    out.input = text; out.result = await runIntent({ text, canvasContext: context }, deps);
    assert.equal(out.result.usedProvider, "gpt"); assert.equal(out.result.kind, "envelope");
    const cards = out.result.envelope.actions.filter(action => action.type === "card.create").map(action => action.card);
    assert.equal(cards.length, 3);
    assert.deepEqual(cards.map(card => card.sourceData.reminderText), ["喝水", "休息", "开会"]);
    out.durationsSeconds = cards.map(card => (Date.parse(card.sourceData.targetAt) - Date.parse(card.sourceData.startedAt)) / 1000);
    assert.deepEqual(out.durationsSeconds, [480, 600, 780]);
  });
  await check("real-gpt-subscription-search", async out => {
    out.query = "React Flow official documentation";
    out.results = await searchGpt(gpt, out.query);
    assert.ok(out.results.length > 0);
    assert.ok(out.results.every(row => row.provider === "pi-web-access/gpt-oauth" && new URL(row.url).protocol === "https:"));
  });
}
report.completedAt = new Date().toISOString(); report.ok = report.cases.every(row => row.ok);
report.scope = "Real Pi credential refresh/model inference and subscription search. Synthetic canvas context; returned actions are inspected, not dispatched. No voice, microphone, images, browser session or extra search key.";
await save(); process.exitCode = report.ok ? 0 : 1;
