import { afterEach, describe, expect, it, vi } from "vitest";
import { chatJson, type ChatJsonOptions } from "../src/stepfun.js";
import { feedbackReader } from "../src/intent/feedback.js";

const credential = { apiKey: "TEST-stepfun-stream-private", models: ["TEST-model"], defaultModel: "TEST-model", checkedAt: "now" };
const encoder = new TextEncoder();
const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const terminal = frame({}, "stop") + "data: [DONE]\n\n";
const response = (text: string, chunks = [encoder.encode(text)]) => new Response(new ReadableStream<Uint8Array>({
  start(controller) { chunks.forEach(chunk => controller.enqueue(chunk)); controller.close(); },
}), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
const jsonResponse = (content: string, finish = "stop") =>
  Response.json({ choices: [{ index: 0, message: { content }, finish_reason: finish }] });
const harness = (reply: (attempt: number) => Response | Promise<Response>, options: ChatJsonOptions = {}, signal?: AbortSignal, timeoutMs?: number) => {
  let attempt = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => reply(++attempt));
  return { fetchImpl, pending: chatJson(credential, [{ role: "user", content: "测试流读取" }],
    { baseUrl: "https://unit.test/v1", fetchImpl, signal, timeoutMs }, options) };
};
afterEach(() => vi.useRealTimers());

