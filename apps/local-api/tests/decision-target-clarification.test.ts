import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import type { LocalApiConfig } from "../src/config.js";
import { IntentResponseSchema, type CanvasContext } from "../src/schemas.js";
import type { IntentRouter, RouteResult } from "../src/decision/router.js";
import { runIntent, type IntentResult, type PipelineDeps } from "../src/intent/pipeline.js";
import { resolveTarget } from "../src/decision/target.js";
import { DecisionTaskManager } from "../src/decision/taskV2.js";
import type { ChatMessage } from "../src/stepfun.js";

const origin = "https://unit.test", token = "TEST-target-clarify-token-12345678";
const config: LocalApiConfig = { host: "127.0.0.1", port: 0, token, tokenPath: "", tokenGenerated: false,
  allowedOrigins: [origin], stepfunBaseUrl: "https://model.test/v1", modelApiBaseUrl: "https://unused.test/v1",
  bodyLimitBytes: 65536, requestTimeoutMs: 60000, managedDecisionEnabled: false, decisionProviderEnabled: false, decisionV2ExecutionEnabled: false };
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.dispose(); vi.restoreAllMocks(); });

type CanvasCard = CanvasContext["cards"][number];
const card = (id: string, title: string, type = "NoteCard", x = 0): CanvasCard => ({
  id, type, aliases: [title], displayProps: type === "TodoCard"
    ? { title, items: [{ id: `${id}-item`, text: "买牛奶", done: false }] } : { text: title },
  sourceDataSummary: {}, layout: { x, y: 0, width: 320, height: 120, pinned: false },
});
/** The evaluation canvas: seven cards, one focused note, two same-type todos. */
const canvas = (): CanvasContext => ({ canvasId: "TEST-target", version: 7, stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: ["note_meeting"], cards: [
    card("todo_week", "本周待办", "TodoCard", 0), card("todo_shop", "购物清单", "TodoCard", 900),
    card("note_meeting", "会议记录", "NoteCard", 300), card("note_book", "读书笔记", "NoteCard", 600),
    card("cd_water", "喝水提醒", "CountdownCard", 0), card("weather_sh", "上海天气", "WeatherCard", 300),
    card("answer_google", "Google 公司介绍", "AnswerCard", 900),
  ] });
const route = (id: RouteResult["route"], probability = .99): RouteResult =>
  ({ route: id, probability, probabilities: { [id!]: probability }, none: false, latencyMs: 1 });
const titles = canvas().cards.map(item => item.displayProps.title ?? item.displayProps.text);

/** The B-pilot canvas: two todo cards whose ids are internal (`bpilot-*`), so the
 * user must only ever see the card face and the position. */
const pilot = (id: string, title: string, x: number, y = 0): CanvasCard => ({
  id, type: "TodoCard", aliases: title ? [title] : [],
  displayProps: { ...(title ? { title } : {}), items: [{ id: `${id}-item`, text: "买牛奶", done: false }] },
  sourceDataSummary: {}, layout: { x, y, width: 360, height: 120, pinned: false },
});
const pilotCanvas = (cards: CanvasCard[]): CanvasContext => ({ canvasId: "TEST-bpilot", version: 3, stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards });
const uuid = "3f2b8c1e-9a4d-4b7e-8f1a-2c5d6e7f8091";
const noInternalId = (text: string) => {
  expect(text).not.toContain("bpilot-");
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/iu);
  expect(text).not.toContain(uuid);
};

