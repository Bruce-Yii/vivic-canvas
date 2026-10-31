import { describe, expect, it, vi } from "vitest";
import { buildState, cardLabel, cardTitle, createIntentRouter } from "../src/decision/router.js";
import { resolveTarget } from "../src/decision/target.js";
import { splitClauses } from "../src/decision/split.js";
import { emptyContext } from "./helpers.js";
import type { CanvasContext } from "../src/schemas.js";

const card = (id: string, title: string, type = "TodoCard", x = 0, y = 0): CanvasContext["cards"][number] => ({
  id, type, aliases: [title], displayProps: { title, items: [{ text: "交周报" }] },
  sourceDataSummary: {}, layout: { x, y },
});
describe("independent route classification", () => {
  it("sends one native question and only reads a route, never a card or action", async () => {
    const request = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(Object.keys(body.questions)).toEqual(["route"]);
      expect(body.state.canvas.cards[0].desc).toContain("TodoCard「本周待办」交周报");
      expect(body.state.user_message).toBe("加个待办");
      return Response.json({ answers: { route: { choice: "todo", probabilities: { todo: .96, chat: .04 } } } });
    });
    const router = createIntentRouter({ url: "https://unit.test/decisions", apiKey: "unit-only", mode: "shadow", fetchImpl: request as typeof fetch });
    const result = await router.routeUtterance("加个待办", emptyContext([card("todo1", "本周待办")]));
    expect(result).toMatchObject({ route: "todo", probability: .96, none: false });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    { choice: "execute_code", probabilities: { execute_code: 1 } },
    { choice: "todo", probabilities: { todo: NaN } },
    { choice: "todo", probabilities: { todo: 1.5 } },
    { choice: "todo", probabilities: {} },
  ])("rejects invalid model answers", async answer => {
    const router = createIntentRouter({ url: "https://unit.test", apiKey: "unit-only",
      fetchImpl: (async () => Response.json({ answers: { route: answer } })) as typeof fetch });
    expect(await router.routeUtterance("待办", emptyContext())).toBeNull();
  });
  it("keeps abstention distinct from a transport failure", async () => {
    const router = createIntentRouter({ url: "https://unit.test", apiKey: "unit-only",
      fetchImpl: (async () => Response.json({ answers: { route: { choice: null, probabilities: { todo: .2, chat: .1 } } } })) as typeof fetch });
    expect(await router.routeUtterance("不明确", emptyContext())).toMatchObject({ route: null, probability: 0, none: true });
  });
  it("returns null on timeout, upstream error or missing credentials", async () => {
    const fetchImpl = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true })));
    const router = createIntentRouter({ url: "https://unit.test", apiKey: "unit-only", timeoutMs: 5, fetchImpl: fetchImpl as typeof fetch });
    expect(await router.routeUtterance("你好", emptyContext())).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const unavailable = createIntentRouter({ url: "https://unit.test", apiKey: "unit-only", fetchImpl: (async () => new Response("private error", { status: 503 })) as typeof fetch });
    expect(await unavailable.routeUtterance("你好", emptyContext())).toBeNull();
    expect(await createIntentRouter({ url: "https://unit.test", apiKey: "" }).routeUtterance("你好", emptyContext())).toBeNull();
  });
  it("bounds context to 40 cards and 110 characters, retaining focus", () => {
    const context = emptyContext(Array.from({ length: 64 }, (_, i) => card(`c${i}`, "长标题".repeat(80))));
    context.focusHistory = ["c63"];
    const state = buildState("你好", context);
    expect(state.canvas.cards).toHaveLength(40);
    expect(state.canvas.cards[0]!.id).toBe("c63");
    expect(state.canvas.cards.every(c => c.desc.length <= 110)).toBe(true);
  });
  it("uses actual NewsCard and CountdownCard fields, not only abstract evaluation fields", () => {
    const news = card("news", "unused", "NewsCard");news.aliases = [];
    news.displayProps = { headline: "Google公司介绍", summary: "summary", keyPoints: ["1998年成立"] };
    expect(cardTitle(news)).toBe("Google公司介绍");
    expect(cardLabel(news)).toContain("1998年成立");
    const timer = card("timer", "unused", "CountdownCard");timer.aliases = [];timer.displayProps = {};
    timer.sourceDataSummary = { reminderText: "喝水提醒", targetAt: "2026-10-29T10:18:00.000Z", pausedAt: "2026-10-29T10:00:00.000Z" };
    expect(cardTitle(timer)).toBe("喝水提醒");expect(cardLabel(timer)).toContain("18分钟");
  });
});
describe("clause splitting", () => {
  it("splits multiple actions, preserving quoted content and at most three parts", () => {
    expect(splitClauses("我要记得周五之前缴电费，加到待办里")).toEqual(["我要记得周五之前缴电费，加到待办里"]);
    expect(splitClauses("记下“先打开，然后点运行”，再设个倒计时")).toEqual(["记下“先打开，然后点运行”", "设个倒计时"]);
    expect(splitClauses("新建待办，然后设倒计时，再写便签，然后显示全部")).toEqual(["新建待办", "设倒计时", "写便签，然后显示全部"]);
    expect(splitClauses("帮我记明天交周报，再设个50分钟倒计时")).toEqual(["帮我记明天交周报", "设个50分钟倒计时"]);
    expect(splitClauses("聚焦左边的待办，高亮第二条")).toEqual(["聚焦左边的待办", "高亮第二条"]);
    expect(splitClauses("倒计时5分钟，提醒我喝水")).toEqual(["倒计时5分钟，提醒我喝水"]);
  });
  it.each(["不要删卡，然后聚焦待办", "如果下雨然后提醒我", "先别动，再设置计时器", "给我写一段再见的话", "让倒计时再快一点"]) ("keeps conditional, negated and lexical uses together", text => {
    expect(splitClauses(text)).toEqual([text]);
  });
});
describe("target resolution", () => {
  const context = emptyContext([card("todo-left", "本周待办", "TodoCard", -200),
    card("todo-right", "购物清单", "TodoCard", 200), card("note1", "读书笔记", "NoteCard", 0)]);
  it("resolves title, focus, position and unique type without a model request", async () => {
    const model = { chooseTarget: vi.fn() };
    expect(await resolveTarget("聚焦购物清单", context, "focus", model)).toEqual({ targetId: "todo-right" });
    expect(await resolveTarget("高亮左边的待办", context, "highlight", model)).toEqual({ targetId: "todo-left" });
    expect(await resolveTarget("打开便签", context, "focus", model)).toEqual({ targetId: "note1" });
    expect(await resolveTarget("这张闪一下", { ...context, focusHistory: ["note1"] }, "highlight", model)).toEqual({ targetId: "note1" });
    expect(model.chooseTarget).not.toHaveBeenCalled();
  });
  it("asks the model once when necessary, never guessing from low confidence", async () => {
    const model = { chooseTarget: vi.fn(async () => ({ choice: "todo-right", probability: .95, latencyMs: 20 })) };
    expect(await resolveTarget("打开买东西那个", context, "focus", model)).toEqual({ targetId: "todo-right" });
    expect(model.chooseTarget).toHaveBeenCalledTimes(1);
    model.chooseTarget.mockResolvedValueOnce({ choice: "todo-right", probability: .4, latencyMs: 20 });
    expect(await resolveTarget("打开那个", context, "focus", model)).toHaveProperty("ambiguous");
  });
  it("reports spatial ties and missing targets; non-target routes do no work", async () => {
    const model = { chooseTarget: vi.fn() };
    expect(await resolveTarget("左边的待办", emptyContext([card("a", "甲任务"), card("b", "乙任务")]), "focus", model)).toHaveProperty("ambiguous");
    expect(await resolveTarget("打开天气", context, "focus", model)).toEqual({ missing: true });
    expect(await resolveTarget("显示全部", context, "overview", model)).toBeUndefined();
    expect(model.chooseTarget).not.toHaveBeenCalled();
  });
  it("does not invent a first list entry on a plain-text focused note", async () => {
    const model = { chooseTarget: vi.fn() };
    const list = card("list", "待办");
    const note = card("note", "会议便笺", "NoteCard");note.displayProps = { text: "一段普通文字" };
    const result = await resolveTarget("高亮第一条", { ...emptyContext([list, note]), focusHistory: ["note"] }, "highlight", model);
    expect(result).toHaveProperty("ambiguous");
    expect(result).not.toEqual({ targetId: "note" });
    expect(model.chooseTarget).not.toHaveBeenCalled();
  });
});
