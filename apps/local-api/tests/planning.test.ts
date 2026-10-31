import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema, type Action, type CardRecord } from "@vivic/contracts";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type IntentResult } from "../src/intent/pipeline.js";
import { matchRules } from "../src/intent/rules.js";
import { parseDuration } from "../src/intent/reminders.js";
import { buildSystemPrompt } from "../src/intent/prompt.js";
import { chatJson, validateConnection, validateKey } from "../src/stepfun.js";
import { chatOk, emptyContext, fetchStub, modelsOk } from "./helpers.js";

const KEY = "unit-planning-key-only";
const credential = { apiKey: KEY, models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "now" };
const context = emptyContext([{ id: "todo-1", type: "TodoCard", displayProps: { items: [{ id: "i1", text: "喝水", done: false }] },
  sourceDataSummary: {}, layout: { x: 0, y: 0 } }, { id: "cd-1", type: "CountdownCard", displayProps: {},
  sourceDataSummary: { targetAt: "2026-10-15T10:00:00.000Z" }, layout: { x: 300, y: 0 } }]);
const setup = (handler: (init?: RequestInit) => Response | Promise<Response>) => {
  const credentials = new CredentialStore();
  credentials.set(credential);
  const call = vi.fn(handler);
  return { deps: { credentials, stepfun: { baseUrl: "https://unit.test/v1", fetchImpl: fetchStub({ "/chat/completions": call }) } }, call };
};
const created = (result: IntentResult) => (result.envelope?.actions ?? [])
  .filter((a): a is Extract<Action, { type: "card.create" }> => a.type === "card.create").map((a) => {
    if (a.card.type !== "CountdownCard") throw new Error("Reminder planner created a different card type");
    return a.card;
  });
