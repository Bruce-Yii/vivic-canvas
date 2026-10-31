import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { ASR_BODY_LIMIT_BYTES, ASR_MODEL, createAsrRoutes } from "../src/asr.js";
import { extractAsrPcm, MAX_ASR_FILE_BYTES, MAX_ASR_PCM_BYTES } from "../src/asrAudio.js";
import { CredentialStore } from "../src/credentials.js";
import { TEST_TOKEN, testConfig } from "./helpers.js";

const SECRET = "asr-unit-test-memory-only";
const BASE = "https://api.stepfun.com/step_plan/v1";
const credential = () => ({ apiKey: SECRET, models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "test" });
const wav = (size = 320, change?: (view: DataView) => void) => {
  const bytes = new Uint8Array(44 + size);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string) => bytes.set(Buffer.from(text), offset);
  tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, size, true);
  // Distinguishable PCM to prove that RIFF/fmt headers are stripped upstream.
  for (let i = 44; i < bytes.length; i++) bytes[i] = i % 251;
  change?.(view);
  return bytes;
};
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const done = (text: unknown = "创建一个倒计时") => event({ type: "transcript.text.done", text });
const sse = (body = done()) => new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
const form = (audio = wav(), type = "audio/wav") => {
  const data = new FormData();
  data.append("file", new Blob([audio], { type }), "recording.wav");
  return data;
};
const setup = (fetchImpl: typeof fetch = vi.fn(async () => sse()), options: { connected?: boolean; base?: string; timeout?: number } = {}) => {
  const credentials = new CredentialStore();
  if (options.connected !== false) credentials.set(credential());
  const config = { ...testConfig({ stepfunBaseUrl: options.base ?? BASE }), asrTimeoutMs: options.timeout ?? 1000 };
  // Integration contract: parent middleware owns auth/origin, child only owns /transcribe.
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${TEST_TOKEN}`) return c.json({ ok: false }, 401);
    const origin = c.req.header("origin");
    if (origin && !config.allowedOrigins.includes(origin)) return c.json({ ok: false }, 403);
    await next();
  });
  app.route("/api", createAsrRoutes({ config, credentials, fetchImpl }));
  return { app, credentials, fetchImpl };
};
type App = ReturnType<typeof setup>["app"];
const post = (app: App, body: FormData = form(), signal?: AbortSignal) => app.request("/api/transcribe", {
  method: "POST", headers: { authorization: `Bearer ${TEST_TOKEN}` }, body, signal,
});
const expectFailure = async (response: Response, status: number, code?: string) => {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json() as { ok: boolean; error: string; code: string };
  expect(body).toMatchObject({ ok: false, ...(code ? { code } : {}) });
  expect(body.error).toEqual(expect.any(String));
  expect(JSON.stringify(body)).not.toContain(SECRET);
  expect(body).not.toHaveProperty("text");
  return body;
};

describe("ASR WAV validation", () => {
  it("accepts exactly 60 seconds and exposes only PCM samples", () => {
    expect(extractAsrPcm(wav(MAX_ASR_PCM_BYTES))).toHaveLength(MAX_ASR_PCM_BYTES);
    expect(extractAsrPcm(wav(2))).toEqual(wav(2).subarray(44));
  });
  it.each([
    ["float", (v: DataView) => v.setUint16(20, 3, true)],
    ["stereo", (v: DataView) => v.setUint16(22, 2, true)],
    ["48k", (v: DataView) => v.setUint32(24, 48000, true)],
    ["rate mismatch", (v: DataView) => v.setUint32(28, 1, true)],
    ["alignment", (v: DataView) => v.setUint16(32, 4, true)],
    ["8bit", (v: DataView) => v.setUint16(34, 8, true)],
    ["bad RIFF size", (v: DataView) => v.setUint32(4, 100, true)],
    ["bad fmt size", (v: DataView) => v.setUint32(16, 14, true)],
    ["truncated data", (v: DataView) => v.setUint32(40, 9999, true)],
    ["odd PCM", (v: DataView) => v.setUint32(40, 319, true)],
    ["duplicate fmt", (v: DataView) => v.setUint32(36, 0x20746d66, true)],
    ["unknown chunk", (v: DataView) => v.setUint32(36, 0, true)],
  ])("rejects %s", (_, change) => expect(() => extractAsrPcm(wav(320, change))).toThrow());
  it("rejects empty, overlong, spoofed, truncated and trailing payloads", () => {
    for (const audio of [wav(0), wav(MAX_ASR_PCM_BYTES + 2), new Uint8Array(44), wav().subarray(0, 60),
      new Uint8Array([...wav(), 0]), wav(MAX_ASR_FILE_BYTES)]) {
      expect(() => extractAsrPcm(audio)).toThrow();
    }
  });
});

describe("POST /api/transcribe", () => {
  it("composes with parent auth and origin protection without provider work", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { app } = setup(fetchImpl);
    expect((await app.request("/api/transcribe", { method: "POST", body: form() })).status).toBe(401);
    expect((await app.request("/api/transcribe", { method: "POST", headers: {
      authorization: `Bearer ${TEST_TOKEN}`, origin: "https://evil.test",
    }, body: form() })).status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("uses the exact documented Plan JSON/PCM request and returns only final text", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_, init) => {
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toEqual({ authorization: `Bearer ${SECRET}`, "content-type": "application/json", accept: "text/event-stream" });
      expect(JSON.parse(init?.body as string)).toEqual({ audio: {
        data: Buffer.from(wav().subarray(44)).toString("base64"),
        input: { transcription: { model: ASR_MODEL, language: "zh", enable_itn: true },
          format: { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 } },
      } });
      return sse(event({ type: "transcript.text.delta", delta: "不完整" }) + done("  最终结果  "));
    });
    const { app } = setup(fetchImpl);
    const response = await post(app);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, text: "最终结果" });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(`${BASE}/audio/asr/sse`, expect.any(Object));
  });
  it("returns actionable disconnected/Plan-only failures without network calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expectFailure(await post(setup(fetchImpl, { connected: false }).app), 503, "asr-disconnected");
    for (const base of ["https://api.stepfun.com/v1", "http://api.stepfun.com/step_plan/v1", "https://proxy.test/step_plan/v1",
      `${BASE}?billing=1`, "https://api.stepfun.ai/v1", "invalid"]) {
      await expectFailure(await post(setup(fetchImpl, { base }).app), 503, "asr-plan-required");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["url", "path", "prompt", "apiKey", "model", "language", "duration", "response_format"])("rejects unknown %s fields", async (field) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const data = form(); data.append(field, SECRET);
    await expectFailure(await post(setup(fetchImpl).app, data), 400, "asr-invalid-input");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects missing/duplicate/text file fields, JSON, query parameters and malformed multipart", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { app } = setup(fetchImpl);
    const duplicate = form(); duplicate.append("file", new Blob([wav()], { type: "audio/wav" }), "second.wav");
    const textFile = new FormData(); textFile.set("file", "https://example.test/audio.wav");
    for (const data of [new FormData(), duplicate, textFile]) await expectFailure(await post(app, data), 400);
    for (const contentType of ["application/json", "multipart/form-data", "multipart/form-data; boundary=wrong"]) {
      await expectFailure(await app.request("/api/transcribe", { method: "POST", headers: {
        authorization: `Bearer ${TEST_TOKEN}`, "content-type": contentType,
      }, body: "malformed" }), contentType === "application/json" ? 415 : 400);
    }
    await expectFailure(await app.request("/api/transcribe?prompt=run", { method: "POST", headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
    }, body: form() }), 400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects empty, MIME-spoofed, unsupported and >60-second audio before upstream", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { app } = setup(fetchImpl);
    await expectFailure(await post(app, form(new Uint8Array())), 400, "asr-empty-input");
    await expectFailure(await post(app, form(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))), 400, "asr-invalid-audio");
    for (const type of ["audio/webm", "audio/mp4", "application/octet-stream", "video/wav", ""]) {
      await expectFailure(await post(app, form(wav(), type)), 415, "asr-unsupported-audio");
    }
    await expectFailure(await post(app, form(wav(MAX_ASR_PCM_BYTES + 2))), 400, "asr-invalid-audio");
    await expectFailure(await post(app, form(new Uint8Array(MAX_ASR_FILE_BYTES + 1))), 413, "asr-input-too-large");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("bounds uploads without Content-Length and cancels the source on overflow", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { app } = setup(fetchImpl);
    const cancel = vi.fn();
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(256 * 1024)); }, cancel });
    const request = new Request("http://local.test/api/transcribe", { method: "POST", headers: {
      authorization: `Bearer ${TEST_TOKEN}`, "content-type": "multipart/form-data; boundary=test",
    }, body, duplex: "half" } as RequestInit);
    expect(request.headers.has("content-length")).toBe(false);
    await expectFailure(await app.request(request), 413, "asr-input-too-large");
    expect(cancel).toHaveBeenCalledOnce(); expect(fetchImpl).not.toHaveBeenCalled();
    await expectFailure(await app.request("/api/transcribe", { method: "POST", headers: {
      authorization: `Bearer ${TEST_TOKEN}`, "content-type": "multipart/form-data; boundary=test",
      "content-length": String(ASR_BODY_LIMIT_BYTES + 1),
    }, body: "small" }), 413);
  });
  it.each([400, 401, 403, 404, 429, 500])("redacts upstream HTTP %s and never retries", async (status) => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status }));
    const result = await expectFailure(await post(setup(fetchImpl).app), 503, "asr-unavailable");
    expect(result.error).toContain(String(status));
    expect(cancel).toHaveBeenCalledOnce(); expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each([
    ["delta only", event({ type: "transcript.text.delta", delta: "partial" }), "asr-invalid-response"],
    ["empty", done("  "), "asr-empty-text"], ["invisible", done("\u200b"), "asr-empty-text"],
    ["overlong", done("x".repeat(501)), "asr-text-too-long"], ["wrong type", done(1), "asr-invalid-response"],
    ["unknown event", event({ type: "execute", text: SECRET }), "asr-invalid-response"],
    ["malformed JSON", "data: {broken}\n\n", "asr-invalid-response"],
    ["truncated SSE", done().slice(0, -2), "asr-invalid-response"],
    ["control characters", done("hello\u0000"), "asr-invalid-response"],
  ])("rejects %s response", async (_, body, code) => {
    await expectFailure(await post(setup(vi.fn(async () => sse(body))).app), 502, code);
  });
  it("does not echo SSE errors, exception text or non-SSE bodies", async () => {
    await expectFailure(await post(setup(vi.fn(async () => sse(event({ type: "error", message: SECRET })))).app), 503, "asr-upstream-error");
    await expectFailure(await post(setup(vi.fn(async () => { throw new Error(SECRET); })).app), 503, "asr-unavailable");
    await expectFailure(await post(setup(vi.fn(async () => new Response(SECRET))).app), 502, "asr-invalid-response");
  });
  it("supports split UTF-8, comments, CRLF, CR and SSE multiline data", async () => {
    const raw = ': keepalive\r\nevent: transcript.text.done\r\ndata: {"type":"transcript.text.done",\r\ndata: "text":"中文 😀"}\r\n\r\n';
    const bytes = new TextEncoder().encode(raw);
    const response = () => new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
    expect(await (await post(setup(vi.fn(async () => response())).app)).json()).toEqual({ ok: true, text: "中文 😀" });
    expect(await (await post(setup(vi.fn(async () => sse(done().replaceAll("\n", "\r")))).app)).json()).toMatchObject({ ok: true });
  });
  it("accepts the text boundary and cancels upstream after the final event", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(done("a".repeat(500))));
    }, cancel }), { headers: { "content-type": "text/event-stream" } }));
    expect(await (await post(setup(fetchImpl).app)).json()).toEqual({ ok: true, text: "a".repeat(500) });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("bounds a chunked upstream response", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ pull(controller) {
      controller.enqueue(new Uint8Array(40 * 1024).fill(0x20));
    }, cancel }), { headers: { "content-type": "text/event-stream" } }));
    await expectFailure(await post(setup(fetchImpl).app), 502, "asr-response-too-large");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("covers headers timeout, including a transport ignoring abort", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>((_, init) => { signal = init?.signal ?? undefined; return new Promise(() => {}); });
    await expectFailure(await post(setup(fetchImpl, { timeout: 25 }).app), 504, "asr-timeout");
    expect(signal?.aborted).toBe(true); expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("cancels a late response from a transport ignoring abort", async () => {
    const cancel = vi.fn();
    let resolve!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise((finish) => { resolve = finish; }));
    await expectFailure(await post(setup(fetchImpl, { timeout: 25 }).app), 504, "asr-timeout");
    resolve(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/event-stream" } }));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects an already aborted upload before any provider request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const controller = new AbortController(); controller.abort();
    const request = new Request("http://local.test/api/transcribe", { method: "POST", headers: {
      authorization: `Bearer ${TEST_TOKEN}`, "content-type": "multipart/form-data; boundary=test",
    }, body: "unused", signal: controller.signal } as RequestInit);
    await expectFailure(await setup(fetchImpl).app.request(request), 503, "asr-cancelled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("covers stalled upstream body timeout and request cancellation", async () => {
    for (const abortRequest of [false, true]) {
      const cancel = vi.fn();
      const controller = new AbortController();
      let reading!: () => void;
      const started = new Promise<void>(resolve => { reading = resolve; });
      const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
        // Signal actual body consumption, independent of CI CPU/timer speed.
        pull() { reading(); }, cancel,
      }), { headers: { "content-type": "text/event-stream" } }));
      const pending = post(setup(fetchImpl, { timeout: abortRequest ? 5000 : 40 }).app, form(), controller.signal);
      if (abortRequest) { await started; controller.abort(); }
      await expectFailure(await pending,
        abortRequest ? 503 : 504, abortRequest ? "asr-cancelled" : "asr-timeout");
      expect(cancel).toHaveBeenCalledOnce();
    }
  });
  it("times out and cancels a stalled upload without calling upstream", async () => {
    const fetchImpl = vi.fn<typeof fetch>(); const cancel = vi.fn();
    const { app } = setup(fetchImpl, { timeout: 25 });
    const request = new Request("http://local.test/api/transcribe", { method: "POST", headers: {
      authorization: `Bearer ${TEST_TOKEN}`, "content-type": "multipart/form-data; boundary=test",
    }, body: new ReadableStream({ cancel }), duplex: "half" } as RequestInit);
    await expectFailure(await app.request(request), 504, "asr-timeout");
    expect(cancel).toHaveBeenCalledOnce(); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([false, true])("discards in-flight text after disconnect/reconnect (%s)", async (reconnect) => {
    const fetchImpl = vi.fn(async () => {
      credentials.clear(); if (reconnect) credentials.set(credential());
      return sse(done("stale text"));
    });
    const { app, credentials } = setup(fetchImpl);
    await expectFailure(await post(app), 503, "asr-disconnected");
  });
  it("does not send audio if credentials change during upload", async () => {
    const fetchImpl = vi.fn<typeof fetch>(); const { app, credentials } = setup(fetchImpl);
    const original = new Request("http://local.test/api/transcribe", { method: "POST", body: form() });
    const data = new Uint8Array(await original.arrayBuffer());
    const headers = {
      authorization: `Bearer ${TEST_TOKEN}`, "content-type": original.headers.get("content-type")!,
    };
    // Trigger the connection change after the route snapshots its credential.
    const delayed = new Request(original.url, { method: "POST", headers,
      body: new ReadableStream({ async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        credentials.clear(); controller.enqueue(data); controller.close();
      } }), duplex: "half" } as RequestInit);
    await expectFailure(await app.request(delayed), 503, "asr-disconnected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
