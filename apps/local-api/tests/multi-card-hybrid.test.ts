import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema, CardRecordSchema, type IntentRouteId } from "@vivic/contracts";
import { CredentialStore } from "../src/credentials.js";
import { IntentResponseSchema, type CanvasContext } from "../src/schemas.js";
import { runIntent, type IntentRequest, type IntentResult, type PipelineDeps } from "../src/intent/pipeline.js";
import { isInitialTask } from "../src/decision/on.js";
import { DecisionTaskManager } from "../src/decision/taskV2.js";
import type { IntentRouter, RouteResult } from "../src/decision/router.js";
import { SEARCH_PROVIDER, type SearchEvidence } from "../src/search/index.js";
import type { ChatMessage, StepfunResult } from "../src/stepfun.js";

const originalMode = process.env.VIVIC_MULTI_CARD_MODE;
afterEach(() => {
  if (originalMode === undefined) delete process.env.VIVIC_MULTI_CARD_MODE;
  else process.env.VIVIC_MULTI_CARD_MODE = originalMode;
  vi.restoreAllMocks();
});

const allowed: IntentRouteId[] = ["countdown", "todo", "note", "overview", "restore"];
const context = (cards: CanvasContext["cards"] = []): CanvasContext =>
  ({ canvasId: "TEST-multi", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards });
const route = (id: IntentRouteId, probability = .99): RouteResult =>
  ({ route: id, probability, probabilities: { [id]: probability }, none: false, latencyMs: 1 });
/** The task wrapper always scopes a multi-clause request with its own state;
 * it must not hide rule provenance or shift the planner's clause indexes. */
const hostTask = (text: string, completed: string[] = []) => ({ original_goal: text, completed_steps: completed, observations: [],
  instruction: "只完成尚未执行的目标，不得重复已成功步骤。" });

/** Sentence text → the classifier answer the observer/decider would share. */
const routeFor = (text: string): IntentRouteId => {
  if (/显示全部/.test(text)) return "overview";
  if (/恢复原视图/.test(text)) return "restore";
  if (/撤销/.test(text)) return "undo" as IntentRouteId;
  if (/查|搜|天气/.test(text)) return "search";
  if (/笑话|聊天/.test(text)) return "chat";
  if (/聚焦|看看这张/.test(text)) return "focus";
  if (/便签|便笺|笔记/.test(text)) return "note";
  if (/待办|清单/.test(text)) return "todo";
  return "countdown";
};

interface PlannerInput { utterance: string; clauses: string[]; taskState: Record<string, unknown> | undefined }

function setup(answer: (input: PlannerInput) => unknown = countdownAnswer) {
  const requests: PlannerInput[] = [];
  const generate = vi.fn(async (messages: ChatMessage[]): Promise<StepfunResult<unknown>> => {
    // Repair attempts append a validation note; the stub sees the original payload.
    const raw = String(messages[1]?.content ?? "{}").split("\n上次校验失败")[0]!;
    const user = JSON.parse(raw) as { utterance?: string; clauses?: string[]; task_state?: Record<string, unknown> };
    const input: PlannerInput = { utterance: String(user.utterance ?? ""),
      clauses: Array.isArray(user.clauses) ? user.clauses : [], taskState: user.task_state };
    requests.push(input);
    return { ok: true, value: answer(input) };
  });
  const router: IntentRouter = { mode: "on", directRoutes: new Set(allowed),
    routeUtterance: vi.fn(async (text: string) => route(routeFor(text))), chooseTarget: vi.fn(async () => null) };
  const onDecisionTrace = vi.fn();
  const deps: PipelineDeps = { credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" },
    planner: { provider: "gpt", connected: true, isCurrent: () => true, generate }, router, onDecisionTrace };
  return { deps, router, generate, requests, onDecisionTrace };
}

