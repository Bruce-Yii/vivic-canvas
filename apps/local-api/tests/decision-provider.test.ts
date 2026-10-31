import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DECISION_ACTIONS } from "../src/decision/intent.js";
import { DecisionRouter, HttpDecisionProvider, decisionEndpoint, decisionRequest, parseDecisionPrediction,
  type DecisionProviderResult } from "../src/decision/provider.js";
import { DecisionManager } from "../src/decision/manager.js";
import { createApp } from "../src/app.js";
import { authed, emptyContext, testConfig } from "./helpers.js";

const vector = (winner = "expand") => DECISION_ACTIONS.map(id => id === winner ? .94 : .01);
const scores = (winner = "expand") => Object.fromEntries(DECISION_ACTIONS.map((id, index) => [id, vector(winner)[index]]));
const accepted = (): DecisionProviderResult => ({ state: "accepted", probabilities: vector() });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const noteContext = () => emptyContext([{ id: "n", type: "NoteCard", displayProps: { text: "TEST" }, sourceDataSummary: {}, layout: { x: 0, y: 0 } }]);
afterEach(() => vi.useRealTimers());

describe("DEC-01 prediction contract", () => {
  it("shares the Python request/response fixtures without leaking answer metadata", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../contrib/decision-evaluation/contract-fixtures.json", import.meta.url), "utf8"));
    const request = decisionRequest(fixture.input.utterance);
    expect(request.request_id).toMatch(/^[a-f0-9-]{36}$/);
    expect({ ...request, request_id: fixture.request_id }).toEqual({ schema_version: fixture.schema_version, request_id: fixture.request_id, input: fixture.input });
    for (const item of fixture.responses) expect(parseDecisionPrediction(item.value, fixture.input.utterance).state, item.label).toBe(item.runtime_state);
    expect(Object.keys(request.input)).toEqual(["utterance", "context", "choices"]);
  });
  it("maps an exact seven-ID probability object to the existing score ordering", () => {
    const reversed = Object.fromEntries(Object.entries(scores()).reverse());
    expect(parseDecisionPrediction({ choice_id: "expand", probabilities: reversed }, "展开便笺"))
      .toEqual({ state: "accepted", probabilities: vector(), choiceId: "expand" });
  });
  it("defers choice-only output without inventing a confidence score", () => {
    const result = parseDecisionPrediction({ choice_id: "expand" }, "展开便笺");
    expect(result).toEqual({ state: "deferred", choiceId: "expand", reason: "missing_scores" });
    expect(result.probabilities).toBeUndefined();
  });
  it.each([
    {}, { choice_id: "C99" }, { probabilities: vector() }, { probabilities: { ...scores(), extra: 0 } },
    { probabilities: { fit: .01, restore: .01, focus: .01, delete: .01, expand: .95, collapse: .01 } },
    { probabilities: { ...scores(), expand: .9 } }, { probabilities: { ...scores(), expand: NaN } },
    { probabilities: { ...scores(), expand: Infinity } }, { probabilities: { ...scores(), expand: true } },
    { probabilities: { ...scores(), expand: -.1 } }, { probabilities: { ...scores(), expand: 1.1 } },
    { probabilities: scores(), actions: [{ type: "cards.delete" }] },
  ])("rejects malformed scores or extra model capabilities: %j", value => {
    expect(parseDecisionPrediction(value, "展开便笺").state).toBe("error");
  });
  it("rejects a choice that contradicts otherwise valid sum-one scores", () => {
    expect(vector().reduce((sum, p) => sum + p, 0)).toBeCloseTo(1);
    expect(parseDecisionPrediction({ choice_id: "fit", probabilities: scores() }, "展开便笺"))
      .toMatchObject({ state: "error", reason: "inconsistent_choice" });
  });
  it("retains low-confidence, negation, compound, quoted and deletion guards", () => {
    const lowScores = Object.fromEntries(DECISION_ACTIONS.map(id => [id, id === "expand" ? .7 : .05]));
    expect(parseDecisionPrediction({ probabilities: lowScores }, "展开便笺").state).toBe("deferred");
    for (const text of ["不要展开便笺", "展开然后聚焦", "引用“展开便笺”", "删除便笺"]) {
      expect(parseDecisionPrediction({ probabilities: scores() }, text).state).toBe("deferred");
    }
    expect(parseDecisionPrediction({ probabilities: scores("delete") }, "展开便笺").state).toBe("deferred");
  });
});

