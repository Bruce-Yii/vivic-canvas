import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema, CardRecordSchema, type Action, type IntentRouteId } from "@vivic/contracts";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type IntentResult, type PipelineDeps } from "../src/intent/pipeline.js";
import type { IntentRouter, RouteResult } from "../src/decision/router.js";
import type { ChatMessage, StepfunResult } from "../src/stepfun.js";
import { demoTravelProvider } from "../src/providers/travel.js";
import type { CanvasContext } from "../src/schemas.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

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
    expect(result.trace?.target).toEqual({ targetId: "TEST-right" });
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
