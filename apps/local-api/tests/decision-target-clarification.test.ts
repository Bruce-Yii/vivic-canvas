import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import type { LocalApiConfig } from "../src/config.js";
import { IntentResponseSchema, type CanvasContext } from "../src/schemas.js";
import type { IntentRouter, RouteResult } from "../src/decision/router.js";
import { runIntent, type IntentResult, type PipelineDeps } from "../src/intent/pipeline.js";
import { resolveTarget } from "../src/decision/target.js";
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