const note = (id = "note-new"): CardRecord => ({ id, type: "NoteCard", variant: "minimal", displayProps: { text: "记住喝水" },
  sourceData: {}, sources: [], layout: { x: 0, y: 0, width: 264, height: 120, pinned: false },
  metadata: { createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" } });
afterEach(() => vi.useRealTimers());

describe("deterministic complete reminder parsing", () => {
  it("creates three different reminders without any network calls, then fits once", async () => {
    const { deps, call } = setup(() => { throw new Error("must stay local"); });
    const before = Date.now();
    const result = await runIntent({ text: "五分钟后提醒我喝水，十分钟后提醒我吃药，十五分钟后提醒我拉伸", canvasContext: { ...emptyContext(), stage: "STANDBY" } }, deps);
    expect(result.usedProvider).toBe("rules");
    expect(call).not.toHaveBeenCalled();
    expect(ActionEnvelopeSchema.safeParse(result.envelope).success).toBe(true);
    const cards = created(result);
    expect(cards.map((c) => c.sourceData.reminderText)).toEqual(["喝水", "吃药", "拉伸"]);
    expect(new Set(cards.map((c) => c.id)).size).toBe(3);
    expect(new Set(cards.map((c) => `${c.layout.x},${c.layout.y}`)).size).toBe(3);
    cards.forEach((card, i) => {
      expect(card.displayProps).toEqual({});
      expect(card.sourceData).not.toHaveProperty("notifiedAt");
      expect(Date.parse(String(card.sourceData.targetAt)) - before).toBeGreaterThanOrEqual((i + 1) * 300_000);
      expect(Date.parse(String(card.sourceData.targetAt)) - Date.parse(String(card.sourceData.startedAt))).toBe((i + 1) * 300_000);
    });
    expect(result.envelope?.actions.map((a) => a.type)).toEqual(["stage.awaken", "card.create", "card.create", "card.create", "canvas.fit"]);
  });
  it("separates an explicit list at one shared duration", async () => {
    const { deps, call } = setup(() => chatOk({}));
    const result = await runIntent({ text: "半小时后提醒我喝水、吃药、拉伸", canvasContext: emptyContext() }, deps);
    const cards = created(result);
    expect(cards.map((c) => c.sourceData.reminderText)).toEqual(["喝水", "吃药", "拉伸"]);
    expect(new Set(cards.map((c) => c.sourceData.targetAt)).size).toBe(1);
    expect(call).not.toHaveBeenCalled();
  });
  it.each([["十分钟", 600], ["二十五分三十秒", 1530], ["一小时二十分", 4800], ["半小时", 1800], ["1.5分钟", 90], ["半分钟", 30]])("parses %s exactly", (text, seconds) => {
    expect(parseDuration(text)).toBe(seconds);
    expect(matchRules(`${text}倒计时`, emptyContext())?.actions[0]?.type).toBe("card.create");
  });
  it.each(["五分钟倒计时，然后十分钟倒计时", "五分钟后提醒我喝水和吃药", "五分钟后提醒我喝水，再创建便签", "十分钟后提醒我", "五分钟后提醒我不要吃药", "五分钟后提醒我每天喝水"])("defers the whole ambiguous instruction %s", (text) => {
    expect(matchRules(text, emptyContext())).toBeNull();
  });
  it("keeps a plain countdown and the existing todo/fit/restore/awaken rules local", () => {
    for (const text of ["十分钟倒计时", "倒计时5分30秒", "创建一个十分钟倒计时", "加待办：喝水；吃药", "显示全部", "恢复原视图", "唤醒"]) {
      expect(matchRules(text, emptyContext())).not.toBeNull();
    }
    expect(matchRules("十分钟倒计时", emptyContext())?.actions).toHaveLength(1);
  });
});

describe("compact reminder planner", () => {
  const text = "请在五分钟后提醒我喝水和吃药，十分钟后提醒我拉伸";
  const reminders = [{ afterSeconds: 300, text: "喝水" }, { afterSeconds: 300, text: "吃药" }, { afterSeconds: 600, text: "拉伸" }];
  it("uses one small payload for several tasks, without history or card templates", async () => {
    const { deps, call } = setup((init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.max_tokens).toBe(4096);
      expect(body.messages[0].content).not.toContain("CardRecord");
      expect(JSON.parse(body.messages[1].content)).toEqual({ utterance: text });
      expect(String(init?.body)).not.toContain("todo-1");
      return chatOk({ reminders });
    });
    const result = await runIntent({ text, canvasContext: context }, deps);
    expect(result.kind).toBe("envelope");
    expect(call).toHaveBeenCalledTimes(1);
    expect(created(result).map((c) => c.sourceData.reminderText)).toEqual(["喝水", "吃药", "拉伸"]);
    expect(result.envelope?.actions.at(-1)?.type).toBe("canvas.fit");
    expect(result.envelope?.actions.some((a) => a.type === "card.focus")).toBe(false);
  });
  it("accepts a single reminder and focuses its generated id", async () => {
    const { deps } = setup(() => chatOk({ reminders: [{ afterSeconds: 90, text: "喝水" }] }));
    const result = await runIntent({ text: "过一分半提醒我喝水", canvasContext: emptyContext() }, deps);
    expect(result.envelope?.actions.at(-1)).toEqual({ type: "card.focus", targetId: created(result)[0]?.id });
  });
  it("keeps all three tasks at one duration when extracted from conjunctions", async () => {
    const { deps, call } = setup(() => chatOk({ reminders: [
      { afterSeconds: 300, text: "喝水" }, { afterSeconds: 300, text: "吃药" }, { afterSeconds: 300, text: "拉伸" },
    ] }));
    const result = await runIntent({ text: "五分钟后提醒我喝水和吃药以及拉伸", canvasContext: emptyContext() }, deps);
    expect(created(result).map(c => c.sourceData.reminderText)).toEqual(["喝水", "吃药", "拉伸"]);
    expect(new Set(created(result).map(c => c.sourceData.targetAt)).size).toBe(1);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("repairs the schema exactly once without forwarding upstream content", async () => {
    let calls = 0;
    const { deps, call } = setup(init => {
      calls += 1;
      if (calls === 1) return chatOk({ reminders: [{ afterSeconds: "bad-secret-from-upstream", text: "喝水" }] });
      const body = String(init?.body);
      expect(body).toContain("校验失败");
      expect(body).not.toContain("bad-secret-from-upstream");
      return chatOk({ reminders });
    });
    expect((await runIntent({ text, canvasContext: emptyContext() }, deps)).kind).toBe("envelope");
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("rejects explicit missing items and invented task text", async () => {
    for (const plan of [reminders.slice(0, 2), [...reminders.slice(0, 2), { afterSeconds: 600, text: "发明任务" }]]) {
      const { deps, call } = setup(() => chatOk({ reminders: plan }));
      const result = await runIntent({ text: `安排三件事：${text}`, canvasContext: emptyContext() }, deps);
      expect(result.kind).toBe("clarify");
      expect(result.envelope).toBeUndefined();
      expect(call).toHaveBeenCalledTimes(2);
    }
  });
  it.each(["如果下雨，十分钟后提醒我收衣服"])("clarifies unsupported external conditions: %s", async (text) => {
    const { deps, call } = setup(() => chatOk({ clarify: "需要确认提醒条件或重复频率，可以改为一次提醒吗？" }));
    const result = await runIntent({ text, canvasContext: emptyContext() }, deps);
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("creates interval reminders without invoking a model", async () => {
    const { deps, call } = setup(() => { throw new Error("Model must not run"); });
    const result = await runIntent({ text: "每隔五分钟提醒我喝水", canvasContext: emptyContext() }, deps);
    expect(created(result)[0]?.sourceData.schedule).toEqual({ kind: "interval", everySeconds: 300 });
    expect(result.usedProvider).toBe("rules");
    expect(call).not.toHaveBeenCalled();
  });
  it("does not accept an unsupported conditional plan despite valid JSON", async () => {
    const { deps } = setup(() => chatOk({ reminders: [{ afterSeconds: 600, text: "收衣服" }] }));
    const result = await runIntent({ text: "如果下雨，十分钟后提醒我收衣服", canvasContext: emptyContext() }, deps);
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
  });
});

describe("generic planner compatibility and execution validation", () => {
  it("keeps valid focus, highlight, update, note creation and delete actions working", async () => {
    const actions: Action[] = [{ type: "card.focus", targetId: "todo-1" }, { type: "card.highlight", targetId: "todo-1", itemId: "i1" },
      { type: "card.update", targetId: "todo-1", displayProps: { items: [{ id: "i1", text: "喝水", done: true }] } },
      { type: "card.create", card: note() }, { type: "card.focus", targetId: "note-new" }, { type: "card.delete", targetId: "cd-1" }];
    const { deps } = setup(() => chatOk({ actions, spokenText: "已处理" }));
    const result = await runIntent({ text: "标记喝水完成，记个便签再删倒计时", canvasContext: context }, deps);
    expect(result.envelope?.actions).toEqual(actions);
  });
  it("can focus and delete an existing rendered search result", async () => {
    const { deps } = setup(() => chatOk({ actions: [{ type: "card.focus", targetId: "search-1" }, { type: "card.delete", targetId: "search-1" }] }));
    const result = await runIntent({ text: "看看搜索结果然后删掉", canvasContext: emptyContext([{ id: "search-1", type: "SearchResultCard", displayProps: {}, sourceDataSummary: {}, layout: { x: 0, y: 0 } }]) }, deps);
    expect(result.kind).toBe("envelope");
  });
  it.each([
    [{ type: "card.focus", targetId: "missing" }],
    [{ type: "card.delete", targetId: "missing" }],
    [{ type: "card.delete", targetId: "cd-1" }, { type: "card.focus", targetId: "cd-1" }],
    [{ type: "card.highlight", targetId: "todo-1", itemId: "missing" }],
    [{ type: "card.update", targetId: "cd-1", displayProps: { title: "forbidden" } }],
    [{ type: "card.update", targetId: "todo-1", displayProps: { tempC: 30 } }],
    [{ type: "canvas.switch", canvasId: "unknown" }],
    [{ type: "card.create", card: note("cd-1") }],
  ])("rejects invalid target/action batch %j atomically", async (...actions) => {
    const { deps, call } = setup(() => chatOk({ actions }));
    const result = await runIntent({ text: "按这个要求处理画布", canvasContext: context }, deps);
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
    expect(call).toHaveBeenCalledTimes(2);
  });
  it.each([
    { type: "WeatherCard", displayProps: { tempC: 25, conditionIcon: "sun" } },
    { type: "TableCard", displayProps: { columns: ["x"], rows: [[1]] } },
    { type: "ChartCard", displayProps: { chartKind: "line", points: [{ x: 1, y: 2 }] } },
    { type: "SearchResultCard", displayProps: { title: "fake", summary: "fake", sourceLabel: "fake" }, sources: [{ title: "fake", url: "https://example.com", fetchedAt: "2026-10-15T00:00:00.000Z", provider: "fake", readFullPage: false }] },
  ])("rejects fabricated or unrendered $type data even when contract-valid", async (fields) => {
    const { deps } = setup(() => chatOk({ actions: [{ type: "card.create", card: { ...note(), ...fields } }] }));
    expect((await runIntent({ text: "查资料并生成信息卡", canvasContext: emptyContext() }, deps)).kind).toBe("clarify");
    expect(buildSystemPrompt()).toContain("actions 中禁止创建或修改 WeatherCard、TableCard、SearchResultCard");
    expect(buildSystemPrompt()).toContain("ChartCard 只能经场景卡片 data_visualization 用用户给出的数值生成");
  });
  it("fits multi-card generic batches instead of focusing each card", async () => {
    const { deps } = setup(() => chatOk({ actions: [{ type: "card.create", card: note("n1") }, { type: "card.focus", targetId: "n1" },
      { type: "card.create", card: note("n2") }, { type: "card.focus", targetId: "n2" }] }));
    const result = await runIntent({ text: "建两个便签", canvasContext: emptyContext() }, deps);
    expect(result.envelope?.actions.map(a => a.type)).toEqual(["card.create", "card.create", "canvas.fit"]);
  });
  it("explicit compound clarification never executes accompanying actions", async () => {
    const { deps } = setup(() => chatOk({ actions: [{ type: "card.delete", targetId: "cd-1" }], clarify: "还要创建哪个提醒？" }));
    const result = await runIntent({ text: "删掉这个然后提醒那个", canvasContext: context }, deps);
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
  });
});

describe("request cancellation, retries and wall-clock deadlines", () => {
  it("a pre-cancelled request executes neither rules nor planner", async () => {
    const controller = new AbortController();
    controller.abort(new Error(`private reason ${KEY}`));
    const { deps, call } = setup(() => chatOk({ actions: [{ type: "canvas.fit" }] }));
    const result = await runIntent({ text: "十分钟倒计时", canvasContext: emptyContext() }, deps, controller.signal);
    expect(result.kind).toBe("error");
    expect(result.message).toContain("取消");
    expect(result.envelope).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(call).not.toHaveBeenCalled();
  });
  it("propagates cancellation to fetch and discards even a late successful reply", async () => {
    const controller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    let resolveFetch: (response: Response) => void = () => {};
    const { deps, call } = setup(init => {
      fetchSignal = init?.signal ?? undefined;
      return new Promise(resolve => { resolveFetch = resolve; });
    });
    const pending = runIntent({ text: "帮我看看画布", canvasContext: emptyContext() }, deps, controller.signal);
    await vi.waitFor(() => expect(fetchSignal).toBeDefined());
    controller.abort(`private ${KEY}`);
    const result = await pending;
    expect(fetchSignal?.aborted).toBe(true);
    expect(result.kind).toBe("error");
    expect(result.message).toContain("取消");
    expect(result.envelope).toBeUndefined();
    resolveFetch(chatOk({ actions: [{ type: "canvas.fit" }] }));
    await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
  it("cancellation before a schema repair prevents the second request", async () => {
    const controller = new AbortController();
    const { deps, call } = setup(() => chatOk({ actions: [{ type: "nonsense" }] }));
    const result = await runIntent({ text: "处理画布", canvasContext: emptyContext() }, {
      ...deps, onPlannerCall: attempt => { if (attempt === 2) controller.abort(); },
    }, controller.signal);
    expect(result.kind).toBe("error");
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("credentials changed while waiting discard all generated actions", async () => {
    const { deps } = setup(() => {
      deps.credentials.clear();
      return chatOk({ actions: [{ type: "canvas.fit" }] });
    });
    const result = await runIntent({ text: "处理画布", canvasContext: emptyContext() }, deps);
    expect(result.kind).toBe("error");
    expect(result.message).toContain("连接已变更");
    expect(result.envelope).toBeUndefined();
  });
  it.each([[401, 1], [403, 1], [400, 1], [429, 2], [500, 2], [502, 2], [503, 2]])("provider HTTP %i is sent %i time(s): only transient statuses are retried once", async (status, times) => {
    const { deps, call } = setup(() => Response.json({ error: { message: `key ${KEY}`, code: "denied" } }, { status, headers: { "x-trace-id": "safe-trace" } }));
    const result = await runIntent({ text: "处理画布", canvasContext: emptyContext() }, deps);
    expect(result.kind).toBe("error");
    expect(call).toHaveBeenCalledTimes(times);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result.message).toContain("safe-trace");
  });
  it("retries a transport error exactly once", async () => {
    const { deps, call } = setup(() => { throw new Error(`Authorization: Bearer ${KEY}`); });
    const result = await runIntent({ text: "处理画布", canvasContext: emptyContext() }, deps);
    expect(result.kind).toBe("error");
    expect(call).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
  it("a dropped connection that recovers on the retry still plans", async () => {
    let count = 0;
    const { deps, call } = setup(() => { if (++count === 1) throw new TypeError("fetch failed"); return chatOk({ actions: [{ type: "canvas.fit" }] }); });
    expect((await runIntent({ text: "处理画布", canvasContext: emptyContext() }, deps)).kind).toBe("envelope");
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("honours a short Retry-After before the single retry", async () => {
    vi.useFakeTimers();
    let count = 0;
    const { deps, call } = setup(() => ++count === 1
      ? Response.json({ error: { message: "busy" } }, { status: 429, headers: { "retry-after": "2" } })
      : chatOk({ actions: [{ type: "canvas.fit" }] }));
    const pending = runIntent({ text: "处理画布", canvasContext: emptyContext() }, deps);
    await vi.advanceTimersByTimeAsync(1999);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).kind).toBe("envelope");
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("accepts JSON wrapped in a code fence", async () => {
    const { deps } = setup(() => Response.json({ choices: [{ message: { content: "```json\n{\"actions\":[{\"type\":\"canvas.fit\"}]}\n```" } }] }));
    expect((await runIntent({ text: "处理画布", canvasContext: emptyContext() }, deps)).kind).toBe("envelope");
  });
  it("invalid JSON can be repaired once", async () => {
    let count = 0;
    const { deps, call } = setup(() => ++count === 1
      ? Response.json({ choices: [{ message: { content: "{broken" } }] })
      : chatOk({ actions: [{ type: "canvas.fit" }] }));
    expect((await runIntent({ text: "处理画布", canvasContext: emptyContext() }, deps)).kind).toBe("envelope");
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("uses 60s inference by default and never retries a timeout", async () => {
    vi.useFakeTimers();
    let upstream: AbortSignal | undefined;
    const { deps, call } = setup(init => { upstream = init?.signal ?? undefined; return new Promise(() => {}); });
    let settled = false;
    const pending = runIntent({ text: "处理画布", canvasContext: emptyContext() }, deps).then(r => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).message).toContain("超时");
    expect(upstream?.aborted).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("response body reads share the deadline even after headers arrived", async () => {
    vi.useFakeTimers();
    let upstream: AbortSignal | undefined;
    const { deps, call } = setup(init => {
      upstream = init?.signal ?? undefined;
      const response = chatOk({ actions: [{ type: "canvas.fit" }] });
      vi.spyOn(response, "text").mockImplementation(() => new Promise(() => {}));
      return response;
    });
    const pending = runIntent({ text: "处理画布", canvasContext: emptyContext() }, { ...deps, stepfun: { ...deps.stepfun, timeoutMs: 70 } });
    await vi.advanceTimersByTimeAsync(70);
    const result = await pending;
    expect(result.kind).toBe("error");
    expect(result.message).toContain("超时");
    expect(upstream?.aborted).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("two schema attempts share a hard 90s maximum even with larger overrides", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    let lastSignal: AbortSignal | undefined;
    const { deps, call } = setup(init => {
      attempts += 1;
      lastSignal = init?.signal ?? undefined;
      if (attempts === 1) return new Promise(resolve => setTimeout(() => resolve(chatOk({ actions: [{ type: "nonsense" }] })), 60_000));
      return new Promise(() => {});
    });
    let settled = false;
    const pending = runIntent({ text: "处理画布", canvasContext: emptyContext() }, { ...deps, stepfun: { ...deps.stepfun, timeoutMs: 200_000 } })
      .then(r => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(call).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).message).toContain("超时");
    expect(lastSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("honors a smaller inference override without falling back or retrying", async () => {
    vi.useFakeTimers();
    const { deps, call } = setup(() => new Promise(() => {}));
    const pending = runIntent({ text: "处理画布", canvasContext: emptyContext() }, { ...deps, stepfun: { ...deps.stepfun, timeoutMs: 20 } });
    await vi.advanceTimersByTimeAsync(20);
    expect((await pending).kind).toBe("error");
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("connection metadata and probe share one 30s budget", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let probeSignal: AbortSignal | undefined;
    const pending = validateConnection(KEY, { baseUrl: "https://unit.test/v1", fetchImpl: fetchStub({
      "/models": () => new Promise(resolve => setTimeout(() => resolve(modelsOk(["step-3.5-flash"])), 20_000)),
      "/chat/completions": init => { probeSignal = init?.signal ?? undefined; return new Promise(() => {}); },
    }, url => calls.push(url)) });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ ok: false, code: "timeout" });
    expect(probeSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a cancelled connection does not launch a generation probe", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const result = await validateConnection(KEY, { baseUrl: "https://unit.test/v1", signal: controller.signal, fetchImpl: fetchStub({
      "/models": () => { controller.abort(KEY); return modelsOk(["step-3.5-flash"]); },
    }, url => calls.push(url)) });
    expect(result).toMatchObject({ ok: false, code: "cancelled" });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
  it("StepfunDeps.signal works directly for both chat and metadata", async () => {
    const controller = new AbortController();
    controller.abort(new Error(KEY));
    const fetchImpl = vi.fn<typeof fetch>();
    const deps = { baseUrl: "https://unit.test/v1", fetchImpl, signal: controller.signal };
    expect(await chatJson(credential, [], deps)).toMatchObject({ ok: false, code: "cancelled" });
    expect(await validateKey(KEY, deps)).toMatchObject({ ok: false, code: "cancelled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["step-3.5-flash", "step-3.5-flash-2603", "step-3.7-flash", "step-3", "step-router-v1", "step-5-preview"])("sends only officially confirmed low reasoning parameters for %s", async model => {
    const fetchImpl = fetchStub({ "/chat/completions": init => {
      const body = JSON.parse(String(init?.body));
      if (["step-3.5-flash-2603", "step-3.7-flash"].includes(model)) expect(body.reasoning_effort).toBe("low");
      else expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("thinking");
      expect(body).not.toHaveProperty("enable_thinking");
      return chatOk({ ok: true });
    } });
    expect((await chatJson({ ...credential, defaultModel: model }, [], { baseUrl: "https://unit.test/v1", fetchImpl })).ok).toBe(true);
  });
});

describe("scheduler notification stamp ownership", () => {
  it("does not let the planner mark an existing countdown as notified", async () => {
    const { deps } = setup(() => chatOk({ actions: [{ type: "card.update", targetId: "cd-1", sourceData: {
      notifiedAt: "2026-10-15T00:00:00.000Z",
    } }] }));
    const result = await runIntent({ text: "处理这个提醒", canvasContext: context }, deps);
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
  });
  it("strips model-written notifiedAt on new countdowns", async () => {
    const { deps } = setup(() => chatOk({ actions: [{ type: "card.create", card: {
      ...note(), type: "CountdownCard", displayProps: {}, sourceData: { targetAt: "2026-10-15T10:00:00.000Z", notifiedAt: "2026-10-15T00:00:00.000Z" },
    } }] }));
    const result = await runIntent({ text: "加个计时卡", canvasContext: emptyContext() }, deps);
    expect(result.kind).toBe("envelope");
    expect(created(result)[0]?.sourceData).not.toHaveProperty("notifiedAt");
  });
  it("resets notifiedAt when changing targetAt", async () => {
    const { deps } = setup(() => chatOk({ actions: [{ type: "card.update", targetId: "cd-1", sourceData: {
      targetAt: "2026-10-15T11:00:00.000Z", notifiedAt: "2026-10-15T00:00:00.000Z",
    } }] }));
    const result = await runIntent({ text: "修改倒计时时间", canvasContext: context }, deps);
    expect(result.envelope?.actions).toEqual([{ type: "card.update", targetId: "cd-1", sourceData: {
      targetAt: "2026-10-15T11:00:00.000Z", notifiedAt: null,
    } }]);
  });
});
