import { describe, expect, it, vi } from "vitest";
import { readSpeechStream } from "../src/speechStream.js";
import { createApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import { authed, testConfig } from "./helpers.js";

const audio = Buffer.from([0x49, 0x44, 0x33]);
const words = [{ text: "你", start_time: 50, end_time: 250 }, { text: "好", start_time: 300, end_time: 500 }];
const events = (): unknown[] => [
  { type: "speech.audio.delta", audio: audio.toString("base64") },
  { type: "response.subtitle", data: { text: "你好", items: words } },
  { type: "speech.audio.done", audio: "" }, "[DONE]",
];
function stream(values: unknown[], split = 7) {
  const bytes = new TextEncoder().encode(values.map(value => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += split) controller.enqueue(bytes.slice(index, index + split));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
const signal = () => new AbortController().signal;

describe("bounded real-format StepFun speech SSE", () => {
  it("accepts split UTF-8/CRLF events and maps actual times to matching characters", async () => {
    const result = await readSpeechStream(stream(events()), "你好", signal());
    expect(result.audio).toEqual(new Uint8Array(audio));
    expect(result.words).toEqual([{ startMs: 50, endMs: 250, charStart: 0, charEnd: 1 }, { startMs: 300, endMs: 500, charStart: 1, charEnd: 2 }]);
  });
  it.each(["missing", "mismatch", "overlap", "reverse", "invalid"])("uses sentence fallback for %s timestamps", async mode => {
    const values = events();
    const items = mode === "missing" ? [] : mode === "mismatch" ? [{ ...words[0], text: "您" }, words[1]]
      : mode === "overlap" ? [words[0], { ...words[1], start_time: 200 }]
        : mode === "reverse" ? [{ ...words[0], end_time: 1 }, words[1]] : [{ ...words[0], start_time: "0" }];
    values[1] = { type: "response.subtitle", data: { text: "你好", items } };
    const result = await readSpeechStream(stream(values), "你好", signal());
    expect(result.audio).toEqual(new Uint8Array(audio)); expect(result.words).toEqual([]);
  });
  it.each(["no-audio-done", "truncated", "provider-error", "bad-base64", "after-done", "too-large"])("rejects %s rather than playing partial audio", async mode => {
    const values = events();
    if (mode === "no-audio-done") values.splice(2, 1);
    if (mode === "truncated") values.pop();
    if (mode === "provider-error") values.splice(1, 0, { type: "speech.audio.error", error: "TEST private upstream body" });
    if (mode === "bad-base64") values[0] = { type: "speech.audio.delta", audio: "not valid!" };
    if (mode === "after-done") values.push({ type: "speech.audio.delta", audio: "AAAA" });
    if (mode === "too-large") values[0] = { type: "speech.audio.delta", audio: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") };
    await expect(readSpeechStream(stream(values, 16384), "你好", signal())).rejects.toThrow();
  });
  it("cancels a stalled body when the deadline expires", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/event-stream" } });
    await expect(readSpeechStream(response, "你好", AbortSignal.timeout(10))).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
  });
  it("requests timestamps only on the Plan route and keeps the old binary response compatible", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "TEST-speech-only", models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "now" });
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://api.stepfun.com/step_plan/v1/audio/speech");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "stepaudio-2.5-tts", timestamp: true, stream_format: "sse" });
      expect(body).not.toHaveProperty("return_url");
      return stream(events());
    });
    const app = createApp({ credentials, fetchImpl: fetcher, config: testConfig({ stepfunBaseUrl: "https://api.stepfun.com/step_plan/v1", speechTimeoutMs: 1000 }) });
    const response = await app.request("/api/speech", { method: "POST", headers: authed,
      body: JSON.stringify({ text: "你好", timestamps: true }) });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ audioBase64: audio.toString("base64"), words: [
      { startMs: 50, endMs: 250, charStart: 0, charEnd: 1 }, { startMs: 300, endMs: 500, charStart: 1, charEnd: 2 },
    ] });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
