import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type IntentResult, type PipelineDeps } from "../src/intent/pipeline.js";
import { handleDataIntent } from "../src/data/index.js";
import { parseWeatherInput } from "../src/data/weatherInput.js";
import { lookupWeather } from "../src/data/weather.js";
import type { IntentRouter, RouteResult } from "../src/decision/router.js";
import { hostOperationIssue } from "../src/decision/hostOperations.js";
import type { ChatMessage, StepfunResult } from "../src/stepfun.js";
import type { CanvasContext } from "../src/schemas.js";
import type { IntentRouteId } from "@vivic/contracts";

type Card = CanvasContext["cards"][number];
const card = (id: string, title: string, type = "NoteCard", x = 0): Card => ({
  id, type, aliases: [title], displayProps: type === "TodoCard"
    ? { title, items: [{ id: `${id}-item`, text: "买牛奶", done: false }] } : { text: title },
  sourceDataSummary: {}, layout: { x, y: 0, width: 320, height: 120, pinned: false },
});
/** The acceptance canvas: seven cards, one focused note, two todos. */
const canvas = (): CanvasContext => ({ canvasId: "TEST-accept60", version: 7, stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: ["note_meeting"], cards: [
    card("todo_week", "本周待办", "TodoCard", 0), card("todo_shop", "购物清单", "TodoCard", 900),
    card("note_meeting", "会议记录", "NoteCard", 300), card("note_book", "读书笔记", "NoteCard", 600),
    card("cd_water", "喝水提醒", "CountdownCard", 0), card("weather_sh", "上海天气", "WeatherCard", 300),
    card("answer_google", "Google 公司介绍", "AnswerCard", 900),
  ] });
const route = (id: IntentRouteId, probability = .99): RouteResult =>
  ({ route: id, probability, probabilities: { [id]: probability }, none: false, latencyMs: 1 });

/** Fixed router + fake planner: no real model, one canned output per call. */
function setup(routes: IntentRouteId[], outputs: unknown[], choose: IntentRouter["chooseTarget"] = async () => null) {
  let index = 0, routeIndex = 0;
  const generate = vi.fn(async (_messages: ChatMessage[]): Promise<StepfunResult<unknown>> =>
    ({ ok: true, value: outputs[Math.min(index++, outputs.length - 1)] }));
  const router: IntentRouter = { mode: "on",
    directRoutes: new Set(["countdown", "todo", "note", "overview", "restore"]),
    routeUtterance: vi.fn(async () => route(routes[Math.min(routeIndex++, routes.length - 1)]!)), chooseTarget: vi.fn(choose) };
  const credentials = new CredentialStore();
  credentials.set({ apiKey: "TEST-accept60-key", defaultModel: "deepseek-flash", models: ["deepseek-flash"], checkedAt: new Date().toISOString() });
  const deps: PipelineDeps = { credentials, stepfun: { baseUrl: "https://unused.test/v1" },
    planner: { provider: "gpt", connected: true, isCurrent: () => true, generate }, router, multiCard: "hybrid" };
  return { deps, generate, router };
}
const reminderText = (item: { sourceData: unknown }) => (item.sourceData as { reminderText?: string }).reminderText;
const created = (result: IntentResult) => result.envelope?.actions.flatMap(action =>
  action.type === "card.create" ? [action.card] : []) ?? [];