/** The controlled planner answers exactly the clauses it was given. */
function countdownAnswer({ clauses, utterance }: PlannerInput): unknown {
  const list = clauses.length ? clauses : [utterance];
  const plans = list.map((clause, index) => ({ contract: "countdown", clause: index,
    slots: /喝水/.test(clause) ? { seconds: 600, text: "喝水" } : { seconds: 300, text: "休息" } }));
  return list.length > 1
    ? { plans, say: "已设置计时。", text: `已设置 ${plans.length} 项计时。` }
    : { slots: plans[0]!.slots, say: "已设置计时。", text: "倒计时已开始。" };
}

const cards = (result: IntentResult) =>
  result.envelope?.actions.flatMap(action => action.type === "card.create" ? [CardRecordSchema.parse(action.card)] : []) ?? [];
const seconds = (card: { sourceData: Record<string, unknown> }) =>
  Math.round((Date.parse(String(card.sourceData.targetAt)) - Date.parse(String(card.sourceData.startedAt))) / 1000);
const searchRows: SearchEvidence[] = ["结果一", "结果二"].map((title, index) => ({
  title, url: `https://example.com/hybrid/${index}`, snippet: `${title} 的摘要。`,
  provider: SEARCH_PROVIDER, fetchedAt: "2026-10-15T06:00:00.000Z", readFullPage: false,
}));

// Two rule clauses, two clauses that need the model in one sentence.
const mixed = "帮我记个便签交周报，然后过五分钟叫我休息，再过十分钟叫我喝水";
// Pure literal: note + timer.
const literal = "帮我记个便签明天交周报，再设个50分钟倒计时";

describe("VIVIC_MULTI_CARD_MODE=off keeps the pre-existing path", () => {
  it("does not set plans provenance and still plans each unparsed clause separately", async () => {
    delete process.env.VIVIC_MULTI_CARD_MODE;
    const f = setup();
    const r = await runIntent({ text: mixed, canvasContext: context() }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    // The pre-existing per-clause fallback pays once for each unparsed clause.
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.requests.map(request => request.utterance)).toEqual(["过五分钟叫我休息", "过十分钟叫我喝水"]);
    expect(cards(r).map(card => card.type)).toEqual(["NoteCard", "CountdownCard", "CountdownCard"]);
    expect(r.trace).toMatchObject({ plannerCalls: 2, directClauses: 1 });
    expect(r.trace?.plans).toBeUndefined();
  });

  it("an explicit off value matches the unset default", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "off";
    const f = setup();
    const r = await runIntent({ text: mixed, canvasContext: context() }, f.deps);
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(cards(r).map(card => card.type)).toEqual(["NoteCard", "CountdownCard", "CountdownCard"]);
    expect(r.trace?.plans).toBeUndefined();
  });
});

