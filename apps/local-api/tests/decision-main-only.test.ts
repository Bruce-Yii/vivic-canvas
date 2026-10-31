import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema, CardRecordSchema, type IntentRouteId } from "@vivic/contracts";
import { CredentialStore } from "../src/credentials.js";
import { createIntentRouter, parseDecisionPolicy, type IntentRouter } from "../src/decision/router.js";
import { DecisionTaskManager } from "../src/decision/taskV2.js";
import { IntentResponseSchema, type CanvasContext } from "../src/schemas.js";
import { runIntent, type PipelineDeps } from "../src/intent/pipeline.js";
import type { ChatMessage, StepfunResult } from "../src/stepfun.js";
import { chatOk, emptyContext } from "./helpers.js";

const allowed: IntentRouteId[] = ["countdown", "todo", "note", "overview", "restore"];
const context = (cards: CanvasContext["cards"] = []): CanvasContext =>
  ({ canvasId: "TEST-main-only", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards });
const noteCard = (id: string, alias: string) => ({ id, type: "NoteCard" as const, aliases: [alias],
  displayProps: { text: `${alias}正文` }, sourceDataSummary: {}, layout: { x: 0, y: 0, width: 320, height: 120 } });
/** The B-pilot todo: its id is internal and must never be shown to the user. */
const todoCard = (id: string, x: number, y = 0, title?: string) => ({ id, type: "TodoCard" as const,
  aliases: title ? [title] : [],
  displayProps: { ...(title ? { title } : {}), items: [{ id: `${id}-item`, text: "买牛奶", done: false }] },
  sourceDataSummary: {}, layout: { x, y, width: 360, height: 120 } });

/** A router that would fail the test if either 4B call were ever attempted:
 * main-only must not call route or target classification at all. */
function mainOnlyRouter(directRoutes: IntentRouteId[] = allowed) {
  const routeUtterance = vi.fn(async () => { throw new Error("4B route must not be called"); });
  const chooseTarget = vi.fn(async () => { throw new Error("4B target must not be called"); });
  const router: IntentRouter = { mode: "on", policy: "main-only", directRoutes: new Set(directRoutes),
    routeUtterance, chooseTarget };
  return { router, routeUtterance, chooseTarget };
}

interface PlannerInput { utterance: string; clauses: string[]; taskState?: Record<string, unknown> }

function setup(answer: (input: PlannerInput) => unknown) {
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
  const { router, routeUtterance, chooseTarget } = mainOnlyRouter();
  const deps: PipelineDeps = { credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" },
    planner: { provider: "gpt", connected: true, isCurrent: () => true, generate }, router };
  return { deps, router, generate, requests, routeUtterance, chooseTarget };
}

const cards = (result: Awaited<ReturnType<typeof runIntent>>) =>
  result.envelope?.actions.flatMap(action => action.type === "card.create" ? [CardRecordSchema.parse(action.card)] : []) ?? [];

