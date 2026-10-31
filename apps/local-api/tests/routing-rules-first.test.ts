import { describe, expect, it, vi } from "vitest";
import type { IntentRouteId } from "@vivic/contracts";
import { runIntent, type PipelineDeps } from "../src/intent/pipeline.js";
import { CredentialStore } from "../src/credentials.js";
import { splitClauses } from "../src/decision/split.js";
import { emptyContext } from "./helpers.js";
import { matchRules } from "../src/intent/rules.js";

function setup(reply: unknown = { clarify: "请补充要求。" }) {
  const classify = vi.fn(async (text: string) => {
    const route: IntentRouteId = /倒计时|分钟/.test(text) ? "countdown" : /待办/.test(text) ? "todo" : "note";
    return { route, probability: .99, probabilities: { [route]: .99 }, none: false, latencyMs: 50 };
  });
  const generate = vi.fn(async () => ({ ok: true as const, value: reply }));
  const deps: PipelineDeps = { router: { mode: "on", directRoutes: new Set(["countdown", "todo", "note", "overview", "restore"]),
    routeUtterance: classify, chooseTarget: vi.fn(async () => null) }, credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" },
    planner: { provider: "gpt", connected: true, isCurrent: () => true, generate } };
  return { deps, classify, generate };
}
describe("complete approved contracts precede classification", () => {
  it.each(["加待办：买牛奶；交周报；预约体检", "加一个待办：买牛奶；交周报；预约体检", "添加三条待办：买牛奶；交周报；预约体检"])("keeps a literal list in one container: %s", async text => {
    const f = setup(), ctx = emptyContext(), original = structuredClone(ctx);
    const result = await runIntent({ text, canvasContext: ctx }, f.deps);
    const cards = result.envelope?.actions.flatMap(a => a.type === "card.create" ? [a.card] : []);
    expect(splitClauses(text)).toEqual([text]);
    expect(cards).toHaveLength(1);
    expect(cards![0]?.type).toBe("TodoCard");
    expect((cards![0]?.displayProps as { items: Array<{ text: string }> }).items.map(item => item.text)).toEqual(["买牛奶", "交周报", "预约体检"]);
    expect(f.classify).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled(); expect(ctx).toEqual(original);
  });
  it.each(["不要加待办：买牛奶", "加一个待办是什么意思？", "如何添加待办", "如果明天有空就加待办：买牛奶", "解释一下“倒计时50分钟”", "记便笺：“喝水”，然后设一个倒计时"])("keeps uncertain requests in the original fallback: %s", async text => {
    const f = setup(), result = await runIntent({ text, canvasContext: emptyContext() }, f.deps);
    expect(result.envelope).toBeUndefined(); expect(result.kind).toBe("clarify"); expect(f.generate).toHaveBeenCalled();
  });
  it("only classifies the unresolved clause and retains atomicity", async () => {
    const f = setup(), result = await runIntent({ text: "记个便笺明天交周报，再设一个倒计时", canvasContext: emptyContext() }, f.deps);
    expect(f.classify.mock.calls.map(call => call[0])).toEqual(["设一个倒计时"]);
    expect(result.kind).toBe("clarify"); expect(result.envelope).toBeUndefined();
  });
  it("does not swallow an independent operation as a list item", () => {
    expect(splitClauses("加待办：买牛奶；显示全部")).toEqual(["加待办：买牛奶", "显示全部"]);
  });
  it("preserves an explicit note operation after a todo list", async () => {
    const f = setup();
    const text = "加待办：买牛奶；记个便笺明天交周报";
    expect(splitClauses(text)).toEqual(["加待办：买牛奶", "记个便笺明天交周报"]);
    const result = await runIntent({ text, canvasContext: emptyContext() }, f.deps);
    const cards = result.envelope?.actions.flatMap(a => a.type === "card.create" ? [a.card] : []) ?? [];
    expect(cards.map(card => card.type)).toEqual(["TodoCard", "NoteCard"]);
    expect(cards[1]?.displayProps).toEqual({ text: "明天交周报" });
    expect(f.classify).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
  });
  it.each(["取消固定购物清单", "打开购物清单", "搜索明天天气"])("defers a list followed by another existing operation: %s", async operation => {
    const f = setup();
    const text = `加待办：买牛奶；${operation}`;
    expect(splitClauses(text)).toEqual(["加待办：买牛奶", operation]);
    const result = await runIntent({ text, canvasContext: emptyContext() }, f.deps);
    expect(result.envelope).toBeUndefined(); expect(f.generate).toHaveBeenCalled();
  });
  it("keeps a colloquial reminder after a note as an independent requirement", async () => {
    const f = setup({ slots: { seconds: 300, text: "休息" } });
    const text = "记个便笺明天交周报，再过五分钟叫我休息";
    expect(splitClauses(text)).toEqual(["记个便笺明天交周报", "过五分钟叫我休息"]);
    const result = await runIntent({ text, canvasContext: emptyContext() }, f.deps);
    expect(f.classify.mock.calls.map(call => call[0])).toEqual(["过五分钟叫我休息"]);
    expect(result.envelope?.actions.flatMap(a => a.type === "card.create" ? [a.card.type] : [])).toEqual(["NoteCard", "CountdownCard"]);
  });
  it("does not widen an empty allow-list", async () => {
    const f = setup(); f.deps.router!.directRoutes = new Set();
    const result = await runIntent({ text: "加一个待办：买牛奶", canvasContext: emptyContext() }, f.deps);
    expect(f.classify).toHaveBeenCalledOnce(); expect(f.generate).toHaveBeenCalledOnce(); expect(result.envelope).toBeUndefined();
  });
  it("keeps ordinary verbs inside explicit list content", async () => {
    const f = setup(), text = "加待办：买牛奶；写周报；预约体检";
    expect(splitClauses(text)).toEqual([text]);
    const result = await runIntent({ text, canvasContext: emptyContext() }, f.deps);
    const card = result.envelope?.actions.find(a => a.type === "card.create");
    expect(card?.type === "card.create" && (card.card.displayProps as { items: Array<{ text: string }> }).items.map(item => item.text))
      .toEqual(["买牛奶", "写周报", "预约体检"]);
    expect(f.classify).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
  });
  it("defers an explicit item count that does not match the supplied items", async () => {
    const f = setup();
    const result = await runIntent({ text: "添加三条待办：买牛奶；交周报", canvasContext: emptyContext() }, f.deps);
    expect(result.envelope).toBeUndefined(); expect(f.generate).toHaveBeenCalled();
  });
  it.each(["创建一张周计划卡", "生成阅读计划卡", "设个5分钟计时器", "删除购物清单", "固定购物清单"])("never consumes a typed operation as list content: %s", async operation => {
    const f = setup(), text = `加待办：买牛奶；${operation}`;
    expect(splitClauses(text)).toEqual(["加待办：买牛奶", operation]);
    const result = await runIntent({ text, canvasContext: emptyContext() }, f.deps);
    expect(result.envelope).toBeUndefined(); expect(f.generate).toHaveBeenCalled();
  });
  it.each(["帮我创建一个倒计时 30 分钟。", "创建倒计时30分钟", "倒计时30分钟", "倒计时30分钟。", "30分钟倒计时", "30分钟倒计时！", "创建一个 10 分钟的倒计时。", "30 分钟的倒计时。"])("fast-paths countdown regardless of word order: %s", text => {
    const hit = matchRules(text, emptyContext());
    expect(hit).not.toBeNull();
    const create = hit!.actions.find(action => action.type === "card.create");
    expect(create?.type === "card.create" && create.card.type).toBe("CountdownCard");
  });
  it("builds the user's exact countdown sentence as one direct decision clause", async () => {
    const f = setup();
    const telemetry = { plannerCalls: 0, directClauses: 0 };
    const route = { route: "countdown" as const, probability: .99, probabilities: { countdown: .99 }, none: false, latencyMs: 1 };
    const result = await runIntent({ text: "帮我创建一个倒计时 30 分钟。", canvasContext: emptyContext() }, {
      ...f.deps, decisionTelemetry: telemetry,
      routeHint: Promise.resolve({ result: route, target: Promise.resolve(undefined) }),
    });
    const cards = result.envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []);
    expect(cards).toEqual(["CountdownCard"]);
    expect(telemetry.plannerCalls).toBe(0);
    expect(telemetry.directClauses).toBe(1);
    expect(f.classify).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
  });
});
