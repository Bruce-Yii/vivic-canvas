import { describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema, HostOperationSchema } from "@vivic/contracts";
import { DecisionTaskManager } from "../src/decision/taskV2.js";
import { DEFAULT_NATIVE_GATE, HttpNativeV2Provider, acceptedNativeChoice, parseNativeAnswers, type NativeQuestion, type NativeV2Provider } from "../src/decision/nativeV2.js";
import { hostOperationIssue, exactHostOperation } from "../src/decision/hostOperations.js";
import { IntentResponseSchema } from "../src/schemas.js";
import type { IntentRequest, IntentResult } from "../src/intent/pipeline.js";
import { authed, emptyContext, testConfig } from "./helpers.js";
import { createApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import { chatOk, fetchStub } from "./helpers.js";

// All scores below are synthetic protocol fixtures, never a quality evaluation.
const answer = (criteria: Record<string, string>, choice: string) => ({ type: "choice" as const, choice,
  probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === choice ? .99 : .01 / Math.max(1, Object.keys(criteria).length - 1)])), none_probability: .001 });
function scripted(select: (key: string, state: Record<string, any>, criteria: Record<string, string>) => string): NativeV2Provider & { decide: ReturnType<typeof vi.fn> } {
  return { decide: vi.fn(async (state: unknown, questions: Record<string, NativeQuestion>) => ({ ok: true as const,
    answers: Object.fromEntries(Object.entries(questions).map(([key, q]) => [key, answer(q.criteria, select(key, state as Record<string, any>, q.criteria))])) })) };
}
const note = (id: string, text = "同名便笺", x = 0) => ({ id, type: "NoteCard", displayProps: { text }, sourceDataSummary: {}, layout: { x, y: 0, width: 320, height: 200, pinned: false } });
const context = () => ({ ...emptyContext([note("note-1"), note("note-2", "同名便笺", 400)]), version: 7, totalCardCount: 2, selectedCardIds: ["note-1"] });
const req = (text = "聚焦左边便笺", id = "task-test"): IntentRequest => ({ text, canvasContext: context(), task: { id } });
const legacy = vi.fn(async (): Promise<IntentResult> => ({ kind: "unknown", message: "未配置主模型" }));
const manager = (provider: NativeV2Provider, extra: ConstructorParameters<typeof DecisionTaskManager>[0] = {}) => new DecisionTaskManager({ provider, gate: { executionEnabled: true }, ...extra });
const focusChoices = (key: string, state: Record<string, any>) => ({ next_step: state.phase === "after_execution" ? "finish" : "resolve", operation: "card.focus", target: "note-1", authorization: "authorized", goal_coverage: "complete" }[key]!);

describe("independent native v2 adapter", () => {
  it("preserves native distributions and refuses absent/contradictory scores", () => {
    const questions = { next: { type: "choice" as const, instructions: "选择", criteria: { a: "A", b: "B" } } };
    expect(parseNativeAnswers({ answers: { next: answer(questions.next.criteria, "a") } }, questions).ok).toBe(true);
    expect(parseNativeAnswers({ answers: { next: { ...answer(questions.next.criteria, "a"), choice: "b" } } }, questions).ok).toBe(false);
    expect(parseNativeAnswers({ answers: { next: { type: "choice", choice: "a" } } }, questions).ok).toBe(false);
    expect(acceptedNativeChoice({ ...answer(questions.next.criteria, "a"), none_probability: .7 }, DEFAULT_NATIVE_GATE)).toBeNull();
  });
  it("posts genuine native questions and never chat JSON/action instructions", async () => {
    const transport = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); expect(body.state.protocol_version).toBe("vivic-decision-v2"); expect(body.messages).toBeUndefined();
      expect(body.questions.operation.type).toBe("choice");
      return Response.json({ answers: { operation: answer(body.questions.operation.criteria, "focus") } });
    });
    const provider = new HttpNativeV2Provider("https://native.example/decide", { fetchImpl: transport as typeof fetch });
    expect((await provider.decide({ protocol_version: "vivic-decision-v2" }, { operation: { type: "choice", instructions: "选择", criteria: { focus: "聚焦", noop: "不操作" } } })).ok).toBe(true);
  });
  it("bounds a transport that ignores cancellation", async () => {
    const provider = new HttpNativeV2Provider("https://native.example/decide", { timeoutMs: 5, fetchImpl: (() => new Promise(() => {})) as typeof fetch });
    expect(await provider.decide({}, { q: { type: "choice", instructions: "选择", criteria: { a: "A" } } })).toEqual({ ok: false, reason: "native_timeout" });
  });
});