describe("DEC-01 HTTP bounds and cancellation", () => {
  it("transmits a valid adapter request and isolates the credential from model input", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ probabilities: scores() }));
    const provider = new HttpDecisionProvider("https://decision.test/decide", { name: "api", fetchImpl, getToken: () => "TEST-only-bridge-token" });
    expect(await provider.decide("展开便笺")).toMatchObject({ state: "accepted", probabilities: vector(), provider: "api" });
    expect(fetchImpl).toHaveBeenCalledWith("https://decision.test/decide", expect.objectContaining({ method: "POST", redirect: "error", credentials: "omit",
      headers: { "content-type": "application/json", authorization: "Bearer TEST-only-bridge-token" } }));
    const body = fetchImpl.mock.calls[0]![1]?.body;
    expect(typeof body).toBe("string"); expect(String(body)).not.toContain("TEST-only-bridge-token");
    expect(JSON.parse(String(body)).input.choices).toHaveLength(7);
  });
  it("does not send disabled, pre-cancelled or oversized input", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const disabled = new HttpDecisionProvider("http://127.0.0.1:1/decide", { name: "local", enabled: false, fetchImpl });
    const enabled = new HttpDecisionProvider("http://127.0.0.1:1/decide", { name: "local", fetchImpl });
    expect((await disabled.decide("展开便笺")).state).toBe("disabled");
    expect((await enabled.decide("展开便笺", AbortSignal.abort())).state).toBe("cancelled");
    expect((await enabled.decide("x".repeat(501))).state).toBe("deferred"); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("makes cancellation win over a transport that returns success after abort", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => { controller.abort(); return response({ probabilities: scores() }); });
    const provider = new HttpDecisionProvider("http://127.0.0.1:1/decide", { name: "local", fetchImpl });
    expect((await provider.decide("展开便笺", controller.signal)).state).toBe("cancelled");
  });
  it("bounds a fetch implementation that never settles or observes AbortSignal", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {}));
    const provider = new HttpDecisionProvider("http://127.0.0.1:1/decide", { name: "local", fetchImpl, timeoutMs: 10 });
    const pending = provider.decide("展开便笺"); await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toMatchObject({ state: "timeout", reason: "timeout" });
  });
  it("bounds a response body that never finishes and cancels its reader", async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"probabilities":')); }, cancel });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } }));
    const provider = new HttpDecisionProvider("http://127.0.0.1:1/decide", { name: "local", fetchImpl, timeoutMs: 10 });
    const pending = provider.decide("展开便笺"); await vi.advanceTimersByTimeAsync(11);
    expect((await pending).state).toBe("timeout"); expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([
    () => new Response("x".repeat(32769), { headers: { "content-type": "application/json" } }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "32769" } }),
    () => new Response("invalid", { headers: { "content-type": "application/json" } }),
  ])("rejects oversized or non-JSON responses", async makeResponse => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse());
    expect((await new HttpDecisionProvider("http://127.0.0.1:1/decide", { name: "local", fetchImpl }).decide("展开便笺")).state).toBe("error");
  });
  it("rejects non-loopback local endpoints and secrets or unsafe transport in URLs", () => {
    for (const url of ["http://decision.test/decide", "https://user:pass@decision.test/decide", "https://decision.test/decide?key=test", "https://decision.test/decide#secret"]) {
      expect(() => decisionEndpoint(url, "api", "adapter")).toThrow();
    }
    expect(() => decisionEndpoint("https://decision.test/decide", "local", "adapter")).toThrow();
    expect(() => decisionEndpoint("https://decision.test/chat", "api", "local-chat")).toThrow();
    expect(decisionEndpoint("http://127.0.0.1:8790/v1/chat/completions", "local", "local-chat")).toBe("http://127.0.0.1:8790/v1/chat/completions");
  });
  it("uses local chat messages but only records the choice and defers execution", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ choices: [{ finish_reason: "stop", message: { content: '{"choice_id":"expand"}' } }] }));
    const provider = new HttpDecisionProvider("http://127.0.0.1:8790/v1/chat/completions", { name: "local", protocol: "local-chat", model: "TEST-model", fetchImpl });
    const result = await provider.decide("展开便笺");
    expect(result).toMatchObject({ state: "deferred", choiceId: "expand", reason: "missing_scores" }); expect(result.probabilities).toBeUndefined();
    const payload = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(payload).toMatchObject({ model: "TEST-model", temperature: 0, stream: false, max_tokens: 128 });
    expect(payload.messages).toHaveLength(2); expect(JSON.parse(payload.messages[1].content).utterance).toBe("展开便笺"); expect(payload.input).toBeUndefined();
  });
  it.each([
    { finish_reason: "length", message: { content: '{"choice_id":"expand"}' } },
    { finish_reason: "stop", message: { content: '{"choice_id":"expand"}', tool_calls: [{ name: "bash" }] } },
    { finish_reason: "stop", message: { content: JSON.stringify({ choice_id: "expand", probabilities: scores() }) } },
  ])("rejects unfinished, tool-bearing and self-scored local chat replies", async choice => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ choices: [choice] }));
    expect((await new HttpDecisionProvider("http://127.0.0.1:8790/v1/chat/completions", { name: "local", protocol: "local-chat", model: "TEST-model", fetchImpl }).decide("展开便笺")).state).toBe("error");
  });
});