function setup(routeFor: (text: string) => RouteResult["route"], chooseTarget: IntentRouter["chooseTarget"] = async () => null,
  modelReply: unknown = { clarify: "模型不应被调用" }) {
  const router: IntentRouter = { mode: "on", directRoutes: new Set(["countdown", "todo", "note", "overview", "restore"]),
    routeUtterance: vi.fn(async (text: string) => route(routeFor(text))), chooseTarget: vi.fn(chooseTarget) };
  // A credential lets the slot planner run; the model must stay unused when the
  // observer already resolved the target.
  const credentials = new CredentialStore();
  credentials.set({ apiKey: "TEST-target-model-key", defaultModel: "step-3.7-flash", models: ["step-3.7-flash"], checkedAt: new Date().toISOString() });
  const model = vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify(modelReply) } }] }));
  const app = createApp({ config, mode: "online", credentials, router, fetchImpl: model as typeof fetch });
  apps.push(app);
  async function post(body: unknown): Promise<IntentResult> {
    const response = await app.fetch(new Request(`${origin}/api/intent`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, origin, "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(response.status).toBe(200);
    return IntentResponseSchema.parse(await response.json()) as IntentResult;
  }
  return { post, router, model };
}
const reply = (first: IntentResult, text: string, canvasContext = canvas()) => ({ text, canvasContext, task: { id: first.task!.id } });

describe("an already resolved target is never asked about again", () => {
  it("focuses the focused card for 别删，先聚焦它 without a model question", async () => {
    const f = setup(text => /聚焦/.test(text) ? "focus" : "chat");
    const result = await f.post({ text: "别删，先聚焦它", canvasContext: canvas() });
    expect(result.kind).toBe("envelope");
    expect(result.message ?? "").not.toContain("哪");
    expect(result.envelope?.actions).toContainEqual({ type: "card.focus", targetId: "note_meeting" });
    expect(result.task?.status).toBe("awaiting_execution");
    expect(f.model).not.toHaveBeenCalled();
  });

  it("turns 这张卡没用了，扔掉 into the delete confirmation for the focused card", async () => {
    const f = setup(text => /扔掉|删除/.test(text) ? "delete" : "chat");
    const first = await f.post({ text: "这张卡没用了，扔掉", canvasContext: canvas() });
    expect(first.kind).toBe("clarify");
    expect(first.message).toBe("确定删除「会议记录」吗？");
    expect(first.message).not.toContain("哪张卡片");
    expect(first.envelope).toBeUndefined();
    expect(f.model).not.toHaveBeenCalled();
    const confirmed = await f.post(reply(first, "确定"));
    expect(confirmed.envelope?.actions).toEqual([{ type: "card.delete", targetId: "note_meeting" }]);
  });

  it("passes an observer-resolved target to the slots prompt as host_targets", async () => {
    const router: IntentRouter = { mode: "shadow", routeUtterance: vi.fn(async () => route("edit")),
      chooseTarget: vi.fn(async () => null) };
    const generate = vi.fn(async (_messages: ChatMessage[]) => ({ ok: true as const, value: { clarify: "要改什么？" } }));
    const deps: PipelineDeps = { router, credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" },
      planner: { provider: "gpt", connected: true, isCurrent: () => true, generate } };
    const context = canvas();
    await runIntent({ text: "改一下这张卡", canvasContext: context }, deps);
    expect(generate).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(generate.mock.calls[0]![0][1]!.content) as { host_targets?: Record<string, string>; host_selection_note?: string };
    expect(payload.host_targets).toEqual({ "0": "note_meeting" });
    expect(payload.host_selection_note).toContain("不要再追问");
  });
});

describe("delete clarification text matches the frozen numbered payload", () => {
  it("numbers 删除待办, resolves a bare 1, then keeps the delete confirmation separate", async () => {
    const f = setup(text => /删除|确定/.test(text) ? "delete" : "chat");
    const first = await f.post({ text: "删除待办", canvasContext: canvas() });
    expect(first.kind).toBe("clarify");
    const candidates = first.task?.clarification?.candidates ?? [];
    expect(candidates).toEqual([
      { number: 1, id: "todo_week", label: "本周待办" },
      { number: 2, id: "todo_shop", label: "购物清单" },
    ]);
    expect(first.message).toBe("你要删除哪张卡片？1. 本周待办 2. 购物清单");
    for (const candidate of candidates) expect(first.message).toContain(`${candidate.number}. ${candidate.label}`);
    expect(first.envelope).toBeUndefined();
    const selected = await f.post(reply(first, "1"));
    expect(selected.message).toBe("确定删除「本周待办」吗？");
    expect(selected.envelope).toBeUndefined();
    const confirmed = await f.post(reply(first, "确定"));
    expect(confirmed.envelope?.actions).toEqual([{ type: "card.delete", targetId: "todo_week" }]);
  });

  it("refuses a number whose card disappeared instead of deleting a replacement", async () => {
    const f = setup(text => /删除|确定/.test(text) ? "delete" : "chat");
    const first = await f.post({ text: "删除待办", canvasContext: canvas() });
    const stale = canvas();
    stale.cards = stale.cards.filter(item => item.id !== "todo_week");
    const result = await f.post(reply(first, "1", stale));
    expect(result.kind).toBe("clarify");
    expect(result.message).toContain("候选已不存在");
    expect(result.envelope).toBeUndefined();
    expect(result.hostOperation).toBeUndefined();
  });

  it("caps eight same-type delete candidates to five numbered items", async () => {
    const f = setup(text => /删除/.test(text) ? "delete" : "chat");
    const eight = canvas();
    eight.cards = Array.from({ length: 8 }, (_, index) => card(`todo_${index}`, `清单${index}`, "TodoCard", index * 400));
    eight.focusHistory = [];
    const result = await f.post({ text: "删除待办", canvasContext: eight });
    const candidates = result.task?.clarification?.candidates ?? [];
    expect(candidates).toHaveLength(5);
    expect(candidates.map(candidate => candidate.number)).toEqual([1, 2, 3, 4, 5]);
    for (const candidate of candidates) expect(result.message).toContain(`${candidate.number}. ${candidate.label}`);
    expect(result.envelope).toBeUndefined();
  });

  it("caps eight same-type focus candidates to five numbered items", async () => {
    const f = setup(text => /聚焦/.test(text) ? "focus" : "chat");
    const eight = canvas();
    eight.cards = Array.from({ length: 8 }, (_, index) => card(`todo_${index}`, `清单${index}`, "TodoCard", index * 400));
    eight.focusHistory = [];
    const result = await f.post({ text: "聚焦待办", canvasContext: eight });
    const candidates = result.task?.clarification?.candidates ?? [];
    expect(candidates).toHaveLength(5);
    expect(candidates.map(candidate => candidate.number)).toEqual([1, 2, 3, 4, 5]);
    for (const candidate of candidates) expect(result.message).toContain(`${candidate.number}. ${candidate.label}`);
    expect(result.envelope).toBeUndefined();
  });

  it("reports an empty canvas as missing without listing or creating cards", async () => {
    const f = setup(text => /删除/.test(text) ? "delete" : "chat");
    const result = await f.post({ text: "删除读书笔记", canvasContext: { ...canvas(), cards: [], focusHistory: [] } });
    expect(result.kind).toBe("clarify");
    expect(result.message).toContain("没有找到要删除的卡片");
    expect(result.task?.clarification?.candidates ?? []).toHaveLength(0);
    expect(result.envelope).toBeUndefined();
  });
});

describe("a missing card gets zero unrelated candidates", () => {
  it("reports an explicit absent card as missing even without a target classifier", async () => {
    expect(await resolveTarget("聚焦一下日程卡", canvas(), "focus")).toEqual({ missing: true, source: "missing" });
  });

  it("treats 聚焦一下日程卡 as missing instead of offering the whole canvas", async () => {
    const f = setup(text => /聚焦/.test(text) ? "focus" : "chat",
      async () => ({ choice: "ambiguous", probability: .99, latencyMs: 1 }));
    const result = await f.post({ text: "聚焦一下日程卡", canvasContext: canvas() });
    expect(result.kind).toBe("clarify");
    expect(result.message).toBe("没有找到要操作的卡片，请说明卡名。");
    expect(result.task?.clarification?.candidates ?? []).toHaveLength(0);
    for (const title of titles) expect(result.message ?? "").not.toContain(title!);
    expect(result.envelope).toBeUndefined();
    expect(f.model).not.toHaveBeenCalled();
  });

  // accept20b sc-58: the real 4B answered missing at 0.505, below the 0.8 gate.
  // The named card is still absent, so the whole canvas must not be offered.
  it("reports an explicit absent card as missing when the classifier says missing below 0.8", async () => {
    expect(await resolveTarget("聚焦一下日程卡", canvas(), "focus",
      { chooseTarget: async () => ({ choice: "missing", probability: .505, latencyMs: 1 }) }))
      .toEqual({ missing: true, source: "missing" });
    const f = setup(text => /聚焦/.test(text) ? "focus" : "chat",
      async () => ({ choice: "missing", probability: .505, latencyMs: 1 }));
    const result = await f.post({ text: "聚焦一下日程卡", canvasContext: canvas() });
    expect(result.kind).toBe("clarify");
    expect(result.message).toBe("没有找到要操作的卡片，请说明卡名。");
    expect(result.task?.clarification?.candidates ?? []).toHaveLength(0);
    for (const title of titles) expect(result.message ?? "").not.toContain(title!);
    expect(result.envelope).toBeUndefined();
    expect(f.model).not.toHaveBeenCalled();
  });

  // The low-confidence fallback is only for a classifier-declared missing card.
  // A genuine ambiguity among same-type cards must still ask, not claim absence.
  it("still asks which same-type card when the classifier is genuinely ambiguous at low confidence", async () => {
    const f = setup(text => /聚焦/.test(text) ? "focus" : "chat",
      async () => ({ choice: "ambiguous", probability: .505, latencyMs: 1 }),
      { contract: "focus", slots: {}, say: "请选择一张待办。", text: "请选择一张待办。" });
    const result = await f.post({ text: "聚焦待办卡", canvasContext: canvas() });
    expect(result.kind).toBe("clarify");
    expect(result.message).toBe("你要操作哪一张？1. 本周待办 2. 购物清单");
    expect(result.task?.clarification?.candidates?.map(candidate => candidate.id)).toEqual(["todo_week", "todo_shop"]);
    expect(result.message ?? "").not.toContain("没有找到");
    expect(result.envelope).toBeUndefined();
  });

  it("keeps a confidently classified card even when its short name is not a title", async () => {
    const f = setup(text => /聚焦/.test(text) ? "focus" : "chat",
      async () => ({ choice: "note_meeting", probability: .97, latencyMs: 1 }));
    const result = await f.post({ text: "聚焦那个会议卡", canvasContext: canvas() });
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.envelope?.actions).toContainEqual({ type: "card.focus", targetId: "note_meeting" });
  });

  it("treats an edit of an absent card as missing without asking the model", async () => {
    const f = setup(text => /改|编辑/.test(text) ? "edit" : "chat", async () => null,
      { contract: "edit", slots: { mode: "note", text: "新的正文" } });
    const result = await f.post({ text: "改一下日程卡", canvasContext: canvas() });
    expect(result.kind).toBe("clarify");
    expect(result.message).toBe("没有找到要操作的卡片，请说明卡名。");
    expect(result.task?.clarification?.candidates ?? []).toHaveLength(0);
    for (const title of titles) expect(result.message ?? "").not.toContain(title!);
    expect(result.envelope).toBeUndefined();
    expect(f.model).not.toHaveBeenCalled();
  });
});