describe("VIVIC_MULTI_CARD_MODE=hybrid proposes literal clauses and plans only the rest", () => {
  it("sends the remaining clause subset in ONE planner call and never rewrites the rule segment", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup();
    const r = await runIntent({ text: mixed, canvasContext: context() }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(f.generate).toHaveBeenCalledTimes(1);
    const [request] = f.requests;
    expect(request!.utterance).toBe("过五分钟叫我休息，过十分钟叫我喝水");
    expect(request!.clauses).toEqual(["过五分钟叫我休息", "过十分钟叫我喝水"]);
    expect(request!.taskState).toMatchObject({ original_goal: mixed, active_clauses: request!.clauses,
      active_clause_indexes: [1, 2] });
    const created = cards(r);
    expect(created.map(card => card.type)).toEqual(["NoteCard", "CountdownCard", "CountdownCard"]);
    // The literal clause keeps the user's exact content; the model never saw it.
    expect(created[0]!.displayProps).toEqual({ text: "交周报" });
    expect(created.slice(1).map(card => seconds(card))).toEqual([300, 600]);
    expect(r.trace).toMatchObject({ plannerCalls: 1, directClauses: 1 });
  });

  it("records clause → contract → card provenance for both segments", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup();
    const r = await runIntent({ text: mixed, canvasContext: context() }, f.deps);
    expect(r.trace?.clauses).toEqual(["帮我记个便签交周报", "过五分钟叫我休息", "过十分钟叫我喝水"]);
    const plans = r.trace?.plans ?? [];
    expect(plans.map(plan => [plan.clause, plan.contract, plan.source])).toEqual([
      [0, "note", "rules"], [1, "countdown", "planner"], [2, "countdown", "planner"],
    ]);
    const created = cards(r).map(card => card.id);
    expect(plans.flatMap(plan => plan.cardIds).sort()).toEqual([...created].sort());
    // Clause-order coverage in the same trace: one card per clause, types only.
    expect(r.trace?.decisions.map(row => row.built)).toEqual([
      { cards: ["NoteCard"], n: 1 }, { cards: ["CountdownCard"], n: 1 }, { cards: ["CountdownCard"], n: 1 },
    ]);
    // The trace augmentation must still be accepted by the strict wire schema.
    expect(IntentResponseSchema.safeParse(r).success).toBe(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.onDecisionTrace).toHaveBeenCalledTimes(1);
  });

  it("keeps a fully literal sentence at zero planner calls and one atomic envelope", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup();
    const ctx = { ...context(), stage: "STANDBY" as const };
    const before = structuredClone(ctx);
    const r = await runIntent({ text: literal, canvasContext: ctx }, f.deps);
    expect(r.kind).toBe("envelope");
    expect(f.generate).not.toHaveBeenCalled();
    const created = cards(r);
    expect(created.map(card => card.type)).toEqual(["NoteCard", "CountdownCard"]);
    expect(seconds(created[1]!)).toBe(3000);
    expect(r.envelope!.actions.filter(action => action.type === "stage.awaken")).toHaveLength(1);
    expect(r.envelope!.actions.filter(action => action.type === "canvas.fit")).toHaveLength(1);
    expect(r.trace).toMatchObject({ plannerCalls: 0, directClauses: 2 });
    expect(r.trace?.plans?.map(plan => [plan.clause, plan.contract, plan.source]))
      .toEqual([[0, "note", "rules"], [1, "countdown", "rules"]]);
    expect(ctx).toEqual(before);
  });

  it("mixes a literal note with one planned timer and shares the occupied layout", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup();
    const r = await runIntent({ text: "帮我记个便签明天交周报，然后过五分钟叫我休息", canvasContext: context() }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(f.generate).toHaveBeenCalledTimes(1);
    const created = cards(r);
    expect(created.map(card => card.type)).toEqual(["NoteCard", "CountdownCard"]);
    expect(created[0]!.displayProps).toEqual({ text: "明天交周报" });
    expect(seconds(created[1]!)).toBe(300);
    // The planner was given the rule card, so the two cards cannot overlap.
    expect(created[1]!.layout.x).toBeGreaterThanOrEqual(created[0]!.layout.x + created[0]!.layout.width);
    expect(r.envelope!.actions.filter(action => action.type === "canvas.fit")).toHaveLength(1);
    // The planner's spoken channel survives the merge instead of being replaced.
    expect(r.envelope!.spokenText).toBe("已设置计时。");
  });

  it("runs hybrid on the host's initial task context instead of per-clause", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup();
    // Production `taskV2` scopes every on-mode turn, including the first one.
    const text = "帮我记个便签明天交周报，然后过五分钟叫我休息";
    const r = await runIntent({ text, canvasContext: context(), taskContext: hostTask(text) }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    // One planner call for the remaining clause subset, not one per clause.
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.requests[0]!.clauses).toEqual(["过五分钟叫我休息"]);
    expect(f.requests[0]!.taskState).toMatchObject({ active_clauses: ["过五分钟叫我休息"], active_clause_indexes: [1] });
    const created = cards(r);
    expect(created.map(card => card.type)).toEqual(["NoteCard", "CountdownCard"]);
    expect(created[0]!.displayProps).toEqual({ text: "明天交周报" });
    expect(seconds(created[1]!)).toBe(300);
    expect(r.trace?.plans?.map(plan => [plan.clause, plan.contract, plan.source])).toEqual([
      [0, "note", "rules"], [1, "countdown", "planner"],
    ]);
    expect(r.trace).toMatchObject({ plannerCalls: 1, directClauses: 1 });
  });

  it("reaches hybrid through the real task wrapper's first fallback turn", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup();
    const text = "过五分钟叫我休息，然后记个便签交周报，再过十分钟叫我喝水";
    const tasks = new DecisionTaskManager();
    // No native provider: taskV2's first turn hands runIntent the injected initial
    // taskContext, which is exactly the production shape that used to bypass hybrid.
    const r = await tasks.run({ text, canvasContext: context() },
      { legacy: (request, signal) => runIntent(request, f.deps, signal) });
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(r.task?.status).toBe("awaiting_execution");
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.requests[0]!.clauses).toEqual(["过五分钟叫我休息", "过十分钟叫我喝水"]);
    expect(cards(r).map(card => card.type)).toEqual(["CountdownCard", "NoteCard", "CountdownCard"]);
    expect(r.trace?.plans?.map(plan => [plan.clause, plan.contract, plan.source])).toEqual([
      [0, "countdown", "planner"], [1, "note", "rules"], [2, "countdown", "planner"],
    ]);
  });

  it("keeps rule and planner provenance under the host task context", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup();
    const text = "记个便笺明天交周报，再过五分钟叫我休息";
    const r = await runIntent({ text, canvasContext: context(), taskContext: hostTask(text) }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    const created = cards(r);
    expect(created.map(card => card.type)).toEqual(["NoteCard", "CountdownCard"]);
    expect(created[0]!.displayProps).toEqual({ text: "明天交周报" });
    expect(seconds(created[1]!)).toBe(300);
    // The planner only saw clause 1, yet provenance stays on the user's clause.
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.requests[0]!.utterance).toBe("过五分钟叫我休息");
    expect(f.requests[0]!.taskState).toMatchObject({ active_clause_indexes: [1] });
    expect(r.trace?.plans?.map(plan => [plan.clause, plan.contract, plan.source])).toEqual([
      [0, "note", "rules"], [1, "countdown", "planner"],
    ]);
    expect(r.trace?.plans?.flatMap(plan => plan.cardIds).sort()).toEqual(created.map(card => card.id).sort());
    expect(r.trace).toMatchObject({ plannerCalls: 1, directClauses: 1 });
  });

  it("keeps interleaved clause indexes under the host task context", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup();
    const text = "过五分钟叫我休息，然后记个便签交周报，再过十分钟叫我喝水";
    const r = await runIntent({ text, canvasContext: context(), taskContext: hostTask(text) }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    // [planner, rule, planner] must stay in user order with ONE planner call.
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.requests[0]!.clauses).toEqual(["过五分钟叫我休息", "过十分钟叫我喝水"]);
    expect(f.requests[0]!.taskState).toMatchObject({ active_clause_indexes: [0, 2] });
    const created = cards(r);
    expect(created.map(card => card.type)).toEqual(["CountdownCard", "NoteCard", "CountdownCard"]);
    expect(created[1]!.displayProps).toEqual({ text: "交周报" });
    expect(r.trace?.plans?.map(plan => [plan.clause, plan.contract, plan.source])).toEqual([
      [0, "countdown", "planner"], [1, "note", "rules"], [2, "countdown", "planner"],
    ]);
    expect(new Set(r.trace?.plans?.map(plan => plan.clause)).size).toBe(3);
  });

  it("keeps a task that already completed a step on the per-clause path", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup();
    const text = "过五分钟叫我休息，然后记个便签交周报，再过十分钟叫我喝水";
    const r = await runIntent({ text, canvasContext: context(), taskContext: hostTask(text, ["validated_plan"]) }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    // Completed steps mean a follow-up: one planner call per unparsed clause.
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.requests.map(request => request.utterance)).toEqual(["过五分钟叫我休息", "过十分钟叫我喝水"]);
    expect(f.requests.map(request => request.taskState?.active_clauses)).toEqual([undefined, undefined]);
    expect(cards(r).map(card => card.type)).toEqual(["CountdownCard", "NoteCard", "CountdownCard"]);
  });

  it("treats only the host's first-turn fallback shape as initial", () => {
    const req = (taskContext?: unknown, extra: Record<string, unknown> = {}) =>
      ({ text: "记个便签，再过五分钟叫我休息", canvasContext: context(), ...(taskContext === undefined ? {} : { taskContext }),
        ...extra }) as unknown as IntentRequest;
    const instruction = "只完成尚未执行的目标，不得重复已成功步骤。";
    expect(isInitialTask(req())).toBe(true);
    expect(isInitialTask(req(hostTask("记个便签，再过五分钟叫我休息")))).toBe(true);
    expect(isInitialTask(req({ original_goal: "目标", instruction }))).toBe(true);
    expect(isInitialTask(req(hostTask("目标", ["validated_plan"])))).toBe(false);
    expect(isInitialTask(req({ original_goal: "目标", completed_steps: [], observations: [{ kind: "tool" }], instruction }))).toBe(false);
    expect(isInitialTask(req({ original_goal: "目标", instruction: "只处理当前子句，其他子句由宿主合并。" }))).toBe(false);
    expect(isInitialTask(req({ original_goal: "目标", active_clause: "子句", instruction }))).toBe(false);
    expect(isInitialTask(req({ original_goal: "目标", active_clauses: ["子句"], instruction }))).toBe(false);
    expect(isInitialTask(req({ original_goal: "目标", instruction }, { resolvedTargetId: "n1" }))).toBe(false);
    expect(isInitialTask(req(hostTask("目标"), { continuation: { utterance: "目标", question: "还要什么？" } }))).toBe(false);
  });

  it("does not report plans when the host task turn commits nothing", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup(() => ({ clarify: "要计时多久？" }));
    const text = "记个便笺明天交周报，再过五分钟叫我休息";
    const r = await runIntent({ text, canvasContext: context(), taskContext: hostTask(text) }, f.deps);
    expect(r.kind).toBe("clarify");
    expect(r.envelope).toBeUndefined();
    expect(r.trace?.plans).toBeUndefined();
    expect(cards(r)).toHaveLength(0);
  });

  it("does not report plans in off mode even with the host task context", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "off";
    const f = setup();
    const text = "记个便笺明天交周报，再过五分钟叫我休息";
    const r = await runIntent({ text, canvasContext: context(), taskContext: hostTask(text) }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(cards(r).map(card => card.type)).toEqual(["NoteCard", "CountdownCard"]);
    expect(r.trace?.plans).toBeUndefined();
  });

  it("covers three clauses with three cards without any model call when every clause is literal", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup();
    const r = await runIntent({ text: "倒计时50分钟，然后记个便签明天交周报，然后添加待办：买牛奶", canvasContext: context() }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(f.generate).not.toHaveBeenCalled();
    expect(cards(r).map(card => card.type)).toEqual(["CountdownCard", "NoteCard", "TodoCard"]);
    expect(r.trace?.plans?.map(plan => [plan.clause, plan.contract, plan.source])).toEqual([
      [0, "countdown", "rules"], [1, "note", "rules"], [2, "todo", "rules"],
    ]);
    expect(r.trace).toMatchObject({ plannerCalls: 0, directClauses: 3 });
  });

  it("keeps a three-clause sentence ordered when a trailing literal clause follows the model segment", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup();
    const r = await runIntent({ text: "帮我记个便签明天交周报，然后过五分钟叫我休息，再显示全部",
      canvasContext: { ...context(), stage: "STANDBY" } }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.requests[0]!.utterance).toBe("过五分钟叫我休息");
    expect(cards(r).map(card => card.type)).toEqual(["NoteCard", "CountdownCard"]);
    expect(r.envelope!.actions.filter(action => action.type === "canvas.fit")).toHaveLength(1);
    expect(r.envelope!.actions.filter(action => action.type === "stage.awaken")).toHaveLength(1);
    expect(r.trace?.plans?.map(plan => [plan.clause, plan.contract, plan.source])).toEqual([
      [0, "note", "rules"], [1, "countdown", "planner"], [2, "overview", "rules"],
    ]);
    expect(r.trace).toMatchObject({ plannerCalls: 1, directClauses: 2 });
  });

  it("preserves clause order when a literal clause sits between two planned clauses", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup();
    // [planner(0), rule(1), planner(2)]: the old merge hoisted both planned
    // segments to clause 0 and would emit timer, timer, note.
    const r = await runIntent({ text: "过五分钟叫我休息，然后记个便签交周报，再过十分钟叫我喝水", canvasContext: context() }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.requests[0]!.clauses).toEqual(["过五分钟叫我休息", "过十分钟叫我喝水"]);
    const created = cards(r);
    expect(created.map(card => card.type)).toEqual(["CountdownCard", "NoteCard", "CountdownCard"]);
    expect(created[1]!.displayProps).toEqual({ text: "交周报" });
    expect(created.slice(0, 1).concat(created.slice(2)).map(card => seconds(card))).toEqual([300, 600]);
    expect(r.trace?.plans?.map(plan => [plan.clause, plan.contract, plan.source])).toEqual([
      [0, "countdown", "planner"], [1, "note", "rules"], [2, "countdown", "planner"],
    ]);
    expect(r.trace).toMatchObject({ plannerCalls: 1, directClauses: 1 });
  });

  it("keeps a single-card multi-item request as one card with zero planner calls", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup();
    const r = await runIntent({ text: "添加三条待办：买牛奶；交周报；预约体检", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("envelope");
    expect(f.generate).not.toHaveBeenCalled();
    const created = cards(r);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ type: "TodoCard", displayProps: { items: [
      { text: "买牛奶" }, { text: "交周报" }, { text: "预约体检" },
    ] } });
  });
});