describe("DEC-01 router and manager lifecycle", () => {
  it.each(["error", "timeout"] as const)("falls back after %s, preserving failure provenance", async state => {
    const primary = { decide: vi.fn(async (): Promise<DecisionProviderResult> => ({ state })) }, fallback = { decide: vi.fn(async () => accepted()) };
    expect(await new DecisionRouter(primary, fallback).decide("展开便笺")).toMatchObject({ state: "accepted", reason: `fallback_after:${state}` }); expect(fallback.decide).toHaveBeenCalledOnce();
  });
  it.each(["accepted", "deferred", "disabled", "cancelled"] as const)("does not reinterpret %s as a reason to try another model", async state => {
    const primary = { decide: vi.fn(async (): Promise<DecisionProviderResult> => ({ state })) }, fallback = { decide: vi.fn(async () => accepted()) };
    expect((await new DecisionRouter(primary, fallback).decide("展开便笺")).state).toBe(state); expect(fallback.decide).not.toHaveBeenCalled();
  });
  it("catches provider exceptions and does not surface exception text", async () => {
    const primary = { decide: vi.fn(async (): Promise<DecisionProviderResult> => { throw new Error("TEST-private-upstream-text"); }) }, fallback = { decide: vi.fn(async () => accepted()) };
    const result = await new DecisionRouter(primary, fallback).decide("展开便笺");
    expect(result.state).toBe("accepted"); expect(JSON.stringify(result)).not.toContain("TEST-private-upstream-text"); expect(fallback.decide).toHaveBeenCalledOnce();
  });
  it("does not call either provider while explicitly disabled", async () => {
    const primary = { decide: vi.fn(async () => accepted()) }, fallback = { decide: vi.fn(async () => accepted()) };
    expect((await new DecisionRouter(primary, fallback, false).decide("展开便笺")).state).toBe("disabled"); expect(primary.decide).not.toHaveBeenCalled(); expect(fallback.decide).not.toHaveBeenCalled();
  });
  it("makes cancellation terminal even when an injected provider returns accepted", async () => {
    const controller = new AbortController();
    const primary = { decide: vi.fn(async () => { controller.abort(); return accepted(); }) }, fallback = { decide: vi.fn(async () => accepted()) };
    expect((await new DecisionRouter(primary, fallback).decide("展开便笺", controller.signal)).state).toBe("cancelled"); expect(fallback.decide).not.toHaveBeenCalled();
  });
  it("enables and stops the configured service without Kev files or model preparation", async () => {
    const provider = { decide: vi.fn(async () => accepted()) }, manager = new DecisionManager("/nonexistent/vivic-test-model", provider, { enabled: false });
    expect(manager.status()).toMatchObject({ mode: "provider", phase: "cached", enabled: false, bytes: 0 });
    expect(await manager.score("展开便笺")).toBeNull(); expect(provider.decide).not.toHaveBeenCalled(); manager.prepare(); expect(provider.decide).not.toHaveBeenCalled();
    expect(manager.enable()).toMatchObject({ phase: "ready", enabled: true }); expect(await manager.score("展开便笺")).toEqual(vector());
    expect(manager.stop()).toMatchObject({ phase: "cached", enabled: false }); expect(await manager.score("展开便笺")).toBeNull(); expect(provider.decide).toHaveBeenCalledOnce();
    expect(manager.clear()).toMatchObject({ mode: "provider", phase: "cached", enabled: false });
  });
  it("drops an in-flight result across stop/enable even if the provider ignores abort", async () => {
    const old = deferred<DecisionProviderResult>(); const provider = { decide: vi.fn(async () => accepted()).mockImplementationOnce(() => old.promise) };
    const manager = new DecisionManager("/nonexistent/vivic-test-model", provider), pending = manager.score("展开便笺");
    await vi.waitFor(() => expect(provider.decide).toHaveBeenCalledOnce()); manager.stop(); manager.enable();
    expect(await pending).toBeNull(); old.resolve(accepted()); await Promise.resolve();
    expect(manager.status()).toMatchObject({ enabled: true, phase: "ready" }); expect(await manager.score("展开便笺")).toEqual(vector()); expect(provider.decide).toHaveBeenCalledTimes(2); manager.stop();
  });
  it("revalidates injected scores and defers invalid or guarded predictions", async () => {
    const provider = { decide: vi.fn(async () => accepted()) }, manager = new DecisionManager("/nonexistent/vivic-test-model", provider);
    provider.decide.mockResolvedValueOnce({ state: "accepted", probabilities: [0, 0, 0, 0, .94, .01, .01] });
    expect(await manager.score("展开便笺")).toBeNull(); expect(manager.status().lastState).toBe("deferred");
    expect(await manager.score("不要展开便笺")).toBeNull(); expect(await manager.score("删除便笺")).toBeNull(); manager.stop();
  });
  it("bounds an uncooperative injected provider and remains usable afterward", async () => {
    vi.useFakeTimers(); const provider = { decide: vi.fn(async () => accepted()).mockImplementationOnce(() => new Promise<DecisionProviderResult>(() => {})) };
    const manager = new DecisionManager("/nonexistent/vivic-test-model", provider, { timeoutMs: 10 }), pending = manager.score("展开便笺");
    await vi.advanceTimersByTimeAsync(11); expect(await pending).toBeNull();
    expect(manager.status()).toMatchObject({ lastState: "timeout", phase: "error", error: "决策服务暂不可用，本次使用原有指令流程。" });
    expect(await manager.score("展开便笺")).toBeNull();
    expect(provider.decide).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await manager.score("展开便笺")).toEqual(vector());
    expect(manager.status()).toMatchObject({ lastState: "accepted", phase: "ready", error: null }); manager.stop();
  });
  it("discards a valid decision if the selected model session changed mid-request", async () => {
    const delayed = deferred<DecisionProviderResult>(), provider = { decide: vi.fn(() => delayed.promise) };
    const app = createApp({ config: testConfig(), decisionProvider: provider });
    try {
      const pending = app.request("/api/intent", { method: "POST", headers: authed, body: JSON.stringify({ text: "展开便笺", canvasContext: noteContext() }) });
      await vi.waitFor(() => expect(provider.decide).toHaveBeenCalledOnce());
      const selected = await app.request("/api/providers/select", { method: "POST", headers: authed, body: JSON.stringify({ provider: "gpt" }) }); expect(selected.status).toBe(200);
      delayed.resolve(accepted()); const result = await (await pending).json();
      expect(result).toMatchObject({ kind: "error", message: "模型连接已变更，旧决策结果已丢弃。" }); expect(result.envelope).toBeUndefined();
    } finally { delayed.resolve({ state: "cancelled" }); app.dispose(); }
  });
});
