import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema, CardRecordSchema, type Action, type IntentRouteId } from "@vivic/contracts";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type IntentResult, type PipelineDeps } from "../src/intent/pipeline.js";
import { normalizePlanSlots, relativeYear } from "../src/intent/slotNormalize.js";
import { runSlotPlanner } from "../src/intent/slotPlanner.js";
import { planCache, resetPlanCache } from "../src/intent/planCache.js";
import { COMPACT_PROMPT_PREFIX } from "../src/intent/promptCompact.js";
import type { IntentRouter, RouteResult } from "../src/decision/router.js";
import type { ChatMessage, StepfunResult } from "../src/stepfun.js";
import { demoTravelProvider } from "../src/providers/travel.js";
import type { CanvasContext } from "../src/schemas.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); resetPlanCache(); });

const emptyContext = (cards: CanvasContext["cards"] = []): CanvasContext => ({
  canvasId: "TEST-canvas", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards,
});

const noteText = "帮我保存一张便笺，内容写明明天交周报";
const note = { slots: { text: "明天交周报" }, say: "已记下。", text: "已记下便笺。" };
const answer = { headline: "光合作用", summary: "植物将光能转化为化学能。", keyPoints: ["需要光能", "生成有机物"] };
const mixedText = "帮我记个便签明天交周报，然后设一个五分钟倒计时";
const mixedPlan = { plans: [
  { contract: "note", clause: 0, slots: { text: "明天交周报" } },
  { contract: "countdown", clause: 1, slots: { seconds: 300 } },
], say: "便笺和倒计时已准备好。", text: "已创建便笺和五分钟倒计时。" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

function decision(route: IntentRouteId, probability = .96): RouteResult {
  return { route, probability, probabilities: { [route]: probability }, none: false, latencyMs: 1 };
}

function setup(route: IntentRouteId = "note", outputs: unknown[] = [note]) {
  let index = 0;
  const generate = vi.fn(async (_messages: ChatMessage[], _signal?: AbortSignal): Promise<StepfunResult<unknown>> =>
    ({ ok: true, value: outputs[Math.min(index++, outputs.length - 1)] }));
  const router: IntentRouter = {
    mode: "shadow",
    routeUtterance: vi.fn(async () => decision(route)),
    chooseTarget: vi.fn(async () => null),
  };
  const current = vi.fn(() => true), sessionCurrent = vi.fn(() => true);
  const planner = { provider: "gpt" as const, connected: true, generate, isCurrent: current };
  const onPlannerCall = vi.fn(), onDecisionTrace = vi.fn();
  const unexpectedFetch = vi.fn(async () => { throw new Error("TEST unexpected network call"); });
  const deps: PipelineDeps = { credentials: new CredentialStore(),
    stepfun: { baseUrl: "https://unit.test/v1", fetchImpl: unexpectedFetch },
    planner, router, isSessionCurrent: sessionCurrent, onPlannerCall, onDecisionTrace };
  return { deps, router, generate, current, sessionCurrent, onPlannerCall, onDecisionTrace, unexpectedFetch };
}

function cards(result: IntentResult) {
  return result.envelope?.actions.flatMap(action => action.type === "card.create" ? [CardRecordSchema.parse(action.card)] : []) ?? [];
}

function noExecution(result: IntentResult, kind: "clarify" | "error" = "clarify") {
  expect(result.kind).toBe(kind);
  expect(result.envelope).toBeUndefined();
  expect(result.hostOperation).toBeUndefined();
}

function todoContext() {
  return emptyContext([
    { id: "TEST-left", type: "TodoCard", displayProps: { title: "购物清单", items: [
      { id: "TEST-original", text: "面包", done: false }, { id: "TEST-second", text: "果汁", done: false },
    ] }, sourceDataSummary: {}, layout: { x: 0, y: 0, width: 288, height: 160, pinned: false } },
    { id: "TEST-right", type: "TodoCard", displayProps: { title: "工作清单", items: [
      { id: "TEST-work", text: "交周报", done: false },
    ] }, sourceDataSummary: {}, layout: { x: 500, y: 0, width: 288, height: 160, pinned: false } },
  ]);
}

/** accept20b sc-30 fixture: one todo card whose second item is 买牛奶. */
function accept20bTodoContext() {
  return emptyContext([
    { id: "TEST-week", type: "TodoCard", displayProps: { title: "本周待办", items: [
      { id: "item-1", text: "交周报", done: false }, { id: "item-2", text: "买牛奶", done: false },
      { id: "item-3", text: "预约牙医", done: false },
    ] }, sourceDataSummary: {}, layout: { x: 0, y: 0, width: 288, height: 185, pinned: false } },
  ]);
}

describe("runIntent slot planning with the shared shadow route", () => {
  it("canonicalizes a registered scene label while preserving slots and grounding checks", async () => {
    const f = setup("generate", [{ contract: "option_comparison", slots: { title: "参数对比", options: ["iPhone", "华为"], criteria: [{ name: "尺寸", values: [6.1, 6.7], unit: "寸" }] } }]);
    const r = await runIntent({ text: "做一个表格对比iPhone和华为的参数，用我给的数据：iPhone 6.1寸 华为6.7寸", canvasContext: emptyContext() }, f.deps);
    expect(r.kind).toBe("envelope");
    expect(cards(r).map(card => card.type)).toEqual(["ComparisonCard"]);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it.each(["id", "layout", "metadata"])("rejects %s hidden in registered-scene alias data", async field => {
    const f = setup("generate", [{ contract: "quote_note", slots: { text: "知行合一", [field]: "TEST-injected" } }]);
    noExecution(await runIntent({ text: "制作金句卡：知行合一", canvasContext: emptyContext() }, f.deps));
  });
  it("does not expose unrelated old todo items when filling a new task", async () => {
    const f = setup("todo", [{ slots: { items: ["周五之前缴电费"] } }]);
    const ctx = todoContext();
    const r = await runIntent({ text: "我要记得周五之前缴电费，加到待办里", canvasContext: ctx }, f.deps);
    expect(r.kind).toBe("envelope");
    const payload = JSON.parse(f.generate.mock.calls[0]![0][1]!.content);
    expect(payload.canvas.cards).toEqual([]);
    expect(cards(r)[0]?.displayProps).toMatchObject({ items: [{ text: "周五之前缴电费" }] });
  });
  it("repairs a new todo that drops a user-supplied weekday", async () => {
    const f = setup("todo", [{ slots: { items: ["缴电费"] } }, { slots: { items: ["周五之前缴电费"] } }]);
    const r = await runIntent({ text: "我要记得周五之前缴电费，加到待办里", canvasContext: emptyContext() }, f.deps);
    expect(r.kind).toBe("envelope");
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.generate.mock.calls[1]![0][1]!.content).toContain("missing_requested_weekday");
  });
  it("never saves an invented remaining-day note in place of a date countdown", async () => {
    const f = setup("countdown", [{ contract: "note", slots: { text: "离高考还有220天" } }]);
    const r = await runIntent({ text: "离高考还有多少天，做个倒数", canvasContext: emptyContext() }, f.deps);
    noExecution(r);
  });
  it("keeps an explanation of a date countdown in the answer contract", async () => {
    const f = setup("answer", [{ slots: { headline: "高考倒计时的含义", summary: "按目标考试日期显示剩余时间。" } }]);
    const r = await runIntent({ text: "解释什么叫高考倒计时", canvasContext: emptyContext() }, f.deps);
    expect(r.kind).toBe("envelope");
    expect(cards(r).map(card => card.type)).toEqual(["NewsCard"]);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("offers the note contract for creative generation even when chat ranks second", async () => {
    const f = setup("generate", [{ contract: "note", slots: { bullets: ["晨露", "拂晓", "拾光", "暖杯", "慢巷"] } }]);
    vi.mocked(f.router.routeUtterance).mockResolvedValue({ ...decision("generate"), probabilities: { generate: .96, chat: .03, answer: .01 } });
    const r = await runIntent({ text: "帮我想五个咖啡店的名字", canvasContext: emptyContext() }, f.deps);
    expect(r.kind).toBe("envelope");
    expect(cards(r).map(card => card.type)).toEqual(["NoteCard"]);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("repairs a text-only draft into a stored card for a generation request", async () => {
    const f = setup("generate", [{ text: "团队上季度进步显著。" }, { contract: "note", slots: { text: "团队上季度进步显著。" } }]);
    const r = await runIntent({ text: "把这段话改写得简短一点：我们团队在过去的一个季度中取得了非常显著的进步", canvasContext: emptyContext() }, f.deps);
    expect(r.kind).toBe("envelope");
    expect(cards(r).map(card => card.type)).toEqual(["NoteCard"]);
    expect(f.generate).toHaveBeenCalledTimes(2);
  });
  it("lets the model extract explicit numeric data when the narrow adapter grammar cannot", async () => {
    const f = setup("generate", [{ contract: "generate", slots: { scene_id: "data_visualization", data: { chartKind: "bar", points: [{ x: "一月", y: 10 }, { x: "二月", y: 20 }, { x: "三月", y: 15 }] } } }]);
    f.deps.data = { handleDataIntent: async () => ({ kind: "clarify", message: "表格需要你提供数据。" }) };
    const r = await runIntent({ text: "用这些数字画个柱状图：一月10 二月20 三月15", canvasContext: emptyContext() }, f.deps);
    expect(r.kind).toBe("envelope");
    expect(cards(r).map(card => card.type)).toEqual(["ChartCard"]);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("retains a timer candidate when the independent classifier is unavailable", async () => {
    const f = setup("countdown", [{ contract: "countdown", slots: { seconds: 1500, text: "番茄钟" } }]);
    vi.mocked(f.router.routeUtterance).mockResolvedValue(null);
    const r = await runIntent({ text: "帮我计时25分钟番茄钟", canvasContext: emptyContext() }, f.deps);
    expect(r.kind).toBe("envelope");
    expect(cards(r).map(card => card.type)).toEqual(["CountdownCard"]);
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.generate.mock.calls[0]![0][0]!.content).toContain('"id":"countdown"');
  });
  it("accepts an empty optional timer label without asking the user for an event", async () => {
    const f = setup("countdown", [{ slots: { seconds: 600, text: "" } }]);
    const r = await runIntent({ text: "到计时十分钟", canvasContext: emptyContext() }, f.deps);
    expect(r.kind).toBe("envelope");
    expect(cards(r)[0]?.sourceData).not.toHaveProperty("reminderText");
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("keeps date countdowns in the scene planner rather than requiring duration seconds", async () => {
    const f = setup("countdown", [{ clarify: "请提供考试的目标日期。" }]);
    const r = await runIntent({ text: "离高考还有多少天，做个倒数", canvasContext: emptyContext() }, f.deps);
    noExecution(r);
    expect(f.generate.mock.calls[0]![0][0]!.content).toContain('"id":"generate"');
    expect(f.generate.mock.calls[0]![0][0]!.content).not.toContain("本次契约为 countdown");
  });
  it("builds high-confidence slots and shares one route call with the trace", async () => {
    const f = setup();
    const result = await runIntent({ text: noteText, canvasContext: emptyContext() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(ActionEnvelopeSchema.safeParse(result.envelope).success).toBe(true);
    expect(cards(result)).toHaveLength(1);
    expect(cards(result)[0]).toMatchObject({ type: "NoteCard", displayProps: note.slots });
    expect(result.trace).toMatchObject({ mode: "shadow", status: "complete", route: "note", legacyCardTypes: ["NoteCard"] });
    expect(f.router.routeUtterance).toHaveBeenCalledTimes(1);
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.onPlannerCall).toHaveBeenCalledWith(1);
    expect(f.unexpectedFetch).not.toHaveBeenCalled();
    const system = f.generate.mock.calls[0]![0][0]!.content;
    expect(system).toContain("本次契约为 note");
    expect(system).not.toContain('"id":"answer"');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.onDecisionTrace).toHaveBeenCalledTimes(1);
  });

  it.each(["id", "metadata", "layout"])("rejects injected %s and accepts one repaired slots response", async field => {
    const f = setup("note", [{ ...note, slots: { ...note.slots, [field]: { value: "TEST-model-controlled" } } }, note]);
    const result = await runIntent({ text: noteText, canvasContext: emptyContext() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(cards(result)[0]).toMatchObject({ type: "NoteCard", displayProps: note.slots });
    expect(cards(result)[0]!.metadata).not.toHaveProperty("value");
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.router.routeUtterance).toHaveBeenCalledTimes(1);
    const repair = f.generate.mock.calls[1]![0][1]!.content;
    expect(repair).toContain("上次校验失败");
    expect(repair).toContain("slots");
    expect(repair).not.toContain("TEST-model-controlled");
  });

  it.each(["id", "metadata", "layout"])("refuses repeated %s injections without falling back to record output", async field => {
    const f = setup("note", [{ slots: { ...note.slots, [field]: "TEST-injected" } }]);
    noExecution(await runIntent({ text: noteText, canvasContext: emptyContext() }, f.deps));
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it("reuses the observer's target lookup instead of calling chooseTarget again", async () => {
    const f = setup("focus", [{ slots: {}, say: "已聚焦。" }]);
    vi.mocked(f.router.chooseTarget).mockResolvedValue({ choice: "TEST-right", probability: .97, latencyMs: 1 });
    const result = await runIntent({ text: "请聚焦我要找的那一张", canvasContext: todoContext() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(result.envelope!.actions).toContainEqual({ type: "card.focus", targetId: "TEST-right" });
    expect(f.router.routeUtterance).toHaveBeenCalledTimes(1);
    expect(f.router.chooseTarget).toHaveBeenCalledTimes(1);
    expect(result.trace?.target).toEqual({ targetId: "TEST-right", source: "classifier" });
  });

  it("builds a general knowledge answer as NewsCard without requiring an article", async () => {
    const f = setup("answer", [{ slots: answer, say: "这是光合作用的基本原理。" }]);
    const result = await runIntent({ text: "介绍一下光合作用", canvasContext: emptyContext() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(cards(result)[0]).toMatchObject({ type: "NewsCard", displayProps: { ...answer, summaryBy: "ai" }, sources: [] });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("rejects an answer URL without source evidence, then accepts a repair omitting it", async () => {
    const f = setup("answer", [
      { slots: { ...answer, url: "https://invented.test/unverified" } }, { slots: answer },
    ]);
    const result = await runIntent({ text: "介绍一下光合作用", canvasContext: emptyContext() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(cards(result)[0]!.displayProps).not.toHaveProperty("url");
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.generate.mock.calls[1]![0][1]!.content).toContain("slots.url");
  });

  it("returns atomic clarification if an answer repeatedly invents its source URL", async () => {
    const f = setup("answer", [{ slots: { ...answer, url: "https://invented.test/unverified" } }]);
    noExecution(await runIntent({ text: "介绍一下光合作用", canvasContext: emptyContext() }, f.deps));
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it("preserves an answer URL supplied in the user's source text", async () => {
    const url = "https://example.test/guide";
    const f = setup("answer", [{ slots: { ...answer, url } }]);
    const result = await runIntent({ text: `参考 ${url} 解释光合作用`, canvasContext: emptyContext() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(cards(result)[0]!.displayProps).toMatchObject({ url, summaryBy: "ai" });
  });

  it("gives say-only chat a visible subtitle instead of an empty action envelope", async () => {
    const f = setup("chat", [{ say: "你好，有什么可以帮你的？" }]);
    const result = await runIntent({ text: "和我打个招呼", canvasContext: emptyContext() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(result.envelope!.spokenText).toBe("你好，有什么可以帮你的？");
    expect(result.envelope!.actions).toContainEqual({ type: "subtitle.show", text: "你好，有什么可以帮你的？" });
    expect(cards(result)).toHaveLength(0);
  });

  it("allows a low-confidence route to select a different contract among its top three candidates", async () => {
    const f = setup("note", [{ contract: "todo", slots: { items: ["牛奶", "鸡蛋"] } }]);
    vi.mocked(f.router.routeUtterance).mockResolvedValue({ ...decision("note", .42), probabilities: { note: .42, todo: .35, answer: .23 } });
    const result = await runIntent({ text: "请把牛奶和鸡蛋保存成待办", canvasContext: emptyContext() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)[0]).toMatchObject({ type: "TodoCard", displayProps: { items: [
      { text: "牛奶", done: false }, { text: "鸡蛋", done: false },
    ] } });
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.router.routeUtterance).toHaveBeenCalledTimes(1);
  });

  it("rejects contracts outside the low-confidence top-three candidate set", async () => {
    const f = setup("note", [{ contract: "overview", slots: {} }]);
    vi.mocked(f.router.routeUtterance).mockResolvedValue({ ...decision("note", .42), probabilities: { note: .42, todo: .35, answer: .23 } });
    noExecution(await runIntent({ text: noteText, canvasContext: emptyContext() }, f.deps));
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.generate.mock.calls[1]![0][1]!.content).toContain("invalid_choice");
  });
});

describe("multi-intent slot proposals are complete and atomic", () => {
  it("creates both cards clear of pinned cards, with one awaken and one fit", async () => {
    const f = setup("note", [mixedPlan]);
    const ctx = { ...emptyContext([{ id: "TEST-fixed", type: "NoteCard", displayProps: { text: "固定内容" }, sourceDataSummary: {},
      layout: { x: 0, y: 0, width: 800, height: 500, pinned: true } }]), stage: "STANDBY" as const };
    const before = structuredClone(ctx);
    const result = await runIntent({ text: mixedText, canvasContext: ctx }, f.deps);
    expect(result.kind).toBe("envelope");
    const created = cards(result);
    expect(created.map(card => card.type)).toEqual(["NoteCard", "CountdownCard"]);
    expect(created[0]!.displayProps).toEqual({ text: "明天交周报" });
    expect(created[1]!.sourceData).not.toHaveProperty("reminderText");
    expect(created[0]!.layout.x).toBeGreaterThanOrEqual(800);
    expect(created[1]!.layout.x).toBeGreaterThanOrEqual(created[0]!.layout.x + created[0]!.layout.width);
    expect(result.envelope!.actions.filter(action => action.type === "stage.awaken")).toHaveLength(1);
    expect(result.envelope!.actions.filter(action => action.type === "canvas.fit")).toHaveLength(1);
    expect(result.envelope!.actions.filter(action => action.type === "card.focus")).toHaveLength(0);
    expect(ctx).toEqual(before);
    expect(f.router.routeUtterance).toHaveBeenCalledTimes(2);
  });

  it("lets a clarification override otherwise valid plans without partial execution", async () => {
    const f = setup("note", [{ ...mixedPlan, clarify: "倒计时要持续多久？" }]);
    const result = await runIntent({ text: mixedText, canvasContext: emptyContext() }, f.deps);
    noExecution(result);
    expect(result.message).toBe("倒计时要持续多久？");
  });

  it("rejects a missing clause instead of saving only the first card", async () => {
    const f = setup("note", [{ plans: [mixedPlan.plans[0]] }]);
    noExecution(await runIntent({ text: mixedText, canvasContext: emptyContext() }, f.deps));
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it("rejects a later invalid plan without exposing the earlier valid card", async () => {
    const f = setup("note", [{ plans: [mixedPlan.plans[0], {
      contract: "countdown", clause: 1, slots: { seconds: 300, metadata: { createdAt: "TEST-model-time" } },
    }] }]);
    const ctx = todoContext(), before = structuredClone(ctx);
    noExecution(await runIntent({ text: mixedText, canvasContext: ctx }, f.deps));
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(ctx).toEqual(before);
  });

  it("rejects duplicate clause bindings that leave the second request uncovered", async () => {
    const f = setup("note", [{ plans: mixedPlan.plans.map(entry => ({ ...entry, clause: 0 })) }]);
    noExecution(await runIntent({ text: mixedText, canvasContext: emptyContext() }, f.deps));
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it("does not accept prose claiming success when every requested operation is absent", async () => {
    const f = setup("note", [{ say: "已经记下便笺并设置了倒计时。", text: "便笺和倒计时已完成。" }]);
    noExecution(await runIntent({ text: mixedText, canvasContext: emptyContext() }, f.deps));
  });

  it("checks all reminder items within each clause of a multi-intent request", async () => {
    const f = setup("note", [{ plans: [
      { contract: "note", clause: 0, slots: { text: "交周报" } },
      { contract: "countdown", clause: 1, slots: { seconds: 600, text: "喝水" } },
    ] }]);
    noExecution(await runIntent({ text: "帮我记个便签交周报，然后十分钟后提醒我喝水、吃药", canvasContext: emptyContext() }, f.deps));
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it("keeps both reminder items when one clause legitimately builds multiple cards", async () => {
    const f = setup("note", [{ plans: [
      { contract: "note", clause: 0, slots: { text: "交周报" } },
      { contract: "countdown", clause: 1, slots: { seconds: 600, text: "喝水" } },
      { contract: "countdown", clause: 1, slots: { seconds: 600, text: "吃药" } },
    ] }]);
    const result = await runIntent({ text: "帮我记个便签交周报，然后十分钟后提醒我喝水、吃药", canvasContext: emptyContext() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result).filter(card => card.type === "CountdownCard").map(card => card.sourceData.reminderText)).toEqual(["喝水", "吃药"]);
  });

  it("does not interpret date words in a note as a scheduled reminder in a different clause", async () => {
    const f = setup("note", [{ plans: [
      { contract: "note", clause: 0, slots: { text: "明天交周报" } },
      { contract: "countdown", clause: 1, slots: { seconds: 600, text: "喝水" } },
    ] }]);
    const result = await runIntent({ text: "帮我记个便签明天交周报，然后十分钟后提醒我喝水", canvasContext: emptyContext() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(cards(result).map(card => card.type)).toEqual(["NoteCard", "CountdownCard"]);
  });

  it("carries the first focus into the second clause's item highlight", async () => {
    const f = setup("focus", [{ plans: [
      { contract: "focus", clause: 0, slots: {} }, { contract: "highlight", clause: 1, slots: {} },
    ] }]);
    vi.mocked(f.router.routeUtterance).mockImplementation(async text => decision(text.includes("高亮") ? "highlight" : "focus"));
    const result = await runIntent({ text: "聚焦左边的待办，然后高亮第二条", canvasContext: todoContext() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(result.envelope!.actions).toContainEqual({ type: "card.focus", targetId: "TEST-left" });
    expect(result.envelope!.actions).toContainEqual({ type: "card.highlight", targetId: "TEST-left", itemId: "TEST-second" });
  });

  // accept20b sc-30: the item was named by its own text ("买牛奶那条"), not an
  // ordinal, so the host must resolve item-2 instead of highlighting the card.
  it("highlights the todo item named by its text instead of the whole card", async () => {
    const f = setup("highlight", [{ contract: "highlight", slots: {}, say: "已高亮。", text: "已高亮买牛奶。" }]);
    vi.mocked(f.router.chooseTarget).mockResolvedValue({ choice: "TEST-week", probability: .97, latencyMs: 1 });
    const result = await runIntent({ text: "高亮一下买牛奶那条", canvasContext: accept20bTodoContext() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.envelope!.actions).toContainEqual({ type: "card.highlight", targetId: "TEST-week", itemId: "item-2" });
  });

  it("keeps a card-level highlight when the clause names no item", async () => {
    const f = setup("highlight", [{ contract: "highlight", slots: {}, say: "已高亮。", text: "已高亮。" }]);
    vi.mocked(f.router.chooseTarget).mockResolvedValue({ choice: "TEST-week", probability: .97, latencyMs: 1 });
    const result = await runIntent({ text: "高亮一下本周待办", canvasContext: accept20bTodoContext() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    const highlight = result.envelope!.actions.find((action): action is Extract<Action, { type: "card.highlight" }> =>
      action.type === "card.highlight");
    expect(highlight).toEqual({ type: "card.highlight", targetId: "TEST-week" });
  });

  it("retains the first append when a second edit targets the same todo card", async () => {
    const f = setup("edit", [{ plans: [
      { contract: "edit", clause: 0, slots: { mode: "todo", operation: "append", text: "牛奶" } },
      { contract: "edit", clause: 1, slots: { mode: "todo", operation: "append", text: "鸡蛋" } },
    ] }]);
    const ctx = todoContext(), before = structuredClone(ctx);
    const result = await runIntent({ text: "给购物清单追加牛奶，然后给购物清单追加鸡蛋", canvasContext: ctx }, f.deps);
    expect(result.kind).toBe("envelope");
    const edits = result.envelope!.actions.filter((action): action is Extract<Action, { type: "card.update" }> => action.type === "card.update");
    expect(edits).toHaveLength(2);
    expect(edits.at(-1)!.displayProps!.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "牛奶" }), expect.objectContaining({ text: "鸡蛋" }),
    ]));
    expect(ctx).toEqual(before);
  });

  it("removes a deleted card from subsequent target resolution and placement", async () => {
    const f = setup("delete", [{ plans: [
      { contract: "delete", clause: 0, slots: {} },
      { contract: "note", clause: 1, slots: { text: "交周报" } },
    ] }]);
    const ctx = todoContext(), before = structuredClone(ctx);
    ctx.cards[0]!.layout.pinned = true;
    const result = await runIntent({ text: "删除购物清单，然后帮我记个便签交周报", canvasContext: ctx }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.envelope!.actions).toContainEqual({ type: "card.delete", targetId: "TEST-left" });
    expect(cards(result)[0]!.layout.x).toBe(0);
    expect(ctx).toEqual({ ...before, cards: [{ ...before.cards[0]!, layout: { ...before.cards[0]!.layout, pinned: true } }, before.cards[1]!] });

    const second = setup("delete", [{ plans: [
      { contract: "delete", clause: 0, slots: {} }, { contract: "focus", clause: 1, slots: {} },
    ] }]);
    noExecution(await runIntent({ text: "删除购物清单，然后聚焦购物清单", canvasContext: todoContext() }, second.deps));
  });
});

describe("host normalization only fills what the user's words already fix", () => {
  const today = "2026-10-31";
  const fiveMinutes = { text: "帮我把计时器设成五分钟", today };
  const slots = (value: unknown) => normalizePlanSlots("countdown", { seconds: value }, fiveMinutes);

  it.each([["300", 300], ["5分钟", 300], ["五分钟", 300], [300, 300], ["300.0", 300]])(
    "reads %s as 300 seconds", (_label, value) => {
      expect(slots(value)).toEqual({ slots: { seconds: 300 } });
    });

  it.each(["一会儿", "", "five minutes", -30, 30.5])("asks instead of guessing %s", value => {
    const result = slots(value);
    expect("clarify" in result ? result.clarify : "").toContain("时长");
  });

  it("refuses a duration beyond the contract instead of truncating it", () => {
    const result = normalizePlanSlots("countdown", { seconds: 90_000 }, { text: "帮我倒计时三天", today });
    expect("clarify" in result ? result.clarify : "").toContain("24 小时");
  });

  it("does not accept a duration the user never gave", () => {
    const result = normalizePlanSlots("countdown", { seconds: 300 }, { text: "帮我设一个倒计时", today });
    expect("clarify" in result ? result.clarify : "").toContain("多久");
  });

  it("keeps the one duration the user actually said", () => {
    expect(normalizePlanSlots("countdown", { seconds: 600 }, fiveMinutes)).toEqual({ slots: { seconds: 300 } });
  });

  it.each([["", undefined], [null, undefined], ["   ", undefined], ["https://example.test/a", "https://example.test/a"]])(
    "drops the empty optional url %s", (value, expected) => {
      const result = normalizePlanSlots("answer", { headline: "标题", summary: "摘要", keyPoints: ["要点"], url: value }, fiveMinutes);
      expect("slots" in result && result.slots.url).toBe(expected);
    });

  it.each([
    [{ itemIndex: "1", done: "true" }, { itemIndex: 1, done: true }],
    [{ itemIndex: "0", done: "false" }, { itemIndex: 0, done: false }],
    [{ itemIndex: "2", done: "已完成" }, { itemIndex: 2, done: true }],
    [{ itemIndex: "3", done: "未完成" }, { itemIndex: 3, done: false }],
  ])("coerces the string fields of an edit %o", (values, expected) => {
    expect(normalizePlanSlots("edit", { mode: "todo", operation: "update", ...values }, fiveMinutes))
      .toEqual({ slots: { mode: "todo", operation: "update", ...expected } });
  });

  it("leaves an edit value it cannot read to validation", () => {
    const result = normalizePlanSlots("edit", { mode: "todo", operation: "update", itemIndex: "abc", done: "maybe" }, fiveMinutes);
    expect(result).toEqual({ slots: { mode: "todo", operation: "update", itemIndex: "abc", done: "maybe" } });
  });

  it("reads a relative year against the user's today", () => {
    expect(relativeYear("帮我数着还有多少天到我生日，明年三月十五号", today)).toBe(2027);
    expect(relativeYear("后年三月十五号", today)).toBe(2028);
    expect(relativeYear("今年三月十五号", today)).toBe(2026);
    // An explicit four-digit year is the user's own word: never rewritten.
    expect(relativeYear("2026年3月15日生日倒计时", today)).toBeUndefined();
    expect(relativeYear("明年和今年哪个更近", today)).toBeUndefined();
  });

  it("corrects a date whose year contradicts the relative word", () => {
    const result = normalizePlanSlots("generate", { scene_id: "countdown",
      data: { title: "生日", targetDate: "2026-03-15" } }, { text: "明年三月十五号生日倒计时", today });
    expect(result).toEqual({ slots: { scene_id: "countdown", data: { title: "生日", targetDate: "2027-03-15" } } });
  });

  it("keeps an explicitly written year even when a relative word is also present", () => {
    const payload = { scene_id: "countdown", data: { title: "生日", targetDate: "2026-12-15" } };
    expect(normalizePlanSlots("generate", payload, { text: "2026年12月15日生日倒计时", today })).toEqual({ slots: payload });
  });

  it("asks for a date that has already passed instead of counting backwards", () => {
    const result = normalizePlanSlots("generate", { scene_id: "countdown",
      data: { title: "生日", targetDate: "2026-03-15" } }, { text: "今年三月十五号生日倒计时", today });
    expect("clarify" in result ? result.clarify : "").toContain("过去");
  });

  it("asks when the corrected year has no such day", () => {
    const result = normalizePlanSlots("generate", { scene_id: "countdown",
      data: { title: "生日", targetDate: "2026-02-29" } }, { text: "明年二月二十九号生日倒计时", today });
    expect("clarify" in result ? result.clarify : "").toContain("不存在");
  });
});

describe("a countdown never invents the duration the user omitted", () => {
  it("builds the duration the user said even when the model wrote it as text", async () => {
    const f = setup("countdown", [{ slots: { seconds: "5分钟" } }]);
    const result = await runIntent({ text: "帮我把计时器设成五分钟", canvasContext: emptyContext() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    const [card] = cards(result);
    expect(card).toMatchObject({ type: "CountdownCard" });
    const source = card!.sourceData as { targetAt?: string; startedAt?: string };
    expect(Math.round((Date.parse(String(source.targetAt)) - Date.parse(String(source.startedAt))) / 1000)).toBe(300);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it.each([["一会儿", "时长"], [90_000, "24 小时"]] as const)("clarifies instead of storing the invalid duration %s", async (seconds, hint) => {
    const f = setup("countdown", [{ slots: { seconds } }]);
    const result = await runIntent({ text: "帮我把计时器设成五分钟", canvasContext: emptyContext() }, f.deps);
    noExecution(result);
    expect(result.message).toContain(hint);
    // The host knows the answer is undecidable: no repair round is spent on it.
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("clarifies when the clause carries no duration at all", async () => {
    const f = setup("countdown", [{ slots: { seconds: 300, text: "喝水" } }]);
    const result = await runIntent({ text: "帮我把计时器设一下", canvasContext: emptyContext() }, f.deps);
    noExecution(result);
    expect(result.message).toContain("多久");
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
});

describe("dates and years keep the user's calendar", () => {
  // A fixed clock keeps the relative-word assertions stable.
  const freeze = () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-31T04:00:00.000Z")); };
  const birthday = (targetDate: string) => ({ contract: "countdown",
    slots: { title: "生日", targetDate }, say: "已建好生日倒计时。", text: "已按你说的日期建卡。" });

  it("turns the model's 2026 into the 2027 the user said", async () => {
    freeze();
    const f = setup("countdown", [birthday("2026-03-15")]);
    const result = await runIntent({ text: "帮我数着还有多少天到我生日，明年三月十五号", canvasContext: emptyContext() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)[0]).toMatchObject({ type: "CountdownCard",
      sourceData: { event: { title: "生日", date: "2027-03-15" } } });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("asks instead of building a countdown to a day that already passed", async () => {
    freeze();
    const f = setup("countdown", [birthday("2026-03-15")]);
    const result = await runIntent({ text: "帮我数着到生日还有多少天，今年三月十五号", canvasContext: emptyContext() }, f.deps);
    noExecution(result);
    expect(result.message).toContain("过去");
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
});

describe("edits read the string fields the model sends", () => {
  const oneTodo = () => emptyContext([{ id: "TEST-todo", type: "TodoCard",
    displayProps: { title: "购物清单", items: [{ id: "TEST-a", text: "预约牙医", done: false }, { id: "TEST-b", text: "买牛奶", done: false }] },
    sourceDataSummary: {}, layout: { x: 0, y: 0, width: 288, height: 160, pinned: false } }]);

  it("marks the addressed item done without a repair round", async () => {
    const f = setup("edit", [{ slots: { mode: "todo", operation: "update", itemIndex: "0", done: "true" } }]);
    const result = await runIntent({ text: "把待办里预约牙医那条标记完成", canvasContext: oneTodo() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    const update = result.envelope!.actions.find((action): action is Extract<Action, { type: "card.update" }> => action.type === "card.update");
    expect(update?.displayProps?.items).toEqual([
      expect.objectContaining({ text: "预约牙医", done: true }), expect.objectContaining({ text: "买牛奶", done: false }),
    ]);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it("does not guess an unreadable item index", async () => {
    const f = setup("edit", [{ slots: { mode: "todo", operation: "update", itemIndex: "第二条", done: "true" } }]);
    noExecution(await runIntent({ text: "把待办里预约牙医那条标记完成", canvasContext: oneTodo() }, f.deps));
    expect(f.generate).toHaveBeenCalledTimes(2);
  });
});

describe("an empty optional answer url is dropped, not repaired", () => {
  it("saves the answer card on the first attempt", async () => {
    const f = setup("answer", [{ slots: { ...answer, url: "" }, say: "这是光合作用的基本原理。" }]);
    const result = await runIntent({ text: "介绍一下光合作用", canvasContext: emptyContext() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)[0]!.displayProps).not.toHaveProperty("url");
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
});

describe("connection changes and cancellation reject stale slot results", () => {
  it.each(["model", "session"] as const)("rejects a %s connection change while the planner is running", async which => {
    const f = setup(), entered = deferred<void>(), release = deferred<void>();
    f.generate.mockImplementation(async () => { entered.resolve(); await release.promise; return { ok: true, value: note }; });
    const pending = runIntent({ text: noteText, canvasContext: emptyContext() }, f.deps);
    await entered.promise;
    (which === "model" ? f.current : f.sessionCurrent).mockReturnValue(false);
    release.resolve();
    const result = await pending;
    noExecution(result, "error");
    expect(result.message).toContain("连接已变更");
  });

  it("rejects a completed planner response when the request was cancelled", async () => {
    const f = setup(), entered = deferred<void>(), release = deferred<void>(), controller = new AbortController();
    f.generate.mockImplementation(async () => { entered.resolve(); await release.promise; return { ok: true, value: note }; });
    const pending = runIntent({ text: noteText, canvasContext: emptyContext() }, f.deps, controller.signal);
    await entered.promise;
    controller.abort(new Error("TEST-private-abort-reason"));
    release.resolve();
    const result = await pending;
    noExecution(result, "error");
    expect(JSON.stringify(result)).not.toContain("TEST-private-abort-reason");
  });

  it("returns cancellation without waiting for a router that ignores AbortSignal", async () => {
    vi.useFakeTimers();
    const f = setup(), entered = deferred<void>(), route = deferred<RouteResult>(), controller = new AbortController();
    vi.mocked(f.router.routeUtterance).mockImplementation(async () => { entered.resolve(); return route.promise; });
    let settled = false;
    const pending = runIntent({ text: noteText, canvasContext: emptyContext() }, f.deps, controller.signal).then(value => { settled = true; return value; });
    await entered.promise;
    controller.abort();
    try {
      await vi.advanceTimersByTimeAsync(300);
      expect(settled).toBe(true);
    } finally {
      route.resolve(decision("note"));
      noExecution(await pending, "error");
    }
  });

  it("discards cards when the model connection changes during asynchronous scene building", async () => {
    const f = setup("generate", [{ contract: "generate", slots: { scene_id: "travel_offers", data: { kind: "poi", destination: "上海" } } }]);
    const entered = deferred<void>(), release = deferred<void>();
    f.deps.travel = { query: async (query, signal) => { entered.resolve(); await release.promise; return demoTravelProvider.query(query, signal); } };
    const pending = runIntent({ text: "旅游卡：查询上海的景点", canvasContext: emptyContext() }, f.deps);
    await Promise.race([entered.promise, pending.then(result => { throw new Error(`Provider was not entered: ${JSON.stringify(result)}`); })]);
    f.current.mockReturnValue(false);
    release.resolve();
    expect(f.generate).toHaveBeenCalledTimes(1);
    noExecution(await pending, "error");
  });
});

describe("generate fallback preserves business slots validation", () => {
  const quote = (text: string) => ({ scene_id: "quote_note", data: { text } });

  it("falls back once after one repair and builds scene cards with safe layouts", async () => {
    const f = setup("generate", [{ slots: {} }, { slots: {} }, {
      cards: [quote("知行合一"), quote("温故知新")], say: "已整理两张金句卡。", text: "已保存两条金句。",
    }]);
    const ctx = { ...emptyContext([{ id: "TEST-fixed", type: "NoteCard", displayProps: { text: "固定内容" }, sourceDataSummary: {},
      layout: { x: 0, y: 0, width: 800, height: 500, pinned: true } }]), stage: "STANDBY" as const };
    const before = structuredClone(ctx);
    const result = await runIntent({ text: "制作金句卡：知行合一与温故知新", canvasContext: ctx }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(f.generate).toHaveBeenCalledTimes(3);
    expect(f.onPlannerCall.mock.calls.map(call => call[0])).toEqual([1, 2, 3]);
    expect(f.router.routeUtterance).toHaveBeenCalledTimes(1);
    const created = cards(result);
    expect(created.map(card => card.type)).toEqual(["QuoteCard", "QuoteCard"]);
    expect(created[0]!.layout.x).toBeGreaterThanOrEqual(800);
    expect(created[1]!.layout.x).toBeGreaterThanOrEqual(created[0]!.layout.x + created[0]!.layout.width);
    expect(result.envelope!.actions.filter(action => action.type === "canvas.fit")).toHaveLength(1);
    expect(result.envelope!.actions.filter(action => action.type === "stage.awaken")).toHaveLength(1);
    expect(ctx).toEqual(before);
  });

  it.each(["id", "layout", "metadata"])("cannot bypass scene data validation with %s in the fallback", async field => {
    const f = setup("generate", [{ slots: {} }, { slots: {} }, {
      cards: [{ scene_id: "quote_note", data: { text: "知行合一", [field]: "TEST-model-owned" } }],
    }]);
    noExecution(await runIntent({ text: "制作金句卡：知行合一", canvasContext: emptyContext() }, f.deps));
    expect(f.generate).toHaveBeenCalledTimes(3);
  });

  it("does not accept raw actions through the compatibility fallback", async () => {
    const f = setup("generate", [{ slots: {} }, { slots: {} }, { actions: [{ type: "canvas.fit" }] }]);
    noExecution(await runIntent({ text: "制作金句卡：知行合一", canvasContext: emptyContext() }, f.deps));
    expect(f.generate).toHaveBeenCalledTimes(3);
  });

  it.each(["cancellation", "model-change"] as const)("rejects %s during the third-call fallback", async reason => {
    const f = setup("generate"), entered = deferred<void>(), release = deferred<void>(), controller = new AbortController();
    let attempt = 0;
    f.generate.mockImplementation(async () => {
      if (++attempt < 3) return { ok: true, value: { slots: {} } };
      entered.resolve(); await release.promise;
      return { ok: true, value: { cards: [quote("知行合一")] } };
    });
    const pending = runIntent({ text: "制作金句卡：知行合一", canvasContext: emptyContext() }, f.deps, controller.signal);
    await Promise.race([entered.promise, pending.then(result => { throw new Error(`Fallback was not entered: ${JSON.stringify(result)}`); })]);
    if (reason === "cancellation") controller.abort();
    else f.current.mockReturnValue(false);
    release.resolve();
    noExecution(await pending, "error");
    expect(f.generate).toHaveBeenCalledTimes(3);
  });
});

function capturedPrompt(f: ReturnType<typeof setup>) {
  const messages = f.generate.mock.calls.at(-1)![0];
  return { system: messages[0]!.content, user: messages[1]!.content,
    payload: JSON.parse(messages[1]!.content) as { canvas: { cards: Array<Record<string, unknown>> } } };
}

const targetCard = (): CanvasContext["cards"][number] => ({
  id: "TEST-google", type: "NewsCard",
  displayProps: { headline: "Google 公司介绍", summary: "谷歌总部位于美国加州山景城，1998 年由佩奇和布林创立。",
    keyPoints: ["总部山景城", "1998 年创立"] },
  sourceDataSummary: {}, layout: { x: 0, y: 0, width: 640, height: 480 },
});

describe("compact planner prompt (VIVIC_COMPACT_PROMPT)", () => {
  it("is off by default and keeps today's full prompt and canvas", async () => {
    const f = setup("note", [mixedPlan]);
    const ctx = todoContext();
    await runIntent({ text: mixedText, canvasContext: ctx }, f.deps);
    const { system, payload } = capturedPrompt(f);
    expect(system).toContain("photo_memory");
    expect((system.match(/"id":/g) ?? []).length).toBeGreaterThan(3);
    expect(payload.canvas.cards[0]!.layout).toMatchObject({ x: 0, y: 0, width: 288 });
  });

  it("sends at most three contracts over a stable prefix and keeps plans/clause", async () => {
    vi.stubEnv("VIVIC_COMPACT_PROMPT", "on");
    const f = setup("note", [mixedPlan]);
    const result = await runIntent({ text: mixedText, canvasContext: emptyContext() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(cards(result).map(card => card.type)).toEqual(["NoteCard", "CountdownCard"]);
    const { system } = capturedPrompt(f);
    expect(system.startsWith(COMPACT_PROMPT_PREFIX)).toBe(true);
    expect(system).toContain('"plans"');
    expect(system).toContain("clause");
    expect((system.match(/"id":/g) ?? []).length).toBeLessThanOrEqual(3);
    expect(system).toContain('"id":"note"');
    expect(system).toContain('"id":"countdown"');
  });

  it("cuts the planner prompt size on a multi-clause turn", async () => {
    const full = setup("note", [mixedPlan]);
    await runIntent({ text: mixedText, canvasContext: emptyContext() }, full.deps);
    const fullSystem = capturedPrompt(full).system;
    vi.stubEnv("VIVIC_COMPACT_PROMPT", "on");
    const compact = setup("note", [mixedPlan]);
    await runIntent({ text: mixedText, canvasContext: emptyContext() }, compact.deps);
    const compactSystem = capturedPrompt(compact).system;
    expect(compactSystem.length).toBeLessThan(fullSystem.length * 0.5);
  });

  it("keeps the target card title and body for an answer about that card", async () => {
    vi.stubEnv("VIVIC_COMPACT_PROMPT", "on");
    const f = setup("answer", [{ slots: { headline: "Google 公司介绍", summary: "谷歌总部位于山景城，1998 年创立。",
      keyPoints: ["总部山景城", "1998 年创立"] } }]);
    const ctx = emptyContext([targetCard()]);
    ctx.selectedCardIds = ["TEST-google"];
    const result = await runIntent({ text: "这张卡讲了什么？", canvasContext: ctx }, f.deps);
    expect(result.kind).toBe("envelope");
    const { payload } = capturedPrompt(f);
    const target = payload.canvas.cards.find(card => card.id === "TEST-google")!;
    expect((target.displayProps as Record<string, unknown>).headline).toBe("Google 公司介绍");
    expect((target.displayProps as Record<string, unknown>).summary).toContain("山景城");
    expect((target.displayProps as Record<string, unknown>).keyPoints).toContain("1998 年创立");
  });

  it("keeps the confusable travel/schedule scenes and drops unrelated rows", async () => {
    vi.stubEnv("VIVIC_COMPACT_PROMPT", "on");
    const f = setup("generate", [{ clarify: "请问是几月几号出发？" }]);
    const result = await runIntent({ text: "帮我规划一个成都三天旅行行程", canvasContext: emptyContext() }, f.deps);
    expect(result.kind).toBe("clarify");
    const { system } = capturedPrompt(f);
    expect(system).toContain("travel_offers");
    expect(system).toContain("weekly_schedule");
    expect(system).toContain("project_roadmap");
    expect(system).not.toContain("photo_memory");
    expect((system.match(/data结构=/g) ?? []).length).toBeLessThanOrEqual(3);
  });

  it("keeps edit mode/operation enumerations and still updates the card", async () => {
    vi.stubEnv("VIVIC_COMPACT_PROMPT", "on");
    const f = setup("edit", [{ contract: "edit", slots: { mode: "todo", operation: "update", itemIndex: 0, text: "交周报", done: true } }]);
    const result = await runIntent({ text: "把工作清单里的交周报勾掉", canvasContext: todoContext() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(result.envelope!.actions.some(action => action.type === "card.update")).toBe(true);
    const { system } = capturedPrompt(f);
    expect(system).toContain('"operation"');
    expect(system).toContain('"append"');
    expect(system).toContain('"pause"');
    expect(system).toContain('"resume"');
  });

  it("still builds a grounded scene card with only the relevant guide", async () => {
    vi.stubEnv("VIVIC_COMPACT_PROMPT", "on");
    const f = setup("generate", [{ contract: "generate", slots: { scene_id: "data_visualization",
      data: { chartKind: "bar", points: [{ x: "一月", y: 10 }, { x: "二月", y: 20 }, { x: "三月", y: 15 }] } } }]);
    const result = await runIntent({ text: "用这些数字画个柱状图：一月10 二月20 三月15", canvasContext: emptyContext() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(cards(result).map(card => card.type)).toEqual(["ChartCard"]);
    const { system } = capturedPrompt(f);
    expect(system).toContain("data_visualization");
    expect(system).toContain("option_comparison");
    expect(system).not.toContain("photo_memory");
  });
});

describe("local plan cache (VIVIC_PLAN_CACHE)", () => {
  const cachedNoteText = "帮我记一下明天交周报";

  it("is off by default, so every request reaches the model", async () => {
    const f = setup("note", [note]);
    await runIntent({ text: noteText, canvasContext: emptyContext() }, f.deps);
    await runIntent({ text: noteText, canvasContext: emptyContext() }, f.deps);
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(planCache.size).toBe(0);
  });

  it("replays parsed plans without a second model call and rebuilds the card", async () => {
    vi.stubEnv("VIVIC_PLAN_CACHE", "on");
    const f = setup("note", [note]);
    const first = await runIntent({ text: cachedNoteText, canvasContext: emptyContext() }, f.deps);
    const second = await runIntent({ text: cachedNoteText, canvasContext: emptyContext() }, f.deps);
    expect(first.kind).toBe("envelope");
    expect(second.kind).toBe("envelope");
    expect(f.generate).toHaveBeenCalledTimes(1);
    // The host still executes: a fresh card is built from the cached slots.
    expect(cards(second).map(card => card.type)).toEqual(["NoteCard"]);
    expect(cards(second)[0]!.id).not.toBe(cards(first)[0]!.id);
    expect(cards(second)[0]!.displayProps).toEqual({ text: "明天交周报" });
  });

  it("misses when the canvas changes", async () => {
    vi.stubEnv("VIVIC_PLAN_CACHE", "on");
    const f = setup("note", [note]);
    const first = await runIntent({ text: cachedNoteText, canvasContext: emptyContext() }, f.deps);
    const second = await runIntent({ text: cachedNoteText,
      canvasContext: emptyContext([{ id: "TEST-other", type: "NoteCard", displayProps: { text: "旧卡" }, sourceDataSummary: {},
        layout: { x: 0, y: 0, width: 320, height: 120 } }]) }, f.deps);
    expect(first.kind).toBe("envelope");
    expect(second.kind).toBe("envelope");
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it("misses when the model changes", async () => {
    vi.stubEnv("VIVIC_PLAN_CACHE", "on");
    const run = (model: string) => {
      const generate = vi.fn(async () => ({ ok: true as const, value: note }));
      const deps = { definitions: [], usedProvider: "stepfun" as const, model,
        hint: Promise.resolve({ result: decision("note"), target: Promise.resolve(undefined) }),
        generate, isCurrent: () => true, lookup: async () => ({ kind: "error" as const, message: "TEST lookup forbidden" }) };
      return { deps, generate };
    };
    const first = run("deepseek-flash"), second = run("step-3.7-flash");
    expect((await runSlotPlanner({ text: cachedNoteText, canvasContext: emptyContext() }, first.deps)).kind).toBe("envelope");
    expect((await runSlotPlanner({ text: cachedNoteText, canvasContext: emptyContext() }, second.deps)).kind).toBe("envelope");
    expect(first.generate).toHaveBeenCalledTimes(1);
    expect(second.generate).toHaveBeenCalledTimes(1);
  });

  it("does not share a cache entry between compact and full prompts", async () => {
    vi.stubEnv("VIVIC_PLAN_CACHE", "on");
    const f = setup("note", [note]);
    vi.stubEnv("VIVIC_COMPACT_PROMPT", "on");
    await runIntent({ text: cachedNoteText, canvasContext: emptyContext() }, f.deps);
    vi.stubEnv("VIVIC_COMPACT_PROMPT", "off");
    await runIntent({ text: cachedNoteText, canvasContext: emptyContext() }, f.deps);
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it("does not cache per-turn evidence and writes no card text to logs", async () => {
    vi.stubEnv("VIVIC_PLAN_CACHE", "on");
    const info = vi.spyOn(console, "info"), log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn"), error = vi.spyOn(console, "error");
    const f = setup("note", [note]);
    await runIntent({ text: cachedNoteText, canvasContext: emptyContext() }, f.deps);
    await runIntent({ text: cachedNoteText, canvasContext: emptyContext() }, f.deps);
    expect(f.generate).toHaveBeenCalledTimes(1);
    for (const spy of [info, log, warn, error]) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain("周报");
    }
    // Only parsed plans/slots and the two subtitle channels are stored.
    expect(planCache.size).toBe(1);
  });
});
