/** Real cached StartLux native readout on synthetic task contexts; never opens or changes a user canvas. */
import fs from "node:fs/promises";
import path from "node:path";
import { ManagedStartluxRuntime } from "../../apps/local-api/src/runtime/startluxRuntime.js";
import { STARTLUX_PROFILES } from "../../apps/local-api/src/runtime/startluxProfiles.js";
import { DecisionTaskManager } from "../../apps/local-api/src/decision/taskV2.js";
import type { NativeQuestion } from "../../apps/local-api/src/decision/nativeV2.js";
import type { IntentResult } from "../../apps/local-api/src/intent/pipeline.js";

const root = process.argv[2];
if (!root || process.argv.length > 5) throw new Error("Usage: tsx scripts/decision-model/native-v2-probe.ts <existing-runtime-root> [output.json] [profileId]");
const output = path.resolve(process.argv[3] ?? ".cache/decision-v2-live/probe.json");
const profile = STARTLUX_PROFILES.find(candidate => candidate.id === (process.argv[4] ?? "startlux-0.8b"));
if (!profile) throw new Error("Choose a pinned StartLux profileId; arbitrary model paths are not accepted.");
const modelConfig = JSON.parse(await fs.readFile(path.join(root, profile.id, "config.json"), "utf8"));
const maxContext = modelConfig.text_config?.max_position_embeddings ?? modelConfig.max_position_embeddings;
if (!Number.isFinite(maxContext) || maxContext < 8192) throw new Error("Pinned model metadata does not establish 8192 context support");
const runtime = new ManagedStartluxRuntime(path.resolve(root), profile.id, { contextLength: 8192 });
const calls: unknown[] = [], results: unknown[] = [];
let activeCase = "";
const provider = { async decide(state: unknown, questions: Record<string, NativeQuestion>, signal?: AbortSignal) {
  const start = performance.now(), result = await runtime.decideNative(state, questions, signal);
  calls.push({ case: activeCase, questions, phase: (state as { phase?: string }).phase, stateBytes: Buffer.byteLength(JSON.stringify(state)), result, elapsedMs: Math.round(performance.now() - start) });
  console.log(JSON.stringify({ event: "native-question", case: activeCase, questions: Object.keys(questions), ok: result.ok, elapsedMs: Math.round(performance.now() - start) }));
  return result;
} };
// Enables only this in-memory synthetic executor. No deployment setting or user environment is changed.
const tasks = new DecisionTaskManager({ provider, gate: { executionEnabled: true }, maxActiveMs: 90_000 });
const context = { canvasId: "synthetic-native-v2", version: 1, totalCardCount: 2, stage: "WORKSPACE" as const, viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: ["synthetic-left"], selectedCardIds: ["synthetic-left"], timeZone: "Asia/Shanghai",
  cards: [0, 1].map(index => ({ id: index ? "synthetic-right" : "synthetic-left", type: "NoteCard", displayProps: { text: index ? "右边笔记" : "左边笔记" }, sourceDataSummary: {}, layout: { x: index * 400, y: 0, width: 320, height: 200, pinned: false }, surface: "display" as const })) };
try {
  runtime.enable();
  const deadline = Date.now() + 180_000;
  let lastLog = 0;
  while (runtime.status().phase !== "ready") {
    if (runtime.status().phase === "error" || Date.now() > deadline) throw new Error("Native runtime did not become ready");
    if (Date.now() - lastLog > 10_000) { console.log(JSON.stringify({ event: "loading", phase: runtime.status().phase })); lastLog = Date.now(); }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  activeCase = "short-native-baseline";
  await provider.decide({ user_message: "显示全部卡片" }, { next_step: { type: "choice", instructions: "选择用户想做的操作。", criteria: { fit: "显示全部卡片", focus: "聚焦一张卡片", noop: "没有操作" } } });
  for (const text of ["聚焦左边的便笺", "十五分钟后提醒我喝水", "提醒我喝水", "不要删除，聚焦它", "解释‘删除全部卡片’"]) {
    activeCase = text;
    const id = `probe-${results.length}`, started = performance.now();
    let plannerCalls = 0;
    const deps = { legacy: async (): Promise<IntentResult> => { plannerCalls++; return { kind: "unknown", message: "独立原生探针未连接主LLM" }; } };
    let result = await tasks.run({ text, task: { id }, canvasContext: context }, deps);
    const proposed = { kind: result.kind, envelope: result.envelope, hostOperation: result.hostOperation };
    if (result.task?.status === "awaiting_execution") {
      // Explicitly simulated receipt; no production executor is called.
      const created = result.envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card] : []) ?? [];
      const latest = { ...context, version: 2, totalCardCount: context.cards.length + created.length,
        cards: [...context.cards, ...created.map(card => ({ id: card.id, type: card.type, displayProps: card.displayProps, sourceDataSummary: card.sourceData, layout: card.layout, surface: "display" as const }))] };
      result = await tasks.run({ text, task: { id, receipt: { executionId: result.task.executionId!, status: "succeeded", createdCardIds: created.map(card => card.id) } }, canvasContext: latest }, deps);
    }
    results.push({ text, proposed, final: result, plannerCalls, receipt: "simulated-only", elapsedMs: Math.round(performance.now() - started) });
    console.log(JSON.stringify({ event: "case", text, kind: result.kind, status: result.task?.status, plannerCalls }));
    if (runtime.status().phase !== "ready") break;
  }
} finally {
  tasks.dispose(); runtime.stop();
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ testedAt: new Date().toISOString(), model: profile.label, contextLength: 8192,
    modelMaxContext: maxContext, qualityGateChanged: false, realNativeInference: true, productionExecution: false, calls, results }, null, 2));
  console.log(JSON.stringify({ event: "evidence", path: output, cases: results.length, nativeCalls: calls.length }));
}