describe("StepFun optional JSON completion stream", () => {
  it("emits content before completion, ignores reasoning, and still returns parsed JSON", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = vi.fn(), onTextDelta = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel: cancelled });
    const { pending, fetchImpl } = harness(() => new Response(stream, { headers: { "content-type": "text/event-stream" } }), { onTextDelta, maxTokens: 4096 });
    let settled = false;
    void pending.then(() => { settled = true; });
    controller.enqueue(encoder.encode(frame({ role: "assistant", reasoning_content: "TEST-private-reasoning" }) + frame({ content: '{"say":"我来整理。",' })));
    await vi.waitFor(() => expect(onTextDelta).toHaveBeenCalledWith('{"say":"我来整理。",'));
    expect(settled).toBe(false);
    controller.enqueue(encoder.encode(frame({ content: '"slots":{"text":"你好"}}' }) + terminal));
    expect(await pending).toEqual({ ok: true, value: { say: "我来整理。", slots: { text: "你好" } } });
    expect(onTextDelta.mock.calls.flat().join("")).toBe('{"say":"我来整理。","slots":{"text":"你好"}}');
    expect(cancelled).toHaveBeenCalledOnce();
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "TEST-model", stream: true, max_tokens: 4096,
      response_format: { type: "json_object" } });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("onTextDelta");
  });

  it.each(["\n", "\r\n", "\r"])("decodes split UTF-8, %j framing, comments, and multiline data", async newline => {
    const first = [": keep-alive", "event: message", "id: 1", 'data: {"choices": [',
      'data: {"index":0,"delta":{"content":"{\\\"text\\\":\\\"你好😀\\\"}"},"finish_reason":null}]}', "", ""].join(newline);
    const wire = first + (frame({}, "stop") + 'data: {"choices":[],"usage":{"total_tokens":8}}\n\n' + "data: [DONE]\n\n").replaceAll("\n", newline);
    const bytes = encoder.encode(wire), onTextDelta = vi.fn();
    const { pending } = harness(() => response(wire, Array.from(bytes, byte => new Uint8Array([byte]))), { onTextDelta });
    expect(await pending).toEqual({ ok: true, value: { text: "你好😀" } });
    expect(onTextDelta).toHaveBeenCalledOnce();
    expect(onTextDelta).toHaveBeenCalledWith('{"text":"你好😀"}');
  });

  it("keeps non-streaming requests and defaults unchanged", async () => {
    const { pending, fetchImpl } = harness(() => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }));
    expect(await pending).toEqual({ ok: true, value: { ok: true } });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(body).not.toHaveProperty("stream");
    expect(body.temperature).toBe(.2);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("accepts an ignored stream request as complete JSON without inventing deltas", async () => {
    const onTextDelta = vi.fn();
    const { pending, fetchImpl } = harness(() => Response.json({ choices: [{ finish_reason: "stop", message: { content: '```json\n{"ok":true}\n```' } }] }), { onTextDelta });
    expect(await pending).toEqual({ ok: true, value: { ok: true } });
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).stream).toBe(true);
  });

  it("isolates callback exceptions from inference", async () => {
    const onTextDelta = vi.fn(() => { throw new Error(credential.apiKey); });
    const { pending } = harness(() => response(frame({ content: '{"ok":true}' }) + terminal), { onTextDelta });
    expect(await pending).toEqual({ ok: true, value: { ok: true } });
    expect(onTextDelta).toHaveBeenCalledOnce();
  });

  it("accepts finish_reason=length when the content is already complete JSON", async () => {
    const onTextDelta = vi.fn();
    const { pending, fetchImpl } = harness(() => response(frame({ content: '{"ok":true}' }) + frame({}, "length")), { onTextDelta });
    expect(await pending).toEqual({ ok: true, value: { ok: true } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(onTextDelta).toHaveBeenCalledOnce();
  });

  it.each([
    ["content_filter", "内容安全"],
    ["tool_calls", "工具调用"],
  ])("rejects finish_reason=%s with an honest error and does not let the fallback accept it", async (finish, message) => {
    const { pending, fetchImpl } = harness(attempt => attempt === 1
      ? response(frame({ content: '{"ok":true}' }) + frame({}, finish) + "data: [DONE]\n\n")
      : jsonResponse('{"ok":true}', finish), { onTextDelta: vi.fn<(delta: string) => void>() });
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "invalid-response" });
    expect((result as { error: string }).error).toContain(message);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body))).not.toHaveProperty("stream");
  });

  it("accepts a stream that only sends [DONE] once the content is complete", async () => {
    const onTextDelta = vi.fn();
    const { pending, fetchImpl } = harness(() => response(frame({ content: '{"ok":true}' }) + "data: [DONE]\n\n"), { onTextDelta });
    expect(await pending).toEqual({ ok: true, value: { ok: true } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(onTextDelta).toHaveBeenCalledOnce();
  });

  it("accepts a finish_reason=stop stream that never sends [DONE]", async () => {
    const { pending, fetchImpl } = harness(() => response(frame({ content: '{"ok":true}' }) + frame({}, "stop")), { onTextDelta: vi.fn<(delta: string) => void>() });
    expect(await pending).toEqual({ ok: true, value: { ok: true } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("accepts a complete answer whose [DONE] line is not terminated by a blank line", async () => {
    const { pending, fetchImpl } = harness(() => response(frame({ content: '{"ok":true}' }) + frame({}, "stop") + "data: [DONE]\n"),
      { onTextDelta: vi.fn<(delta: string) => void>() });
    expect(await pending).toEqual({ ok: true, value: { ok: true } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ["invalid event JSON", `data: ${credential.apiKey}\n\n`],
    ["another choice", 'data: {"choices":[{"index":1,"delta":{"content":"{}"}}]}\n\n'],
    ["nontext content", 'data: {"choices":[{"index":0,"delta":{"content":42}}]}\n\n'],
    ["content after finish", frame({ content: "{}" }, "stop") + frame({ content: "extra" }) + "data: [DONE]\n\n"],
    ["non JSON answer", frame({ content: "你好" }) + terminal],
    ["empty content", frame({ reasoning_content: "TEST-private-reasoning" }) + terminal],
  ])("rejects %s without exposing upstream diagnostics after the fallback", async (_name, wire) => {
    const { pending, fetchImpl } = harness(attempt => attempt === 1 ? response(wire) : jsonResponse("不是 JSON"),
      { onTextDelta: vi.fn<(delta: string) => void>() });
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "invalid-response" });
    expect(JSON.stringify(result)).not.toContain(credential.apiKey);
    expect(JSON.stringify(result)).not.toContain("TEST-private-reasoning");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["without finish or DONE", frame({ content: '{"ok":true}' })],
    ["in a frame", frame({ content: '{"ok":true}' }) + 'data: {"choices":'],
  ])("treats a closed stream %s as a failed transport and retries once non-streaming", async (_name, wire) => {
    const { pending, fetchImpl } = harness(attempt => attempt === 1 ? response(wire) : Promise.reject(new TypeError("fallback dropped")),
      { onTextDelta: vi.fn<(delta: string) => void>() });
    expect(await pending).toMatchObject({ ok: false, code: "network" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body))).not.toHaveProperty("stream");
  });

  it("falls back to a non-streaming request once when stream:true is rejected with 400", async () => {
    const onTextDelta = vi.fn();
    const { pending, fetchImpl } = harness(attempt => attempt === 1
      ? new Response("stream unsupported", { status: 400 })
      : jsonResponse('{"ok":true}'), { onTextDelta });
    expect(await pending).toEqual({ ok: true, value: { ok: true } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).stream).toBe(true);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body))).not.toHaveProperty("stream");
    expect(onTextDelta).not.toHaveBeenCalled();
  });

  it("recovers when an SSE content type actually carries one JSON body", async () => {
    const body = JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] });
    const { pending, fetchImpl } = harness(attempt => attempt === 1
      ? new Response(body, { headers: { "content-type": "text/event-stream" } })
      : jsonResponse('{"ok":true}'), { onTextDelta: vi.fn<(delta: string) => void>() });
    expect(await pending).toEqual({ ok: true, value: { ok: true } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body))).not.toHaveProperty("stream");
  });

  it("retries a half-written JSON stream once without streaming and recovers", async () => {
    const onTextDelta = vi.fn();
    const { pending, fetchImpl } = harness(attempt => attempt === 1
      ? response(frame({ content: '{"ok":true}' }) + 'data: {"choices":')
      : jsonResponse('{"ok":true}'), { onTextDelta });
    expect(await pending).toEqual({ ok: true, value: { ok: true } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onTextDelta).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body))).not.toHaveProperty("stream");
  });

  it("returns an honest output-length error for truncated, unparseable content", async () => {
    const { pending, fetchImpl } = harness(attempt => attempt === 1
      ? response(frame({ content: '{"ok":' }) + frame({}, "length"))
      : jsonResponse('{"ok":', "length"), { onTextDelta: vi.fn<(delta: string) => void>() });
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "invalid-response", truncated: true });
    expect((result as { error: string }).error).toContain("输出长度");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body))).not.toHaveProperty("stream");
  });

  it("classifies an in-stream error frame as a retryable network failure, not model output", async () => {
    const wire = `data: {"error":{"message":"${credential.apiKey}"}}\n\n`;
    const { pending, fetchImpl } = harness(attempt => attempt === 1 ? response(wire) : Promise.reject(new TypeError("fallback dropped")),
      { onTextDelta: vi.fn<(delta: string) => void>() });
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "network" });
    expect(JSON.stringify(result)).not.toContain(credential.apiKey);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body))).not.toHaveProperty("stream");
  });

  it("retries a dropped stream once with the non-streaming fallback", async () => {
    const onTextDelta = vi.fn();
    const { pending, fetchImpl } = harness(attempt => attempt === 1
      ? new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(encoder.encode(frame({ content: '{"attempt":1}' }))); },
        pull(controller) { controller.error(new Error(credential.apiKey)); },
      }), { headers: { "content-type": "text/event-stream" } })
      : jsonResponse('{"attempt":2}'), { onTextDelta });
    expect(await pending).toEqual({ ok: true, value: { attempt: 2 } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The whole JSON answer arrives through the non-streaming fallback, so no
    // second partial prefix is ever exposed to the feedback reader.
    expect(onTextDelta.mock.calls.map(call => call[0])).toEqual(['{"attempt":1}']);
  });

  it("does not publish a partial feedback phrase when a broken stream falls back to non-streaming", async () => {
    const publish = vi.fn(), onTextDelta = feedbackReader(publish);
    const value = { feedback: "我来整理这份内容。", slots: { text: "阅读草稿" } };
    const { pending, fetchImpl } = harness(attempt => attempt === 1
      ? response(frame({ content: '{"feedback":"我来' }))
      : jsonResponse(JSON.stringify(value)), { onTextDelta });
    expect(await pending).toEqual({ ok: true, value });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
  });

  it("isolates reset exceptions from inference", async () => {
    const onTextDelta = Object.assign(vi.fn(), { reset: vi.fn(() => { throw new Error(credential.apiKey); }) });
    const { pending } = harness(() => response(frame({ content: '{"ok":true}' }) + terminal), { onTextDelta });
    expect(await pending).toEqual({ ok: true, value: { ok: true } });
    expect(onTextDelta.reset).toHaveBeenCalledOnce();
    expect(onTextDelta).toHaveBeenCalledOnce();
  });

  it("recovers from malformed UTF-8 through the fallback without forwarding replacement text", async () => {
    const onTextDelta = vi.fn();
    const { pending, fetchImpl } = harness(attempt => attempt === 1
      ? response("", [new Uint8Array([0xff])])
      : jsonResponse('{"ok":true}'), { onTextDelta });
    expect(await pending).toEqual({ ok: true, value: { ok: true } });
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops callbacks within a chunk when a consumer cancels the request", async () => {
    const controller = new AbortController();
    const onTextDelta = vi.fn(() => controller.abort(new Error(credential.apiKey)));
    const { pending, fetchImpl } = harness(() => response(frame({ content: '{"ok":' }) + frame({ content: "true}" }) + terminal),
      { onTextDelta }, controller.signal);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "cancelled" });
    expect(onTextDelta).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(credential.apiKey);
  });

  it("cancels a waiting reader and suppresses late deltas", async () => {
    const controller = new AbortController(), cancelled = vi.fn(), onTextDelta = vi.fn();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { source = value; }, cancel: cancelled });
    const { pending, fetchImpl } = harness(() => new Response(body, { headers: { "content-type": "text/event-stream" } }), { onTextDelta }, controller.signal);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, code: "cancelled" });
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(() => source.enqueue(encoder.encode(frame({ content: "{}" })))).toThrow();
    expect(onTextDelta).not.toHaveBeenCalled();
  });

  it("bounds an open stream by the existing deadline without retrying timeout", async () => {
    vi.useFakeTimers();
    const onTextDelta = vi.fn(), cancelled = vi.fn();
    const { pending, fetchImpl } = harness(() => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }),
      { headers: { "content-type": "text/event-stream" } }), { onTextDelta }, undefined, 20);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ ok: false, code: "timeout" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