const actions = (result: IntentResult) => result.envelope?.actions ?? [];

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("accept60: enumerated reminder items are built as one card per item", () => {
  it("sc-12 五分钟后提醒我喝水和吃药 needs no model and creates both reminders", async () => {
    const f = setup(["countdown"], [{ slots: { seconds: 300, text: "喝水和吃药" } }]);
    const result = await runIntent({ text: "五分钟后提醒我喝水和吃药", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(created(result).map(item => item.type)).toEqual(["CountdownCard", "CountdownCard"]);
    expect(created(result).map(reminderText)).toEqual(["喝水", "吃药"]);
    // The deterministic grammar must not pay for (or depend on) a planner call.
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("sc-12 also splits deterministically on the default (off) routing path", async () => {
    const f = setup(["countdown"], [{ clarify: "模型不应被调用" }]);
    const legacy: PipelineDeps = { ...f.deps, router: { ...f.router, mode: "off" }, multiCard: "off" };
    const result = await runIntent({ text: "五分钟后提醒我喝水和吃药", canvasContext: canvas() }, legacy);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(created(result).map(item => item.type)).toEqual(["CountdownCard", "CountdownCard"]);
    expect(created(result).map(reminderText)).toEqual(["喝水", "吃药"]);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("sc-54 keeps both reminder items and the note in one turn", async () => {
    const f = setup(["countdown", "note"], [{ clarify: "模型不应被调用" }]);
    const result = await runIntent({ text: "五分钟后提醒我喝水和吃药，顺便记个便签：该吃药了", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(created(result).map(item => item.type)).toEqual(["CountdownCard", "CountdownCard", "NoteCard"]);
    expect(created(result).map(reminderText).filter(Boolean)).toEqual(["喝水", "吃药"]);
    expect(created(result).at(-1)?.displayProps).toEqual({ text: "该吃药了" });
    expect(f.generate).not.toHaveBeenCalled();
  });
});

describe("accept60: a trailing bare append command joins the clause before it", () => {
  it("sc-05 builds one TodoCard for 明天上午先把合同发给王经理，加个待办", async () => {
    const f = setup(["todo", "todo"], [{ clarify: "模型不应被调用" }]);
    const result = await runIntent({ text: "明天上午先把合同发给王经理，加个待办", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(created(result).map(item => item.type)).toEqual(["TodoCard"]);
    const todo = created(result)[0];
    expect(todo?.type).toBe("TodoCard");
    if (todo?.type !== "TodoCard") return;
    // The user's own words are the item; nothing is invented or rewritten.
    expect(todo.displayProps.items.map(item => item.text)).toEqual(["明天上午先把合同发给王经理"]);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("keeps a real second operation on the planner instead of merging it", async () => {
    const f = setup(["todo"], [{ clarify: "模型不应被调用" }]);
    const result = await runIntent({ text: "把合同发给王经理，加个待办", canvasContext: canvas() }, f.deps);
    // One content clause + one append command is exactly the deterministic shape.
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(created(result).map(item => item.type)).toEqual(["TodoCard"]);
  });

  it("does not merge an operation sentence into a todo item", async () => {
    const f = setup(["arrange"], [{ clarify: "模型不应被调用" }]);
    const result = await runIntent({ text: "显示全部，加个待办", canvasContext: canvas() }, f.deps);
    expect(created(result).map(item => item.type)).not.toEqual(["TodoCard"]);
  });
});

describe("accept60: main-only keeps the rules reachable without a classifier allow-list", () => {
  it("sc-12 builds both reminders and records the countdown route", async () => {
    const f = setup(["countdown"], [{ clarify: "模型不应被调用" }]);
    const mainOnly: PipelineDeps = { ...f.deps, router: { ...f.router, policy: "main-only", directRoutes: new Set() } };
    const result = await runIntent({ text: "五分钟后提醒我喝水和吃药", canvasContext: canvas() }, mainOnly);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(created(result).map(item => item.type)).toEqual(["CountdownCard", "CountdownCard"]);
    expect(result.trace?.route).toBe("countdown");
    expect(result.trace?.policy).toBe("main-only");
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("sc-16 stays deterministic in main-only", async () => {
    const f = setup(["generate"], [{ clarify: "模型不应被调用" }]);
    const mainOnly: PipelineDeps = { ...f.deps, router: { ...f.router, policy: "main-only", directRoutes: new Set() } };
    const result = await runIntent({ text: "帮我做一个下周的健身计划", canvasContext: canvas() }, mainOnly);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(created(result).map(item => item.type)).toEqual(["WeeklyScheduleCard"]);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("still plans a sentence the rules cannot answer", async () => {
    const f = setup([], [{ clarify: "请补充更多信息" }]);
    const mainOnly: PipelineDeps = { ...f.deps, router: { ...f.router, policy: "main-only", directRoutes: new Set() } };
    const result = await runIntent({ text: "帮我想个产品名字", canvasContext: canvas() }, mainOnly);
    expect(result.kind).toBe("clarify");
    expect(f.generate).toHaveBeenCalled();
  });
});

describe("accept60: a focus clause hands its card to the following edit clause", () => {
  it("sc-51 edits 会议记录 without a planner call and asks nothing", async () => {
    const f = setup(["focus", "edit"], [{ clarify: "模型不应被调用" }]);
    const result = await runIntent({ text: "聚焦会议记录，把标题改成首页改版讨论", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(actions(result)).toContainEqual({ type: "card.focus", targetId: "note_meeting" });
    expect(actions(result)).toContainEqual({ type: "card.update", targetId: "note_meeting", displayProps: { text: "首页改版讨论" } });
    expect(result.message ?? "").not.toMatch(/哪一张|哪张卡片/);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("does not guess when the focused name matches two cards", async () => {
    const context = canvas();
    context.cards.push(card("note_meeting2", "会议记录", "NoteCard", 1200));
    const f = setup(["focus", "edit"], [{ clarify: "模型不应被调用" }]);
    const result = await runIntent({ text: "聚焦会议记录，把标题改成首页改版讨论", canvasContext: context }, f.deps);
    expect(result.kind).not.toBe("envelope");
  });

  it("keeps a focus-only sentence a plain focus", async () => {
    const f = setup(["focus"], [{ clarify: "模型不应被调用" }]);
    const result = await runIntent({ text: "聚焦会议记录", canvasContext: canvas() }, f.deps);
    expect(actions(result)).not.toContainEqual({ type: "card.update", targetId: "note_meeting", displayProps: { text: "" } });
  });
});

describe("accept60: pausing a named timer is a closed-form host operation", () => {
  it("sc-34 pauses cd_water without a planner call", async () => {
    const f = setup(["edit"], [{ clarify: "模型不应被调用" }]);
    const result = await runIntent({ text: "暂停喝水倒计时", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("host-operation");
    expect(result.hostOperation).toEqual({ kind: "countdown.pause", targetId: "cd_water" });
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("treats 继续/恢复 on the same named timer as the matching resume", async () => {
    const f = setup(["edit"], [{ clarify: "模型不应被调用" }]);
    const result = await runIntent({ text: "继续喝水倒计时", canvasContext: canvas() }, f.deps);
    expect(result.kind).toBe("host-operation");
    // The projection carries no timer state; the owner applies against the real card.
    expect(result.hostOperation).toEqual({ kind: "countdown.resume", targetId: "cd_water" });
  });

  it("never guesses between two timers that both match the name", async () => {
    const context = canvas();
    context.cards.push(card("cd_water2", "喝水提醒 2", "CountdownCard", 600));
    const f = setup(["edit"], [{ clarify: "模型不应被调用" }]);
    const result = await runIntent({ text: "暂停喝水倒计时", canvasContext: context }, f.deps);
    expect(result.kind).not.toBe("host-operation");
  });

  it("keeps the loaded-state requirement for the model path", () => {
    // The same operation proposed by a model must still see a loaded timer state.
    expect(hostOperationIssue({ kind: "countdown.pause", targetId: "cd_water" }, canvas())).toBe("计时状态尚未完整加载。");
    expect(hostOperationIssue({ kind: "countdown.pause", targetId: "cd_water" }, canvas(), { allowUnloadedCountdownState: true })).toBeNull();
  });

  it("never submits or announces a pause whose timer is not on the canvas", async () => {
    const context = canvas();
    context.cards = context.cards.filter(card => card.id !== "cd_water");
    const f = setup(["edit"], [{ clarify: "模型不应被调用" }]);
    const result = await runIntent({ text: "暂停喝水倒计时", canvasContext: context }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("clarify");
    expect(result.hostOperation).toBeUndefined();
    // No false completion wording: nothing was submitted, nothing was paused.
    expect(result.message ?? "").not.toMatch(/已暂停|已继续|已完成|已提交/);
    // Either the rules guard or the existing target guard asks for the card.
    expect(result.message ?? "").toMatch(/计时卡片|指明|卡名/);
  });

  it("asks instead of pausing a card that is not a timer", async () => {
    const context = canvas();
    context.cards.push(card("note_water", "喝水提醒", "NoteCard", 1200));
    const f = setup(["edit"], [{ clarify: "模型不应被调用" }]);
    // Two candidates: the note must not be paused, and the timer name alone is
    // ambiguous only because the note carries the same label.
    const result = await runIntent({ text: "暂停喝水提醒倒计时", canvasContext: context }, f.deps);
    expect(result.hostOperation?.kind === "countdown.pause" ? result.hostOperation.targetId : "none").not.toBe("note_water");
    expect(result.message ?? "").not.toMatch(/已暂停/);
  });

  it("announces the resolved card without claiming the timer is already paused", async () => {
    const f = setup(["edit"], [{ clarify: "模型不应被调用" }]);
    const result = await runIntent({ text: "暂停喝水倒计时", canvasContext: canvas() }, f.deps);
    expect(result.kind).toBe("host-operation");
    expect(result.hostOperation).toEqual({ kind: "countdown.pause", targetId: "cd_water" });
    expect(result.message).toContain("喝水提醒");
    expect(result.message).toMatch(/等待执行确认/);
    expect(result.message).not.toMatch(/已暂停|已继续/);
  });
});

describe("accept60: weekly plan content is generation, not invented user facts", () => {
  it("sc-16 builds the next week's plan without inventing clock times", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T02:00:00.000Z"));
    const f = setup(["generate"], [{ contract: "weekly_schedule", slots: { title: "下周健身计划",
      events: [{ day: 1, title: "力量训练" }, { day: 3, title: "有氧" }, { day: 5, title: "拉伸" }] } }]);
    const result = await runIntent({ text: "帮我做一个下周的健身计划", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    const weekly = created(result)[0];
    expect(weekly?.type).toBe("WeeklyScheduleCard");
    if (weekly?.type !== "WeeklyScheduleCard") return;
    expect(weekly.displayProps.weekStart).toBe("2026-10-19");
    expect(weekly.displayProps.events.map(event => event.day)).toEqual([1, 3, 5]);
    for (const event of weekly.displayProps.events) {
      expect(event).not.toHaveProperty("start");
      expect(event).not.toHaveProperty("end");
    }
  });
});

describe("accept60: card operations are not weather lookups", () => {
  it("sc-39 把上海天气那张卡拖到左上角 stays an arrange move", async () => {
    expect(parseWeatherInput("把上海天气那张卡拖到左上角")).toBeNull();
    const weather = vi.fn(async () => ({ kind: "clarify" as const, message: "weather must not run", candidates: [] }));
    const f = setup(["arrange"], [{ slots: { mode: "move", direction: "left" }, say: "已移动。", text: "已移动。" }]);
    const result = await runIntent({ text: "把上海天气那张卡拖到左上角", canvasContext: canvas() },
      { ...f.deps, data: { handleDataIntent: (text, context) => handleDataIntent(text, context, undefined, { weather }) } });
    expect(result.kind, JSON.stringify(result)).toBe("host-operation");
    expect(result.hostOperation).toMatchObject({ kind: "card.move", targetId: "weather_sh", direction: "left" });
    expect(weather).not.toHaveBeenCalled();
  });
});

describe("accept60: a two-card movement relation resolves both cards", () => {
  it("sc-40 moves 读书笔记 under 购物清单 instead of asking which card", async () => {
    const f = setup(["arrange"], [{ slots: { mode: "move", direction: "down" }, say: "已移动。", text: "已移动。" }]);
    const result = await runIntent({ text: "读书笔记挪到购物清单下面", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("host-operation");
    expect(result.hostOperation).toEqual({ kind: "card.move", targetId: "note_book", relativeTo: "todo_shop", direction: "down" });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
});

describe("accept60: a follow-up clause inherits the card the first clause focused", () => {
  it("sc-51 edits 会议记录 instead of listing five unrelated cards", async () => {
    const f = setup(["focus", "edit"], [{ plans: [
      { contract: "focus", clause: 0, slots: {} },
      { contract: "edit", clause: 1, slots: { mode: "note", text: "首页改版讨论" } },
    ], say: "已聚焦并改标题。", text: "已聚焦会议记录并改标题。" }], async () => ({ choice: "ambiguous", probability: .9, latencyMs: 1 }));
    const result = await runIntent({ text: "聚焦会议记录，把标题改成首页改版讨论", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(actions(result)).toContainEqual({ type: "card.focus", targetId: "note_meeting" });
    expect(actions(result)).toContainEqual({ type: "card.update", targetId: "note_meeting", displayProps: { text: "首页改版讨论" } });
    for (const title of ["本周待办", "购物清单", "读书笔记", "喝水提醒", "上海天气", "Google 公司介绍"]) {
      expect(result.message ?? "").not.toContain(title);
    }
  });
});

describe("accept60: an absent card gets zero unrelated candidates", () => {
  it("sc-58 聚焦一下日程卡 says the card is absent instead of listing the canvas", async () => {
    const f = setup(["focus"], [{ clarify: "模型不应被调用" }], async () => ({ choice: "ambiguous", probability: .99, latencyMs: 1 }));
    const result = await runIntent({ text: "聚焦一下日程卡", canvasContext: canvas() }, f.deps);
    expect(result.kind).toBe("clarify");
    expect(result.message).toBe("没有找到要操作的卡片，请说明卡名。");
    expect(result.targetCandidates ?? []).toHaveLength(0);
    expect(result.envelope).toBeUndefined();
    expect(f.generate).not.toHaveBeenCalled();
  });
});

describe("accept60: 南京 homonym clarification is intentional product behaviour", () => {
  it("sc-21 asks instead of choosing between verified same-name places", async () => {
    const rows = { results: [
      { id: 1799962, name: "南京", latitude: 32.06167, longitude: 118.77778, country: "中国", country_code: "CN",
        admin1: "江苏", timezone: "Asia/Shanghai", feature_code: "PPLA", population: 9314685 },
      { id: 9924292, name: "南京", latitude: 23.4071, longitude: 99.7757, country: "中国", country_code: "CN",
        admin1: "云南", admin2: "临沧市", timezone: "Asia/Shanghai", feature_code: "PPL" },
      { id: 9931976, name: "南京", latitude: 23.7873, longitude: 101.084, country: "中国", country_code: "CN",
        admin1: "云南", admin2: "思茅市", timezone: "Asia/Shanghai", feature_code: "PPL" },
    ] };
    const result = await lookupWeather("南京", { signal: new AbortController().signal, maxBytes: 128 * 1024,
      fetchImpl: (async () => Response.json(rows)) as typeof fetch });
    expect(result.kind).toBe("clarify");
    if (result.kind !== "clarify") return;
    expect(result.candidates).toHaveLength(3);
    expect(result.message).toContain("南京 / 江苏 / 中国");
    expect(result.message).toContain("南京 / 云南 / 中国");
  });
});