describe("hybrid stays atomic when any clause is uncertain", () => {
  it("returns one clarification for the whole sentence and commits no literal proposal", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup(() => ({ clarify: "这两项分别要提醒什么？" }));
    const r = await runIntent({ text: mixed, canvasContext: context() }, f.deps);
    expect(r.kind).toBe("clarify");
    expect(r.envelope).toBeUndefined();
    expect(r.message).toContain("提醒什么");
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("clarifies when the remaining clause never said how long the countdown is", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    // The literal note clause must not be saved while the timer length is invented.
    const f = setup(() => ({ plans: [{ contract: "countdown", clause: 0,
      slots: { seconds: 300, text: "喝水" } }], say: "已设置计时。", text: "已设置 5 分钟计时。" }));
    const r = await runIntent({ text: "帮我记个便签明天交周报，然后设一个倒计时", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("clarify");
    expect(r.envelope).toBeUndefined();
    expect(cards(r)).toHaveLength(0);
    expect(r.message).toContain("多久");
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("rejects a planner segment that drops one active clause instead of saving the others", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup(() => ({ plans: [{ contract: "countdown", clause: 0,
      slots: { seconds: 300, text: "休息" } }], say: "只做了一项。", text: "只做了一项。" }));
    const r = await runIntent({ text: mixed, canvasContext: context() }, f.deps);
    expect(r.kind).toBe("clarify");
    expect(r.envelope).toBeUndefined();
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a duplicate clause", [
      { contract: "countdown", clause: 0, slots: { seconds: 300, text: "休息" } },
      { contract: "countdown", clause: 0, slots: { seconds: 600, text: "喝水" } },
    ]],
    ["an out-of-subset clause", [
      { contract: "countdown", clause: 0, slots: { seconds: 300, text: "休息" } },
      { contract: "countdown", clause: 2, slots: { seconds: 600, text: "喝水" } },
    ]],
    ["an extra plan", [
      { contract: "countdown", clause: 0, slots: { seconds: 300, text: "休息" } },
      { contract: "countdown", clause: 1, slots: { seconds: 600, text: "喝水" } },
      { contract: "note", clause: 1, slots: { text: "多出来的一项" } },
    ]],
  ])("clarifies on %s instead of committing extra or reordered cards", async (_label, plans) => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup(() => ({ plans, say: "已完成。", text: "已完成。" }));
    const r = await runIntent({ text: mixed, canvasContext: context() }, f.deps);
    expect(r.kind).toBe("clarify");
    expect(r.envelope).toBeUndefined();
    expect(cards(r)).toHaveLength(0);
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it("clarifies when a single remaining clause resolves to a search instead of committing the literal segment", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup(() => ({ contract: "search", slots: { kind: "search", query: "明天天气" },
      say: "正在查询。", text: "正在查询明天天气。" }));
    f.deps.search = { webSearch: async () => searchRows };
    const r = await runIntent({ text: "帮我记个便签交周报，然后明天北京天气", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("clarify");
    expect(r.envelope).toBeUndefined();
    expect(cards(r)).toHaveLength(0);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("clarifies when a single remaining clause returns only channels and no card", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup(() => ({ contract: "chat", slots: {}, say: "好的。", text: "好的。" }));
    const r = await runIntent({ text: "帮我记个便签交周报，然后讲个笑话", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("clarify");
    expect(r.envelope).toBeUndefined();
    expect(cards(r)).toHaveLength(0);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("clarifies when the remaining clause resolves to a host operation", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup(() => ({ slots: {}, say: "已撤销。" }));
    const r = await runIntent({ text: "帮我记个便签交周报，然后撤销", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("clarify");
    expect(r.envelope).toBeUndefined();
    expect(r.hostOperation).toBeUndefined();
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("propagates a target clarification instead of guessing the card", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup(() => ({ plans: [{ contract: "focus", clause: 0, slots: {} }], say: "已聚焦。", text: "已聚焦。" }));
    const r = await runIntent({ text: "帮我记个便签交周报，然后聚焦一张卡片", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("clarify");
    expect(r.envelope).toBeUndefined();
    expect(r.message).toContain("哪一张");
    expect(r.targetCandidates?.length).toBeGreaterThan(0);
    expect(r.targetClause).toBe(1);
    expect(f.generate).toHaveBeenCalled();
  });

  it("lets the planner target a card the literal segment just proposed", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup(() => ({ slots: {}, say: "已聚焦。", text: "已聚焦便签。" }));
    const r = await runIntent({ text: "帮我记个便签明天交周报，然后聚焦它", canvasContext: context() }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    const created = cards(r);
    expect(created.map(card => card.type)).toEqual(["NoteCard"]);
    expect(created[0]!.displayProps).toEqual({ text: "明天交周报" });
    // The host re-resolves the target against the proposal, not the stale canvas.
    expect(r.envelope!.actions).toContainEqual({ type: "card.focus", targetId: created[0]!.id });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("clarifies instead of dropping the rule segment when no model can plan the rest", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup();
    f.deps.planner!.connected = false;
    const r = await runIntent({ text: "帮我记个便签明天交周报，然后过五分钟叫我休息", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("clarify");
    expect(r.envelope).toBeUndefined();
    expect(f.generate).not.toHaveBeenCalled();
  });
});

describe("VIVIC_MULTI_CARD_MODE=plans plans the whole sentence once", () => {
  it("does not keep literal clauses local when the plans mode is selected", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "plans";
    const f = setup(({ clauses }) => ({ plans: [
      { contract: "note", clause: 0, slots: { text: "明天交周报" } },
      { contract: "countdown", clause: 1, slots: { seconds: 3000 } },
    ].slice(0, clauses.length), say: "已准备。", text: "已创建便笺和倒计时。" }));
    const r = await runIntent({ text: literal, canvasContext: context() }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(cards(r).map(card => card.type)).toEqual(["NoteCard", "CountdownCard"]);
    expect(r.trace).toMatchObject({ plannerCalls: 1, directClauses: 0 });
    expect(r.trace?.plans?.map(plan => plan.source)).toEqual(["planner", "planner"]);
  });
});

describe("hybrid keeps the existing confirmation, envelope and runtime contracts", () => {
  it("emits one schema-valid envelope with a single camera move and one subtitles channel", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup();
    const r = await runIntent({ text: mixed, canvasContext: context() }, f.deps);
    expect(ActionEnvelopeSchema.safeParse(r.envelope).success).toBe(true);
    const actions = r.envelope!.actions;
    expect(actions.filter(action => action.type === "canvas.fit")).toHaveLength(1);
    expect(actions.filter(action => action.type === "subtitle.show")).toHaveLength(1);
    expect(actions.filter(action => action.type === "card.focus")).toHaveLength(0);
    expect(r.envelope!.actions.length).toBeLessThanOrEqual(12);
    for (const card of cards(r)) expect(CardRecordSchema.safeParse(card).success).toBe(true);
  });

  it("leaves the original canvas context untouched", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const f = setup();
    const ctx = context([{ id: "TEST-pinned", type: "NoteCard", displayProps: { text: "固定" }, sourceDataSummary: {},
      layout: { x: 0, y: 0, width: 800, height: 500, pinned: true } }]);
    const before = structuredClone(ctx);
    const r = await runIntent({ text: mixed, canvasContext: ctx }, f.deps);
    expect(r.kind).toBe("envelope");
    expect(cards(r)[0]!.layout.x).toBeGreaterThanOrEqual(800);
    expect(ctx).toEqual(before);
  });
});

/** `directClauses` is one metric, not a per-mode one: the number of clauses
 * whose actions an approved rule actually built. Hybrid derives it from
 * ruleByClause.size, the per-clause (off/plans) path counts the same thing.
 * A clause the planner had to fill must never be counted. */
describe("directClauses counts the clauses the rules actually built", () => {
  const table: Array<[string, string, number, number, number]> = [
    // label, utterance, off plannerCalls, hybrid plannerCalls, direct clauses
    ["only literal clauses", literal, 0, 0, 2],
    ["one literal clause and two planned", mixed, 2, 1, 1],
    ["literal, planned, literal", "帮我记个便签明天交周报，然后过五分钟叫我休息，再显示全部", 1, 1, 2],
  ];

  it.each(table)("%s reports the same count in both paths", async (_label, text, offCalls, hybridCalls, direct) => {
    delete process.env.VIVIC_MULTI_CARD_MODE;
    const off = await runIntent({ text, canvasContext: context() }, setup().deps);
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    const hybrid = await runIntent({ text, canvasContext: context() }, setup().deps);

    expect(off.trace?.directClauses).toBe(direct);
    expect(hybrid.trace?.directClauses).toBe(direct);
    expect(off.trace?.plannerCalls).toBe(offCalls);
    expect(hybrid.trace?.plannerCalls).toBe(hybridCalls);
    // Every clause is attributed exactly once in hybrid: rules or planner.
    expect(hybrid.trace?.plans?.length).toBe(hybrid.trace?.clauses.length);
    expect(hybrid.trace?.plans?.filter(plan => plan.source === "rules")).toHaveLength(direct);
  });

  it("does not count a rule row whose contract still had to be planned", async () => {
    process.env.VIVIC_MULTI_CARD_MODE = "hybrid";
    // 过五分钟叫我休息 is classified as countdown with .99, but the literal
    // countdown parser rejects it, so it is a planner clause, not a direct one.
    const f = setup();
    const r = await runIntent({ text: "过五分钟叫我休息，然后记个便签交周报", canvasContext: context() }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(r.trace?.directClauses).toBe(1);
    expect(r.trace?.plans?.map(plan => [plan.clause, plan.source])).toEqual([[0, "planner"], [1, "rules"]]);
  });
});