describe("a highlighted todo item is resolved by its text", () => {
  it("highlights 买牛奶 inside 本周待办 instead of the whole card (sc-30)", async () => {
    const f = setup(text => /高亮/.test(text) ? "highlight" : "chat",
      async () => ({ choice: "todo_week", probability: .97, latencyMs: 1 }));
    const result = await f.post({ text: "高亮一下买牛奶那条", canvasContext: canvas() });
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.envelope?.actions).toContainEqual({
      type: "card.highlight", targetId: "todo_week", itemId: "todo_week-item" });
    expect(result.envelope?.actions.some(action => action.type === "card.highlight" && action.itemId === undefined)).toBe(false);
    expect(f.model).not.toHaveBeenCalled();
  });
});

describe("an ambiguous operation lists only same-type candidates", () => {
  it("asks which todo to surface instead of choosing one", async () => {
    const f = setup(text => /传到用户页|传送/.test(text) ? "arrange" : "chat");
    const result = await f.post({ text: "把待办传到用户页我要编辑", canvasContext: canvas() });
    expect(result.kind).toBe("clarify");
    expect(result.message).toBe("你要操作哪一张？1. 本周待办 2. 购物清单");
    expect(result.task?.clarification?.candidates).toEqual([
      { number: 1, id: "todo_week", label: "本周待办" },
      { number: 2, id: "todo_shop", label: "购物清单" },
    ]);
    expect(result.envelope).toBeUndefined();
    expect(result.hostOperation).toBeUndefined();
    for (const title of ["会议记录", "读书笔记", "上海天气", "Google 公司介绍"]) {
      expect(result.message ?? "").not.toContain(title);
    }
    expect(f.model).not.toHaveBeenCalled();
  });

  it("asks which todo to focus on the two-todo canvas", async () => {
    const f = setup(text => /聚焦/.test(text) ? "focus" : "chat");
    const result = await f.post({ text: "聚焦待办", canvasContext: canvas() });
    expect(result.kind).toBe("clarify");
    expect(result.message).toBe("你要操作哪一张？1. 本周待办 2. 购物清单");
    expect(result.envelope).toBeUndefined();
    expect(f.model).not.toHaveBeenCalled();
  });

  it("offers candidates for a bare pronoun when nothing was focused yet", async () => {
    const f = setup(text => /聚焦/.test(text) ? "focus" : "chat");
    const unfocused = canvas();
    unfocused.focusHistory = [];
    const result = await f.post({ text: "聚焦它", canvasContext: unfocused });
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
    expect(result.task?.clarification?.candidates?.length).toBe(5);
    for (const candidate of result.task?.clarification?.candidates ?? []) {
      expect(result.message).toContain(`${candidate.number}. ${candidate.label}`);
    }
  });
});

