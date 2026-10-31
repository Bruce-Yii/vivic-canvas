import { describe, expect, it, vi } from "vitest";
import { readIntentStream } from "../intentStream";

const response = (chunks: string[]) => new Response(new ReadableStream({ start(controller) {
  chunks.forEach(chunk => controller.enqueue(new TextEncoder().encode(chunk))); controller.close();
} }), { headers: { "content-type": "text/event-stream" } });
const accepted = 'event: accepted\ndata: {"requestId":"r1"}\n\n';
const result = 'event: result\ndata: {"kind":"clarify","message":"需要日期"}\n\n';

describe("bounded SSE intent parser", () => {
  it("handles fragmented CRLF frames, filters foreign progress, and returns a final result once", async () => {
    const onProgress = vi.fn();
    const progress = 'event: progress\r\ndata: {"requestId":"r1","stage":"planner","status":"started"}\r\n\r\n';
    const foreign = 'event: progress\ndata: {"requestId":"stale","stage":"planner","status":"started"}\n\n';
    const stream = accepted + foreign + progress + result;
    expect(await readIntentStream(response([stream.slice(0, 19), stream.slice(19, 90), stream.slice(90)]), onProgress))
      .toEqual({ kind: "clarify", message: "需要日期" });
    expect(onProgress).toHaveBeenCalledOnce();
  });
  it("rejects incomplete, malformed or uncorrelated action results", async () => {
    await expect(readIntentStream(response([accepted]), () => {})).rejects.toThrow("提前结束");
    await expect(readIntentStream(response([result]), () => {})).rejects.toThrow("会话标识");
    await expect(readIntentStream(response([accepted + 'event: result\ndata: {"kind":"envelope","envelope":{"actions":[{"type":"eval"}]}}\n\n']), () => {})).rejects.toThrow();
  });
  it("delivers only complete bounded model feedback and keeps ordinary progress compatible", async () => {
    const onProgress = vi.fn();
    const feedback = 'event: progress\ndata: {"requestId":"r1","stage":"planner","status":"started","feedback":"我会保留\\\"原文\\\"，整理成待办。"}\n\n';
    const tooLong = `event: progress\ndata: ${JSON.stringify({ requestId: "r1", stage: "planner", status: "started", feedback: "长".repeat(81) })}\n\n`;
    const empty = 'event: progress\ndata: {"requestId":"r1","stage":"planner","status":"started","feedback":"  "}\n\n';
    const ordinary = 'event: progress\ndata: {"requestId":"r1","stage":"validation","status":"started"}\n\n';
    const split = feedback.indexOf("原文") + 1;
    await readIntentStream(response([accepted + feedback.slice(0, split), feedback.slice(split) + tooLong + empty + ordinary + result]), onProgress);
    expect(onProgress.mock.calls.map(([event]) => event)).toEqual([
      { requestId: "r1", stage: "planner", status: "started", feedback: '我会保留"原文"，整理成待办。' },
      { requestId: "r1", stage: "validation", status: "started" },
    ]);
  });
  it("does not publish feedback after cancellation while waiting for a frame", async () => {
    const controller = new AbortController(), onProgress = vi.fn();
    let enqueue!: (value: Uint8Array) => void;
    const stream = new Response(new ReadableStream<Uint8Array>({ start(writer) {
      enqueue = value => writer.enqueue(value);
      enqueue(new TextEncoder().encode(accepted));
    } }), { headers: { "content-type": "text/event-stream" } });
    const reading = readIntentStream(stream, onProgress, controller.signal);
    controller.abort();
    await expect(reading).rejects.toThrow();
    expect(onProgress).not.toHaveBeenCalled();
  });
  it("accepts JSON test/backward-compatible responses and honors cancellation", async () => {
    expect(await readIntentStream(Response.json({ kind: "unknown", message: "TEST" }), () => {})).toMatchObject({ kind: "unknown" });
    const controller = new AbortController(); controller.abort();
    await expect(readIntentStream(response([accepted + result]), () => {}, controller.signal)).rejects.toThrow();
  });
});