describe("versioned decision task execution", () => {
  it("runs decision before legacy, awaits a real receipt, and deduplicates it", async () => {
    const provider = scripted(focusChoices), tasks = manager(provider), fallback = vi.fn(legacy);
    const request = req(), first = await tasks.run(request, { legacy: fallback });
    expect(first.kind).toBe("envelope"); expect(first.task?.status).toBe("awaiting_execution"); expect(first.task?.canvasVersion).toBe(7);
    expect(first.envelope?.actions).toEqual([{ type: "card.focus", targetId: "note-1" }]); expect(fallback).not.toHaveBeenCalled();
    expect(await tasks.run(request, { legacy: fallback })).toEqual(first);
    const receipt = { executionId: first.task!.executionId!, status: "succeeded" as const };
    const complete = await tasks.run({ ...request, task: { id: request.task!.id, receipt }, canvasContext: { ...request.canvasContext, version: 8 } }, { legacy: fallback });
    expect(complete.task?.status).toBe("completed");
    const afterExecution = provider.decide.mock.calls.at(-1)?.[0] as { observations: Array<{ kind: string; result: unknown }> };
    expect(afterExecution.observations.find(observation => observation.kind === "execution")?.result).toMatchObject({ operation: { actions: [{ type: "card.focus", targetId: "note-1" }] } });
    const calls = provider.decide.mock.calls.length;
    expect(await tasks.run({ ...request, task: { id: request.task!.id, receipt } }, { legacy: fallback })).toEqual(complete);
    expect(provider.decide).toHaveBeenCalledTimes(calls);
  });
  it("retains frozen candidate numbering after a reorder", async () => {
    const provider = scripted((key, state) => key === "target" ? "ambiguous" : focusChoices(key, state));
    const tasks = manager(provider), request = req("聚焦那个便笺"), first = await tasks.run(request, { legacy });
    expect(first.task?.clarification?.candidates[1]?.id).toBe("note-2");
    const second = await tasks.run({ ...request, text: "2号", canvasContext: { ...request.canvasContext, cards: [...request.canvasContext.cards].reverse() } }, { legacy });
    expect(second.envelope?.actions).toEqual([{ type: "card.focus", targetId: "note-2" }]);
  });
  it("does not accept the wrong receipt or a failed execution", async () => {
    const tasks = manager(scripted(focusChoices)), request = req(), first = await tasks.run(request, { legacy });
    expect((await tasks.run({ ...request, task: { id: request.task!.id, receipt: { executionId: "wrong", status: "succeeded" } } }, { legacy })).kind).toBe("error");
    const failed = await tasks.run({ ...request, task: { id: request.task!.id, receipt: { executionId: first.task!.executionId!, status: "failed", error: "保存失败" } } }, { legacy });
    expect(failed.task?.status).toBe("failed"); expect(failed.message).toContain("保存失败");
  });
  it("cancels in-flight work and discards a late native result", async () => {
    let resolve!: (value: any) => void;
    const provider = { decide: vi.fn(() => new Promise<any>(done => { resolve = done; })) };
    const tasks = manager(provider), request = req(), running = tasks.run(request, { legacy });
    await vi.waitFor(() => expect(provider.decide).toHaveBeenCalled());
    const cancelled = await tasks.run({ ...request, task: { id: request.task!.id, cancel: true } }, { legacy });
    expect(cancelled.task?.status).toBe("cancelled");
    resolve({ ok: false, reason: "late" });
    expect((await running).task?.status).toBe("cancelled");
  });
  it("rejects finish claims before execution and prevents loops", async () => {
    const tasks = manager(scripted(() => "finish"));
    expect((await tasks.run(req(), { legacy })).task?.status).toBe("failed");
  });
  it("refuses to treat a truncated card list as the entire canvas", async () => {
    const provider = scripted(key => key === "next_step" ? "resolve" : "cards.delete"), tasks = manager(provider);
    const result = await tasks.run({ ...req("删除全部卡片"), canvasContext: { ...context(), totalCardCount: 20 } }, { legacy });
    expect(result.kind).toBe("clarify"); expect(result.envelope).toBeUndefined();
    expect(provider.decide.mock.calls[0]?.[0]).toMatchObject({ context_complete: false });
    expect(provider.decide.mock.calls.some(([, questions]) => Object.hasOwn(questions, "delete_scope"))).toBe(false);
  });
  it("accepts the legacy complete snapshot with no total only after explicit all-delete authorization", async () => {
    const choices: Record<string, string> = { next_step: "resolve", operation: "cards.delete", delete_scope: "all", authorization: "authorized", goal_coverage: "complete" };
    const provider = scripted(key => choices[key]!), tasks = manager(provider);
    const { totalCardCount: _total, ...complete } = context();
    const result = await tasks.run({ ...req("删除全部卡片"), canvasContext: complete }, { legacy });
    expect(provider.decide.mock.calls[0]?.[0]).toMatchObject({ context_complete: true });
    expect(result.task?.status).toBe("awaiting_execution");
    expect(result.envelope?.actions).toEqual([{ type: "cards.delete", targetIds: ["note-1", "note-2"] }]);
    expect(provider.decide.mock.calls.some(([, questions]) => Object.hasOwn(questions, "delete_scope"))).toBe(true);
  });
  it("does not turn a complete snapshot into blanket deletion when the user scope is ambiguous", async () => {
    const choices: Record<string, string> = { next_step: "resolve", operation: "cards.delete", delete_scope: "ambiguous" };
    const { totalCardCount: _total, ...complete } = context();
    const result = await manager(scripted(key => choices[key]!)).run({ ...req("删除那个卡片"), canvasContext: complete }, { legacy });
    expect(result.kind).toBe("clarify"); expect(result.envelope).toBeUndefined();
  });
  it("creates a reminder with native span choices and no main LLM", async () => {
    const text = "十五分钟后提醒我喝水";
    const mapping: Record<string, string> = { next_step: "resolve", operation: "countdown.create", countdown_mode: "reminder", time_expression_start: "p0", time_expression_end: "p5", reminder_text_start: "p8", reminder_text_end: "p10", authorization: "authorized", goal_coverage: "complete" };
    const tasks = manager(scripted(key => mapping[key]!)), fallback = vi.fn(legacy), result = await tasks.run(req(text), { legacy: fallback });
    expect(result.kind).toBe("envelope"); const card = result.envelope?.actions.find(action => action.type === "card.create");
    expect(card?.type === "card.create" && card.card.type === "CountdownCard" && card.card.sourceData.reminderText).toBe("喝水");
    if (card?.type === "card.create" && card.card.type === "CountdownCard") expect(Date.parse(String(card.card.sourceData.targetAt)) - Date.parse(String(card.card.sourceData.startedAt))).toBe(900_000);
    expect(fallback).not.toHaveBeenCalled();
  });
  it("requires missing user time instead of inventing it with an LLM", async () => {
    const mapping: Record<string, string> = { next_step: "resolve", operation: "countdown.create", countdown_mode: "reminder", time_expression_start: "missing" };
    const fallback = vi.fn(legacy), tasks = manager(scripted(key => mapping[key]!));
    expect((await tasks.run(req("提醒我喝水"), { legacy: fallback })).kind).toBe("clarify"); expect(fallback).not.toHaveBeenCalled();
  });
  it("resumes a missing time while retaining the reminder text from the original message", async () => {
    const provider = scripted((key, state) => {
      const followup = state.user_message === "十五分钟后";
      return ({ next_step: "resolve", operation: "countdown.create", countdown_mode: "reminder", time_expression_source: "current",
        time_expression_start: followup ? "p0" : "missing", time_expression_end: "p5", reminder_text_source: "original", reminder_text_start: "p3", reminder_text_end: "p5", authorization: "authorized", goal_coverage: "complete" } as Record<string,string>)[key]!;
    });
    const tasks = manager(provider), request = req("提醒我喝水");
    expect((await tasks.run(request, { legacy })).kind).toBe("clarify");
    const result = await tasks.run({ ...request, text: "十五分钟后" }, { legacy });
    const action = result.envelope?.actions.find(action => action.type === "card.create");
    expect(action?.type === "card.create" && action.card.type === "CountdownCard" && action.card.sourceData.reminderText).toBe("喝水");
  });
  it("lets a user cancel while answering a missing-time question", async () => {
    const provider = scripted((key, state) => state.user_message === "算了不要了" ? "noop" : ({ next_step: "resolve", operation: "countdown.create", countdown_mode: "reminder", time_expression_start: "missing" } as Record<string,string>)[key]!);
    const tasks = manager(provider), request = req("提醒我喝水");
    expect((await tasks.run(request, { legacy })).kind).toBe("clarify");
    const result = await tasks.run({ ...request, text: "算了不要了" }, { legacy });
    expect(result.task?.status).toBe("cancelled"); expect(result.envelope).toBeUndefined();
  });
  it("does not promote new-card plans to success without matching created IDs in the receipt", async () => {
    const mapping: Record<string,string> = { next_step: "resolve", operation: "note.create", content_start: "p3", content_end: "p5", authorization: "authorized", goal_coverage: "complete" };
    const tasks = manager(scripted(key => mapping[key]!)), request = req("记便笺喝水"), first = await tasks.run(request, { legacy });
    expect(first.task?.status).toBe("awaiting_execution");
    const result = await tasks.run({ ...request, task: { id: request.task!.id, receipt: { executionId: first.task!.executionId!, status: "succeeded", createdCardIds: [] } } }, { legacy });
    expect(result.kind).toBe("error"); expect(result.task?.status).toBe("awaiting_execution");
  });
  it("rejects receipt contexts older than the proposed canvas version", async () => {
    const tasks = manager(scripted(focusChoices)), request = req(), first = await tasks.run(request, { legacy });
    const result = await tasks.run({ ...request, canvasContext: { ...request.canvasContext, version: 6 }, task: { id: request.task!.id, receipt: { executionId: first.task!.executionId!, status: "succeeded" } } }, { legacy });
    expect(result.kind).toBe("error"); expect(result.task?.status).toBe("awaiting_execution");
  });
  it("expires tasks without replaying a pending action", async () => {
    let now = 0;
    const tasks = manager(scripted(focusChoices), { now: () => now, ttlMs: 10 }), request = req();
    await tasks.run(request, { legacy }); now = 20;
    const result = await tasks.run(request, { legacy }); expect(result.task?.status).toBe("failed"); expect(result.envelope).toBeUndefined();
  });
  it("bounds total task time even when the native provider ignores the abort signal", async () => {
    const tasks = manager({ decide: () => new Promise(() => {}) }, { maxActiveMs: 5 });
    expect((await tasks.run(req(), { legacy })).task?.status).toBe("failed");
  });
  it("preserves affirmative focus in a negated compound command", async () => {
    const result = await manager(scripted(focusChoices)).run(req("不要删除，聚焦它"), { legacy });
    expect(result.envelope?.actions).toEqual([{ type: "card.focus", targetId: "note-1" }]);
  });
  it("quoted destructive text can go to an explanation with no delete", async () => {
    const provider = scripted((key, state) => key === "next_step" ? state.phase === "after_llm" ? "execute" : "llm" : key === "llm_subtask" ? "explain" : "complete");
    const envelope = ActionEnvelopeSchema.parse({ schemaVersion: "0.6", requestId: "explain-1", canvasId: "c1", actions: [{ type: "subtitle.show", text: "这是删除指令的含义" }] });
    const result = await manager(provider).run(req("解释‘删除全部卡片’"), { legacy: async () => ({ kind: "envelope", envelope, usedProvider: "stepfun" }) });
    expect(result.envelope?.actions.every(action => action.type !== "card.delete" && action.type !== "cards.delete")).toBe(true);
  });
  it("carries LLM output back to decision, then creates and moves using the received ID", async () => {
    const envelope = ActionEnvelopeSchema.parse({ schemaVersion: "0.6", requestId: "plan-create", canvasId: "c1", actions: [{ type: "card.create", card: {
      id: "created-note", type: "NoteCard", variant: "minimal", displayProps: { text: "整理结果" }, sourceData: {}, sources: [], layout: { x: 0, y: 0, width: 320, height: 200, pinned: false }, metadata: { createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:00Z" },
    } }] });
    const provider = scripted((key, state) => {
      if (key === "next_step") return state.phase === "after_llm" ? "execute" : state.phase === "after_execution" ? state.completed_steps.length === 1 ? "resolve" : "finish" : "llm";
      return ({ llm_subtask: "content", goal_coverage: state.completed_steps.length ? "complete" : "partial", operation: "card.move", target: "created-note", direction: "right", relative_to: "viewport", authorization: "authorized" } as Record<string,string>)[key]!;
    });
    const tasks = manager(provider), request = req("整理成便笺并移到右侧"), llm = vi.fn(async (): Promise<IntentResult> => ({ kind: "envelope", envelope, usedProvider: "stepfun" }));
    const first = await tasks.run(request, { legacy: llm });
    expect(first.task?.status).toBe("awaiting_execution"); expect(llm).toHaveBeenCalledTimes(1);
    const created = { ...request.canvasContext, version: 8, cards: [...request.canvasContext.cards, note("created-note", "整理结果")], totalCardCount: 3 };
    const second = await tasks.run({ ...request, canvasContext: created, task: { id: request.task!.id, receipt: { executionId: first.task!.executionId!, status: "succeeded", createdCardIds: ["created-note"] } } }, { legacy: llm });
    expect(second.hostOperation).toEqual({ kind: "card.move", targetId: "created-note", direction: "right" });
    const final = await tasks.run({ ...request, canvasContext: { ...created, version: 9 }, task: { id: request.task!.id, receipt: { executionId: second.task!.executionId!, status: "succeeded" } } }, { legacy: llm });
    expect(final.task?.status).toBe("completed"); expect(llm).toHaveBeenCalledTimes(1);
  });
  it("records a real service failure without fabricating data", async () => {
    const choices: Record<string, string> = { next_step: "tool", service: "weather", city_start: "p0", city_end: "p2" };
    const service = vi.fn(async (): Promise<IntentResult> => ({ kind: "error", message: "天气服务超时" }));
    const result = await manager(scripted(key => choices[key]!)).run(req("北京天气"), { legacy, tools: { weather: service } });
    expect(result.task?.status).toBe("failed"); expect(result.envelope).toBeUndefined(); expect(service).toHaveBeenCalledWith("北京", expect.anything(), expect.any(AbortSignal));
  });
  it("makes the untrained quality gate and compatibility rules explicit", async () => {
    const provider = scripted(focusChoices), tasks = new DecisionTaskManager({ provider });
    const result = await tasks.run(req("撤销"), { legacy });
    expect(result.hostOperation).toEqual({ kind: "history.undo" }); expect(result.usedProvider).toBe("rules");
    expect(result.task?.reason).toBe("v2_quality_gate_disabled"); expect(provider.decide).not.toHaveBeenCalled();
  });
  it("rejects movement of pinned cards and pauses of date/conditional reminders", () => {
    expect(hostOperationIssue({ kind: "card.move", targetId: "note-1", direction: "left" }, { ...context(), cards: [{ ...note("note-1"), layout: { ...note("note-1").layout, pinned: true } }] })).not.toBeNull();
    const timer = { ...note("timer"), type: "CountdownCard", sourceDataSummary: { targetAt: "2026-11-01T00:00:00Z", event: { title: "生日" } } };
    expect(hostOperationIssue({ kind: "countdown.pause", targetId: "timer" }, emptyContext([timer]))).not.toBeNull();
    expect(exactHostOperation("解释‘撤销’")).toBeNull(); expect(exactHostOperation("不要撤销")).toBeNull();
  });
  it("keeps the host union separate from the legacy envelope", () => {
    expect(HostOperationSchema.safeParse({ kind: "card.move", targetId: "n", direction: "left", x: 10 }).success).toBe(false);
    expect(IntentResponseSchema.safeParse({ kind: "host-operation", hostOperation: { kind: "history.undo" }, envelope: { schemaVersion: "0.6", requestId: "x", canvasId: "c1", actions: [{ type: "canvas.fit" }] } }).success).toBe(false);
  });
  it("connects the native task and receipt through the actual API in online mode", async () => {
    const provider = scripted(focusChoices);
    const app = createApp({ config: testConfig({ decisionV2ExecutionEnabled: true }), mode: "online", decisionV2Provider: provider });
    const first = await app.request("/api/intent", { method: "POST", headers: authed, body: JSON.stringify(req()) });
    const result = IntentResponseSchema.parse(await first.json()); expect(result.usedProvider).toBe("decision");
    const receipt = await app.request("/api/intent", { method: "POST", headers: authed, body: JSON.stringify({ ...req(), task: { id: result.task!.id, receipt: { executionId: result.task!.executionId!, status: "succeeded" } } }) });
    expect((await receipt.json()).task.status).toBe("completed"); app.dispose();
  });
  it("connects a validated main-model host operation through the fallback API", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "synthetic-unit-key", models: ["step-3"], defaultModel: "step-3", checkedAt: new Date().toISOString() });
    const app = createApp({ config: testConfig(), credentials, fetchImpl: fetchStub({ "/chat/completions": () => chatOk({ hostOperation: { kind: "card.pin", targetId: "note-1", pinned: true } }) }) });
    const response = await app.request("/api/intent", { method: "POST", headers: authed, body: JSON.stringify(req("将左边的笔记固定住")) });
    const result = IntentResponseSchema.parse(await response.json());
    expect(result.hostOperation).toEqual({ kind: "card.pin", targetId: "note-1", pinned: true }); expect(result.usedProvider).toBe("stepfun");
    expect(result.task?.decision).toBe("legacy-fallback"); expect(result.task?.status).toBe("awaiting_execution"); app.dispose();
  });
  it("normalizes the observed live NoteCard-under-cards format through the original action checks", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "synthetic-unit-key", models: ["step-3"], defaultModel: "step-3", checkedAt: new Date().toISOString() });
    const card = { id: "note-1", type: "NoteCard", variant: "standard", displayProps: { text: "周五交付界面评审材料" }, sourceData: {}, sources: [], layout: { x: 0, y: 0, width: 264, height: 120, pinned: false }, metadata: { createdAt: "2026-10-23T14:26:39.265Z", updatedAt: "2026-10-23T14:26:39.265Z" } };
    const app = createApp({ config: testConfig(), credentials, fetchImpl: fetchStub({ "/chat/completions": () => chatOk({ cards: [card], spokenText: "已创建便笺" }) }) });
    const response = await app.request("/api/intent", { method: "POST", headers: authed, body: JSON.stringify({ ...req("创建便笺，内容是：周五交付界面评审材料。"), canvasContext: { ...emptyContext(), version: 0, totalCardCount: 0 } }) });
    const result = IntentResponseSchema.parse(await response.json());
    expect(result.envelope?.actions).toContainEqual({ type: "card.create", card }); app.dispose();
  });
  it("does not use core-card format normalization to bypass scene-only data validation", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "synthetic-unit-key", models: ["step-3"], defaultModel: "step-3", checkedAt: new Date().toISOString() });
    const app = createApp({ config: testConfig(), credentials, fetchImpl: fetchStub({ "/chat/completions": () => chatOk({ cards: [{ id: "fake-weather", type: "WeatherCard", variant: "standard", displayProps: { location: "虚构地点", tempC: 99, condition: "sun" }, sourceData: {}, sources: [], layout: { x: 0, y: 0, width: 264, height: 120, pinned: false }, metadata: { createdAt: "2026-10-23T14:26:39.265Z", updatedAt: "2026-10-23T14:26:39.265Z" } }] }) }) });
    const response = await app.request("/api/intent", { method: "POST", headers: authed, body: JSON.stringify({ ...req("根据这些资料创建一个卡片"), canvasContext: emptyContext() }) });
    const result = IntentResponseSchema.parse(await response.json());
    expect(result.kind).toBe("clarify"); expect(result.envelope).toBeUndefined(); app.dispose();
  });
});