describe("a spatial reference is answered from the layout, not by asking", () => {
  it("focuses the left todo of two separated cards without a second question", async () => {
    const f = setup(text => /聚焦/.test(text) ? "focus" : "chat", async () => null,
      { contract: "focus", slots: {}, say: "已聚焦。", text: "已聚焦左边的待办。" });
    const result = await f.post({ text: "聚焦左边的待办",
      canvasContext: pilotCanvas([pilot("bpilot-left", "买牛奶", 60), pilot("bpilot-right", "交周报", 720)]) });
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.envelope?.actions).toContainEqual({ type: "card.focus", targetId: "bpilot-left" });
    expect(result.message ?? "").not.toContain("哪一张");
    // The payload keeps the id; everything the user reads must not.
    noInternalId(result.message ?? "");
    expect(result.task?.clarification).toBeUndefined();
  });

  it("selects the middle and the rightmost card of three", async () => {
    const three = pilotCanvas([pilot("bpilot-left", "甲组", 60), pilot("bpilot-mid", "乙组", 440), pilot("bpilot-right", "丙组", 820)]);
    expect(await resolveTarget("聚焦中间的待办", three, "focus")).toEqual({ targetId: "bpilot-mid", source: "spatial" });
    expect(await resolveTarget("聚焦最右边的待办", three, "focus")).toEqual({ targetId: "bpilot-right", source: "spatial" });
    expect(await resolveTarget("聚焦最左边的待办", three, "focus")).toEqual({ targetId: "bpilot-left", source: "spatial" });
    // 中间 reads the axis that actually separates the cards, so a column works too.
    const column = pilotCanvas([pilot("bpilot-top", "甲组", 60, 60), pilot("bpilot-middle", "乙组", 60, 440),
      pilot("bpilot-bottom", "丙组", 60, 820)]);
    expect(await resolveTarget("聚焦中间的待办", column, "focus")).toEqual({ targetId: "bpilot-middle", source: "spatial" });
    expect(await resolveTarget("聚焦最下面的待办", column, "focus")).toEqual({ targetId: "bpilot-bottom", source: "spatial" });
    // An explicit pronoun keeps its existing precedence over a direction.
    expect(await resolveTarget("把这张卡移到左边", { ...three, focusHistory: ["bpilot-right"] }, "arrange"))
      .toEqual({ targetId: "bpilot-right", source: "focus" });
  });

  it("never reads a move destination as the target card", async () => {
    const three = pilotCanvas([pilot("bpilot-left", "甲组", 60), pilot("bpilot-mid", "乙组", 440),
      pilot("bpilot-right", "丙组", 820)]);
    // "to the middle" says where a card should go; the todo to move is still unclear.
    const middle = await resolveTarget("把待办移到中间", three, "arrange");
    expect(middle).toMatchObject({ source: "ambiguous" });
    expect(middle && "ambiguous" in middle ? middle.ambiguous.map(candidate => candidate.id) : [])
      .toEqual(["bpilot-left", "bpilot-mid", "bpilot-right"]);
    // A target mention before the destination still wins, whichever side it names.
    expect(await resolveTarget("把左边的待办移到右边", three, "arrange"))
      .toEqual({ targetId: "bpilot-left", source: "spatial" });
    expect(await resolveTarget("把右边的待办移到左边", three, "arrange"))
      .toEqual({ targetId: "bpilot-right", source: "spatial" });
    // The object between the verb and the direction does not make it a target.
    expect(await resolveTarget("把待办移到画布左边", three, "arrange")).toMatchObject({ source: "ambiguous" });
    // A direction without a movement verb keeps naming a card.
    expect(await resolveTarget("聚焦最右边的待办", three, "focus"))
      .toEqual({ targetId: "bpilot-right", source: "spatial" });
  });

  it("clarifies a stack with card-face labels and no internal ids", async () => {
    const stack = pilotCanvas([pilot("bpilot-left", "", 60), pilot(uuid, "", 60)]);
    const result = await resolveTarget("聚焦左边的待办", stack, "focus");
    expect(result).toMatchObject({ source: "ambiguous" });
    const candidates = result && "ambiguous" in result ? result.ambiguous : [];
    expect(candidates.map(candidate => candidate.id)).toEqual(["bpilot-left", uuid]);
    expect(new Set(candidates.map(candidate => candidate.label)).size).toBe(candidates.length);
    for (const candidate of candidates) {
      noInternalId(candidate.label);
      expect(candidate.label).toContain("待办");
      expect(candidate.label).toContain("x=60");
    }
  });

  it("adds a position hint when two cards share the same title", async () => {
    const stack = pilotCanvas([pilot("bpilot-left", "买牛奶", 60), pilot("bpilot-right", "买牛奶", 60, 140)]);
    const result = await resolveTarget("聚焦左边的待办", stack, "focus");
    const candidates = result && "ambiguous" in result ? result.ambiguous : [];
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map(candidate => candidate.label)).size).toBe(2);
    for (const candidate of candidates) {
      noInternalId(candidate.label);
      expect(candidate.label).toContain("买牛奶");
      expect(candidate.label).toContain("x=60");
    }
  });

  it("asks among an overlapping stack through the turn instead of guessing", async () => {
    const f = setup(text => /聚焦/.test(text) ? "focus" : "chat");
    const result = await f.post({ text: "聚焦左边的待办",
      canvasContext: pilotCanvas([pilot("bpilot-left", "", 60), pilot("bpilot-right", "", 76)]) });
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
    const candidates = result.task?.clarification?.candidates ?? [];
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      // The question text, the chip label and the payload are one list.
      expect(result.message).toContain(`${candidate.number}. ${candidate.label}`);
      noInternalId(candidate.label);
      expect(candidate.label).toContain("待办");
    }
    noInternalId(result.message ?? "");
    expect(f.model).not.toHaveBeenCalled();
  });

  it("stays safe on an empty canvas or a direction with no matching card", async () => {
    expect(await resolveTarget("聚焦左边的待办", pilotCanvas([]), "focus")).toEqual({ missing: true, source: "missing" });
    const f = setup(text => /聚焦/.test(text) ? "focus" : "chat", async () => null,
      { contract: "focus", slots: {}, say: "已聚焦。", text: "已聚焦。" });
    const result = await f.post({ text: "聚焦左边的便签", canvasContext: pilotCanvas([pilot("bpilot-left", "买牛奶", 60)]) });
    expect(result.kind).toBe("clarify");
    expect(result.message).toBe("没有找到要操作的卡片，请说明卡名。");
    expect(result.task?.clarification?.candidates ?? []).toHaveLength(0);
    expect(result.envelope).toBeUndefined();
    expect(result.hostOperation).toBeUndefined();
  });
});