describe("VIVIC_DECISION_POLICY parsing and the main-only router", () => {
  const original = process.env.VIVIC_DECISION_POLICY;
  const originalMode = process.env.VIVIC_DECISION_MODE;
  const originalUrl = process.env.VIVIC_DECISION_URL;
  const originalKey = process.env.VIVIC_DECISION_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.VIVIC_DECISION_POLICY; else process.env.VIVIC_DECISION_POLICY = original;
    if (originalMode === undefined) delete process.env.VIVIC_DECISION_MODE; else process.env.VIVIC_DECISION_MODE = originalMode;
    if (originalUrl === undefined) delete process.env.VIVIC_DECISION_URL; else process.env.VIVIC_DECISION_URL = originalUrl;
    if (originalKey === undefined) delete process.env.VIVIC_DECISION_API_KEY; else process.env.VIVIC_DECISION_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("defaults to full and rejects unknown values instead of enabling a pilot", () => {
    expect(parseDecisionPolicy(undefined)).toBe("full");
    expect(parseDecisionPolicy("")).toBe("full");
    expect(parseDecisionPolicy("full")).toBe("full");
    expect(parseDecisionPolicy("target")).toBe("full");
    expect(parseDecisionPolicy(" MAIN-ONLY ")).toBe("main-only");
  });

  it("main-only never builds or calls the 4B HTTP router", async () => {
    process.env.VIVIC_DECISION_POLICY = "main-only";
    process.env.VIVIC_DECISION_URL = "https://4b.invalid/decisions";
    process.env.VIVIC_DECISION_API_KEY = "TEST-4b-private-key";
    const fetchImpl = vi.fn<typeof fetch>();
    const router = createIntentRouter({ fetchImpl, directRoutes: allowed });
    expect(router).toMatchObject({ mode: "on", policy: "main-only" });
    expect(router.directRoutes).toEqual(new Set(allowed));
    expect(await router.routeUtterance("倒计时50分钟", context())).toBeNull();
    expect(await router.chooseTarget("倒计时50分钟", context(), { a: "b" })).toBeNull();
    expect(router.forDefinitions?.([])?.policy).toBe("main-only");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("full keeps the deployed mode and does not claim the pilot policy", () => {
    delete process.env.VIVIC_DECISION_POLICY;
    process.env.VIVIC_DECISION_MODE = "on";
    const router = createIntentRouter({ fetchImpl: vi.fn<typeof fetch>(), directRoutes: allowed });
    expect(router).toMatchObject({ mode: "on", policy: "full" });
  });

  it("drives a real turn through the factory router, still with no 4B call", async () => {
    process.env.VIVIC_DECISION_POLICY = "main-only";
    const fetchImpl = vi.fn<typeof fetch>();
    const router = createIntentRouter({ fetchImpl, directRoutes: allowed });
    const generate = vi.fn(async (): Promise<StepfunResult<unknown>> =>
      ({ ok: true, value: { contract: "note", slots: { text: "明天交周报" }, say: "记好了。", text: "已记下便笺。" } }));
    const deps: PipelineDeps = { router, credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" },
      planner: { provider: "gpt", connected: true, isCurrent: () => true, generate } };
    const r = await runIntent({ text: "把明天的周报记成便签", canvasContext: context() }, deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(generate).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.trace).toMatchObject({ mode: "on", policy: "main-only" });
  });
});

describe("main-only keeps the rule whitelist first", () => {
  it("executes an approved literal task with zero planner and zero 4B calls", async () => {
    const f = setup(() => ({}));
    const r = await runIntent({ text: "倒计时50分钟", canvasContext: context() }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(r.usedProvider).toBe("rules");
    expect(cards(r).map(card => card.type)).toEqual(["CountdownCard"]);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.routeUtterance).not.toHaveBeenCalled();
    expect(f.chooseTarget).not.toHaveBeenCalled();
    expect(r.trace).toMatchObject({ mode: "on", policy: "main-only", plannerCalls: 0, directClauses: 1 });
    expect(r.trace?.decisions[0]).toMatchObject({ route: "countdown", probability: 1, source: "rules",
      routeSource: "rules", failed: false });
  });

  it("keeps every literal clause local in a multi-clause sentence", async () => {
    const f = setup(() => ({}));
    const r = await runIntent({ text: "帮我记个便签明天交周报，再设个50分钟倒计时", canvasContext: context() }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(cards(r).map(card => card.type)).toEqual(["NoteCard", "CountdownCard"]);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.routeUtterance).not.toHaveBeenCalled();
    expect(r.trace).toMatchObject({ policy: "main-only", plannerCalls: 0, directClauses: 2 });
    expect(r.trace?.plans?.map(plan => [plan.clause, plan.contract, plan.source])).toEqual([
      [0, "note", "rules"], [1, "countdown", "rules"],
    ]);
  });
});

describe("main-only lets the main planner fill contract, actions and slots", () => {
  it("creates a single card from planner slots without a route or target call", async () => {
    const f = setup(() => ({ contract: "note", slots: { text: "明天交周报" }, say: "记好了。", text: "已记下便笺。" }));
    const r = await runIntent({ text: "把明天的周报记成便签", canvasContext: context() }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(cards(r).map(card => [card.type, card.displayProps])).toEqual([["NoteCard", { text: "明天交周报" }]]);
    expect(ActionEnvelopeSchema.safeParse(r.envelope).success).toBe(true);
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.routeUtterance).not.toHaveBeenCalled();
    expect(f.chooseTarget).not.toHaveBeenCalled();
    expect(r.usedProvider).toBe("gpt");
    // Route is honestly unknown; the contract comes from the committed plan.
    expect(r.trace?.decisions[0]).toMatchObject({ route: null, probability: 0, routeSource: "planner", failed: false });
    expect(r.trace?.plans?.map(plan => [plan.clause, plan.contract, plan.source])).toEqual([[0, "note", "planner"]]);
    expect(IntentResponseSchema.safeParse(r).success).toBe(true);
  });

  it("keeps rule clauses local and plans only the rest in ONE call", async () => {
    const f = setup(({ clauses }) => ({ plans: clauses.map((_, index) => ({ contract: "countdown", clause: index,
      slots: { seconds: 300, text: "休息" } })), say: "已设置计时。", text: "计时已开始。" }));
    const text = "帮我记个便签明天交周报，然后过五分钟叫我休息";
    const r = await runIntent({ text, canvasContext: context() }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(cards(r).map(card => card.type)).toEqual(["NoteCard", "CountdownCard"]);
    expect(cards(r)[0]!.displayProps).toEqual({ text: "明天交周报" });
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.requests[0]!.clauses).toEqual(["过五分钟叫我休息"]);
    expect(f.requests[0]!.taskState).toMatchObject({ active_clause_indexes: [1] });
    expect(f.routeUtterance).not.toHaveBeenCalled();
    expect(r.trace?.plans?.map(plan => [plan.clause, plan.contract, plan.source])).toEqual([
      [0, "note", "rules"], [1, "countdown", "planner"],
    ]);
    expect(r.trace).toMatchObject({ policy: "main-only", plannerCalls: 1, directClauses: 1 });
    expect(r.trace?.decisions[1]?.routeSource).toBe("planner");
  });

  it("keeps the same hybrid shape under the production host taskContext", async () => {
    const f = setup(({ clauses }) => ({ plans: clauses.map((_, index) => ({ contract: "countdown", clause: index,
      slots: { seconds: 300, text: "休息" } })), say: "已设置计时。", text: "计时已开始。" }));
    const text = "帮我记个便签明天交周报，然后过五分钟叫我休息";
    const taskContext = { original_goal: text, completed_steps: [], observations: [],
      instruction: "只完成尚未执行的目标，不得重复已成功步骤。" };
    const r = await runIntent({ text, canvasContext: context(), taskContext }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(cards(r).map(card => card.type)).toEqual(["NoteCard", "CountdownCard"]);
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.requests[0]!.clauses).toEqual(["过五分钟叫我休息"]);
    expect(f.routeUtterance).not.toHaveBeenCalled();
    expect(r.trace?.plans?.map(plan => [plan.clause, plan.contract, plan.source])).toEqual([
      [0, "note", "rules"], [1, "countdown", "planner"],
    ]);
  });

  it("resolves an edit target from the canvas words, never from a 4B", async () => {
    const f = setup(() => ({ contract: "edit", slots: { mode: "note", text: "新的正文" }, say: "改好了。", text: "已修改便笺。" }));
    const r = await runIntent({ text: "把读书笔记改成新的正文", canvasContext: context([noteCard("TEST-note", "读书笔记")]) }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(r.envelope!.actions).toContainEqual(expect.objectContaining({ type: "card.update", targetId: "TEST-note" }));
    expect(f.routeUtterance).not.toHaveBeenCalled();
    expect(f.chooseTarget).not.toHaveBeenCalled();
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("clarifies an ambiguous target instead of guessing a card", async () => {
    const f = setup(() => ({ contract: "focus", slots: {}, say: "已聚焦。", text: "已聚焦。" }));
    const r = await runIntent({ text: "聚焦笔记", canvasContext: context([noteCard("TEST-a", "笔记"), noteCard("TEST-b", "笔记")]) }, f.deps);
    expect(r.kind).toBe("clarify");
    expect(r.envelope).toBeUndefined();
    expect(r.message).toContain("哪一张");
    expect(r.targetCandidates?.map(candidate => candidate.id).sort()).toEqual(["TEST-a", "TEST-b"]);
    expect(f.routeUtterance).not.toHaveBeenCalled();
    expect(f.chooseTarget).not.toHaveBeenCalled();
  });

  it("reports a planner failure as an error instead of silently falling back to 4B", async () => {
    const f = setup(() => ({}));
    f.generate.mockResolvedValue({ ok: false, code: "network", error: "网络请求失败" });
    const r = await runIntent({ text: "把明天的周报记成便签", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("error");
    expect(r.envelope).toBeUndefined();
    expect(r.message).toContain("模型暂时不可用");
    expect(f.routeUtterance).not.toHaveBeenCalled();
  });

  it("clarifies when the planner drops a clause instead of committing a partial batch", async () => {
    const f = setup(({ clauses }) => ({ plans: [{ contract: "countdown", clause: 0,
      slots: { seconds: 300, text: "休息" } }].slice(0, Math.min(1, clauses.length)), say: "只做了一项。", text: "只做了一项。" }));
    const r = await runIntent({ text: "过五分钟叫我休息，再过十分钟叫我喝水", canvasContext: context() }, f.deps);
    expect(r.kind).toBe("clarify");
    expect(r.envelope).toBeUndefined();
    expect(cards(r)).toHaveLength(0);
    expect(f.routeUtterance).not.toHaveBeenCalled();
  });
});

describe("main-only keeps provider labels and host safety intact", () => {
  const credential = { apiKey: "TEST-private-key", models: ["deepseek-flash"], defaultModel: "deepseek-flash", checkedAt: "now" };
  const reply = () => vi.fn<typeof fetch>(async () => chatOk({ contract: "note", slots: { text: "明天交周报" },
    say: "记好了。", text: "已记下便笺。" }));
  const request = { text: "把明天的周报记成便签", canvasContext: emptyContext() };

  it("labels the official DeepSeek planner as deepseek", async () => {
    const credentials = new CredentialStore(); credentials.set(credential);
    const { router } = mainOnlyRouter();
    const result = await runIntent(request, { credentials, mainProvider: "deepseek", router,
      stepfun: { baseUrl: "https://api.deepseek.test", provider: "deepseek", fetchImpl: reply() } });
    expect(result).toMatchObject({ kind: "envelope", usedProvider: "deepseek" });
    expect(result.trace?.legacyUsedProvider).toBe("deepseek");
  });

  it("keeps the stepfun label when no deepseek provider is configured", async () => {
    const credentials = new CredentialStore(); credentials.set(credential);
    const { router } = mainOnlyRouter();
    const result = await runIntent(request, { credentials, router,
      stepfun: { baseUrl: "https://unit.test/v1", fetchImpl: reply() } });
    expect(result).toMatchObject({ kind: "envelope", usedProvider: "stepfun" });
    expect(result.trace?.legacyUsedProvider).toBe("stepfun");
  });

  it("still freezes a standalone deletion behind the confirmation question", async () => {
    const f = setup(() => ({ contract: "delete", slots: {}, say: "已选择。", text: "请确认删除。" }));
    const tasks = new DecisionTaskManager();
    const r = await tasks.run({ text: "删除读书笔记", canvasContext: context([noteCard("TEST-note", "读书笔记")]) },
      { legacy: (request, signal) => runIntent(request, f.deps, signal), safetyMode: true });
    expect(r.kind).toBe("clarify");
    expect(r.task?.status).toBe("awaiting_clarification");
    expect(r.message).toContain("确定删除");
    expect(r.message).toContain("读书笔记");
    expect(r.envelope).toBeUndefined();
    expect(f.routeUtterance).not.toHaveBeenCalled();
    // The draft is the main planner's; the host still owns the freeze/confirm step.
    expect(f.generate).toHaveBeenCalledOnce();
  });
});

describe("main-only answers a spatial reference from the layout", () => {
  it("focuses the left todo of two separated cards without a second question or a 4B call", async () => {
    const f = setup(() => ({ contract: "focus", slots: {}, say: "已聚焦。", text: "已聚焦左边的待办。" }));
    const r = await runIntent({ text: "聚焦左边的待办",
      canvasContext: context([todoCard("bpilot-left", 60), todoCard("bpilot-right", 720)]) }, f.deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(r.envelope!.actions).toContainEqual({ type: "card.focus", targetId: "bpilot-left" });
    expect(r.message ?? "").not.toContain("哪一张");
    expect(r.message ?? "").not.toContain("bpilot-");
    expect(f.routeUtterance).not.toHaveBeenCalled();
    expect(f.chooseTarget).not.toHaveBeenCalled();
  });

  it("selects the middle and the rightmost of three separated cards end to end", async () => {
    const three = context([todoCard("bpilot-left", 60), todoCard("bpilot-mid", 440),
      todoCard("bpilot-right", 820)]);
    for (const [text, target] of [["聚焦中间的待办", "bpilot-mid"], ["聚焦最右边的待办", "bpilot-right"]]) {
      const f = setup(() => ({ contract: "focus", slots: {}, say: "已聚焦。", text: "已聚焦。" }));
      const r = await runIntent({ text, canvasContext: three }, f.deps);
      expect(r.kind, JSON.stringify(r)).toBe("envelope");
      expect(r.envelope!.actions).toContainEqual({ type: "card.focus", targetId: target });
      expect(r.message ?? "").not.toContain("哪一张");
      expect(f.chooseTarget).not.toHaveBeenCalled();
    }
  });

  it("asks among two stacked cards with type and position, never the internal id", async () => {
    const f = setup(() => ({ contract: "focus", slots: {}, say: "已聚焦。", text: "已聚焦。" }));
    const r = await runIntent({ text: "聚焦左边的待办",
      canvasContext: context([todoCard("bpilot-left", 60), todoCard("bpilot-right", 60)]) }, f.deps);
    expect(r.kind).toBe("clarify");
    expect(r.envelope).toBeUndefined();
    expect(r.message).toContain("哪一张");
    expect(r.message).toContain("待办");
    expect(r.message).toContain("x=60");
    expect(r.message).not.toContain("bpilot-");
    expect(f.chooseTarget).not.toHaveBeenCalled();
  });

  it("stays safe when the direction names no card on the canvas", async () => {
    const answer = () => ({ contract: "focus", slots: {}, say: "已聚焦。", text: "已聚焦。" });
    for (const cards of [context([]), context([todoCard("bpilot-left", 60)])]) {
      const f = setup(answer);
      const r = await runIntent({ text: "聚焦左边的便签", canvasContext: cards }, f.deps);
      expect(r.kind).toBe("clarify");
      expect(r.envelope).toBeUndefined();
      expect(r.message).toBe("没有找到要操作的卡片，请说明卡名。");
      expect(f.routeUtterance).not.toHaveBeenCalled();
      expect(f.chooseTarget).not.toHaveBeenCalled();
    }
  });
});

describe("full is unchanged", () => {
  it("still classifies a non-literal turn and keeps its route hint", async () => {
    const routeUtterance = vi.fn(async () => ({ route: "countdown" as const, probability: .99,
      probabilities: { countdown: .99 }, none: false, latencyMs: 1 }));
    const router: IntentRouter = { mode: "on", directRoutes: new Set(allowed), routeUtterance,
      chooseTarget: vi.fn(async () => null) };
    const generate = vi.fn(async (): Promise<StepfunResult<unknown>> =>
      ({ ok: true, value: { slots: { seconds: 300, text: "休息" }, say: "已设置。", text: "计时开始。" } }));
    const deps: PipelineDeps = { router, credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" },
      planner: { provider: "gpt", connected: true, isCurrent: () => true, generate } };
    const r = await runIntent({ text: "过五分钟叫我休息", canvasContext: context() }, deps);
    expect(r.kind, JSON.stringify(r)).toBe("envelope");
    expect(routeUtterance).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
    expect(r.trace?.policy).toBeUndefined();
    expect(r.trace?.decisions[0]).toMatchObject({ route: "countdown", source: "decision" });
  });
});