/** `main-only` has no route hint and no target classifier: a target can only
 * come from the user's words (title, direction, ordinal reply) or from a
 * numbered clarification answer. The pilot canvas holds two todo cards whose
 * ids are internal, so every user-visible string is checked against them. */
describe("main-only resolves a target from words and asks only without a clue", () => {
  const twoTodos = () => pilotCanvas([pilot("bpilot-left", "买牛奶", 60), pilot("bpilot-right", "交周报", 720)]);
  // The cards are todos, so the edit contract must use a todo operation.
  const editAnswer = { contract: "edit", slots: { mode: "todo", operation: "title", title: "已更新" },
    say: "改好了。", text: "已修改。" };

  function mainOnly(reply: unknown = editAnswer) {
    const requests: string[] = [];
    const generate = vi.fn(async (messages: ChatMessage[]) => {
      const raw = String(messages[1]?.content ?? "{}").split("\n上次校验失败")[0]!;
      const payload = JSON.parse(raw) as { utterance?: string };
      requests.push(String(payload.utterance ?? ""));
      return { ok: true as const, value: reply };
    });
    // Production main-only never calls the 4B: routeUtterance returns null and
    // the target classifier is never invoked. A classifier call fails the test.
    const routeUtterance = vi.fn(async () => null);
    const chooseTarget = vi.fn(async () => { throw new Error("4B target must not be called"); });
    const router: IntentRouter = { mode: "on", policy: "main-only",
      directRoutes: new Set(["countdown", "todo", "note", "overview", "restore"]), routeUtterance, chooseTarget };
    const deps: PipelineDeps = { router, credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" },
      planner: { provider: "gpt", connected: true, isCurrent: () => true, generate } };
    return { deps, generate, requests, routeUtterance, chooseTarget };
  }
  const targetOf = (result: IntentResult) =>
    result.envelope?.actions.flatMap(action => "targetId" in action ? [action.targetId] : []) ?? [];

  it("asks when the words carry no title, direction or ordinal at all", async () => {
    const f = mainOnly();
    const result = await runIntent({ text: "把那个改一下", canvasContext: twoTodos() }, f.deps);
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
    expect(result.message).toBe("你要操作哪一张？1. 买牛奶 2. 交周报");
    expect(result.targetCandidates?.map(candidate => candidate.label)).toEqual(["买牛奶", "交周报"]);
    for (const candidate of result.targetCandidates ?? []) noInternalId(candidate.label);
    noInternalId(result.message ?? "");
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.routeUtterance).not.toHaveBeenCalled();
    expect(f.chooseTarget).not.toHaveBeenCalled();
  });

  it("selects the left todo from a spatial word without asking and without a 4B", async () => {
    const f = mainOnly();
    const result = await runIntent({ text: "把左边那个改一下", canvasContext: twoTodos() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(targetOf(result)).toEqual(["bpilot-left"]);
    expect(result.message ?? "").not.toContain("哪一张");
    noInternalId(result.message ?? "");
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.routeUtterance).not.toHaveBeenCalled();
    expect(f.chooseTarget).not.toHaveBeenCalled();
  });

  it("selects the right todo from a title substring without asking", async () => {
    const f = mainOnly();
    const result = await runIntent({ text: "改一下交周报", canvasContext: twoTodos() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(targetOf(result)).toEqual(["bpilot-right"]);
    expect(result.message ?? "").not.toContain("哪一张");
    expect(f.chooseTarget).not.toHaveBeenCalled();
  });

  it("still asks for 第二张 in the first utterance because card ordinals are not resolved", async () => {
    // §known limitation: target.ts only treats 第…条/项/点/行 as an item
    // ordinal for highlight/edit, never 第…张. The reply path below is the
    // supported way to answer with an ordinal, so this records the safe
    // behaviour instead of guessing a card.
    const f = mainOnly();
    const result = await runIntent({ text: "改一下第二张", canvasContext: twoTodos() }, f.deps);
    expect(result.kind).toBe("clarify");
    expect(result.message).toBe("你要操作哪一张？1. 买牛奶 2. 交周报");
    expect(result.envelope).toBeUndefined();
    expect(f.chooseTarget).not.toHaveBeenCalled();
  });

  it("resolves 第二张 as the numbered clarification reply and updates that card", async () => {
    const f = mainOnly();
    const tasks = new DecisionTaskManager();
    const first = await tasks.run({ text: "把那个改一下", canvasContext: twoTodos() },
      { legacy: (request, signal) => runIntent(request, f.deps, signal) });
    expect(first.kind).toBe("clarify");
    expect(first.task?.clarification?.candidates.map(candidate => [candidate.number, candidate.label]))
      .toEqual([[1, "买牛奶"], [2, "交周报"]]);
    const second = await tasks.run({ text: "第二张", canvasContext: twoTodos(), task: { id: first.task!.id } },
      { legacy: (request, signal) => runIntent(request, f.deps, signal) });
    expect(second.kind, JSON.stringify(second)).toBe("envelope");
    expect(targetOf(second)).toEqual(["bpilot-right"]);
    noInternalId(second.message ?? "");
    // The frozen target path still calls routeUtterance, which in main-only is a
    // local no-op that returns null. It must never reach the target classifier.
    for (const pending of f.routeUtterance.mock.results) expect(await pending.value).toBeNull();
    expect(f.chooseTarget).not.toHaveBeenCalled();
  });

  it("keeps full mode on the classifier path (no behaviour change)", async () => {
    // The pilot only changes main-only. A `full` turn must still ask the target
    // classifier before the planner sees the utterance.
    const chooseTarget = vi.fn(async () => ({ choice: "bpilot-right", probability: .9, latencyMs: 1 }));
    const router: IntentRouter = { mode: "on", directRoutes: new Set(["countdown", "todo", "note", "overview", "restore"]),
      routeUtterance: vi.fn(async () => route("edit")), chooseTarget };
    const generate = vi.fn(async () => ({ ok: true as const, value: editAnswer }));
    const deps: PipelineDeps = { router, credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" },
      planner: { provider: "gpt", connected: true, isCurrent: () => true, generate } };
    const result = await runIntent({ text: "把那个改一下", canvasContext: twoTodos() }, deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(targetOf(result)).toEqual(["bpilot-right"]);
    expect(chooseTarget).toHaveBeenCalledTimes(1);
    expect(result.trace?.policy).toBeUndefined();
  });
});
