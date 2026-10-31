import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STEPFUN_PLAN_BASE_URL } from "../src/config.js";
import { CredentialStore } from "../src/credentials.js";
import { authed, fetchStub, testConfig } from "./helpers.js";
import { SPEECH_VOICES, SPEECH_VOICES_SOURCE } from "../src/voices.js";

const SECRET = "unit-speech-key-only";
const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]);
const mp3 = () => new Response(AUDIO, { headers: { "content-type": "audio/mpeg" } });

const setup = (fetchImpl: typeof fetch, connected = true, baseUrl = STEPFUN_PLAN_BASE_URL) => {
  const credentials = new CredentialStore();
  if (connected) credentials.set({ apiKey: SECRET, models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "now" });
  const app = createApp({ config: testConfig({ stepfunBaseUrl: baseUrl, speechTimeoutMs: 60 }), credentials, fetchImpl });
  return { app, credentials };
};

const post = (app: ReturnType<typeof createApp>, body: unknown = { text: "已聚焦" }) =>
  app.request("/api/speech", { method: "POST", headers: authed, body: JSON.stringify(body) });

describe("POST /api/speech", () => {
  it.each(["GET", "POST"])("does not expose the removed voice cloning route (%s)", async (method) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { app } = setup(fetchImpl);
    const response = await app.request("/api/speech/cloned-voices", {
      method, headers: authed,
      ...(method === "POST" ? { body: JSON.stringify({ fileId: "file-TEST", authorized: true }) } : {}),
    });
    expect(response.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires session auth before doing any provider work", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { app } = setup(fetchImpl);
    const response = await app.request("/api/speech", { method: "POST", body: '{"text":"你好"}' });
    expect(response.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    {}, null, [], { text: "" }, { text: "    " }, { text: 123 }, { text: "a".repeat(201) },
    { text: "你好\n" }, { text: "\u0000你好" }, { text: "\u200B" },
    { text: "你好", apiKey: SECRET }, { text: "你好", model: "step-tts-mini" },
    { text: "你好", url: "https://api.stepfun.com/v1/audio/speech" },
    { text: "你好", voice: "unverified-voice" }, { text: "你好", voice: "" },
    { text: "你好", voice: "voice-tone-TEST" }, { text: "你好", clonedVoiceId: "voice-tone-TEST" },
    { text: "你好", voice: null }, { text: "你好", speed: "1" },
    { text: "你好", speed: 0.49 }, { text: "你好", speed: 2.01 },
    { text: "你好", speed: null }, { text: "你好", volume: 0.5 },
  ])("rejects invalid input %j without sending a request", async (body) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { app } = setup(fetchImpl);
    const response = await post(app, body);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(SECRET);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON, non-JSON content and oversized bodies without Content-Length", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { app } = setup(fetchImpl);
    expect((await app.request("/api/speech", { method: "POST", headers: authed, body: "{" })).status).toBe(400);
    expect((await app.request("/api/speech", {
      method: "POST", headers: { ...authed, "content-type": "text/plain" }, body: '{"text":"你好"}',
    })).status).toBe(415);
    expect((await post(app, { text: "a".repeat(5000) })).status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails explicitly when disconnected", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { app } = setup(fetchImpl, false);
    const response = await post(app);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, code: "speech-disconnected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the same in-memory key, official Plan model and endpoint; returns binary without caching", async () => {
    const calls: string[] = [];
    const { app } = setup(fetchStub({ "/audio/speech": (init) => {
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${SECRET}` });
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "stepaudio-2.5-tts", input: "已聚焦", voice: "wenrounvsheng", speed: 1.3, response_format: "mp3",
      });
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return mp3();
    } }, (url) => calls.push(url)));
    const response = await post(app, { text: " 已聚焦 " });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(AUDIO);
    expect(calls).toEqual(["https://api.stepfun.com/step_plan/v1/audio/speech"]);
  });

  it("preserves explicit local stub base overrides", async () => {
    const calls: string[] = [];
    const { app } = setup(fetchStub({ "/audio/speech": mp3 }, (url) => calls.push(url)), true, "http://127.0.0.1:9999/v1/");
    expect((await post(app)).status).toBe(200);
    expect(calls).toEqual(["http://127.0.0.1:9999/v1/audio/speech"]);
  });

  it.each(SPEECH_VOICES)("accepts verified voice $id with provider-side speed", async ({ id }) => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "stepaudio-2.5-tts", input: "你好", voice: id, speed: 1.4, response_format: "mp3",
      });
      return mp3();
    });
    expect((await post(setup(fetchImpl).app, { text: "你好", voice: id, speed: 1.4 })).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([0.5, 2])("accepts documented speed boundary %s", async (speed) => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).speed).toBe(speed);
      return mp3();
    });
    expect((await post(setup(fetchImpl).app, { text: "你好", speed })).status).toBe(200);
  });

  it("lists only sourced public voices behind local session auth, without a key or provider request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { app } = setup(fetchImpl, false);
    expect((await app.request("/api/speech/voices")).status).toBe(401);
    const response = await app.request("/api/speech/voices", { headers: authed });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      model: "stepaudio-2.5-tts", voices: SPEECH_VOICES, defaultVoice: "wenrounvsheng",
      speed: { min: 0.5, max: 2, default: 1.3 }, source: SPEECH_VOICES_SOURCE, verifiedAt: "2026-10-15",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["https://api.stepfun.com/v1", "https://api.stepfun.ai/v1", "http://api.stepfun.com/step_plan/v1"])(
    "refuses ordinary or insecure StepFun override %s before sending the key", async (base) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const { app } = setup(fetchImpl, true, base);
      const response = await post(app);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "speech-plan-required" });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 404, 429, 500, 302])("upstream HTTP %s fails once without alternate billing or raw errors", async (status) => {
    const calls: string[] = [];
    const { app } = setup(fetchStub({ "/audio/speech": () => new Response(`upstream echoed ${SECRET}`, {
      status, headers: { location: "https://api.stepfun.com/v1/audio/speech" },
    }) }, (url) => calls.push(url)));
    const response = await post(app);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain(`HTTP ${status}`);
    expect(body).toContain("不会切换计费接口");
    expect(body).not.toContain(SECRET);
    expect(calls).toEqual([`${STEPFUN_PLAN_BASE_URL}/audio/speech`]);
  });

  it.each(["network", "timeout"])("sanitizes %s exceptions including key material", async (kind) => {
    const { app } = setup(fetchStub({ "/audio/speech": () => {
      if (kind === "timeout") throw new DOMException(SECRET, "TimeoutError");
      throw new Error(`authorization: Bearer ${SECRET}`);
    } }));
    const response = await post(app);
    expect([503, 504]).toContain(response.status);
    expect(await response.text()).not.toContain(SECRET);
  });

  it("honors the configured timeout", async () => {
    const { app } = setup(fetchStub({ "/audio/speech": (init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }) }));
    const response = await post(app);
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: "speech-timeout" });
  });

  it("defaults speech to 15s independently of the planner timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const credentials = setup(vi.fn<typeof fetch>()).credentials;
      const app = createApp({
        config: testConfig({ requestTimeoutMs: 45000, stepfunBaseUrl: STEPFUN_PLAN_BASE_URL }),
        credentials, fetchImpl: fetchStub({ "/audio/speech": mp3 }),
      });
      expect((await post(app)).status).toBe(200);
      expect(timeout).toHaveBeenCalledWith(15000);
      expect(timeout).not.toHaveBeenCalledWith(45000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("cancels a stalled response body at the independent speech deadline", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const { app } = setup(fetchStub({ "/audio/speech": () => new Response(stream, {
      headers: { "content-type": "audio/mpeg" },
    }) }));
    const response = await post(app);
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: "speech-timeout" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("propagates caller cancellation to the provider", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let upstreamAborted = false;
    const { app } = setup(fetchStub({ "/audio/speech": (init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => {
        upstreamAborted = true;
        reject(init!.signal!.reason);
      }, { once: true });
      markStarted();
    }) }));
    const pending = app.request(new Request("http://localhost/api/speech", {
      method: "POST", headers: authed, body: '{"text":"你好"}', signal: controller.signal,
    }));
    await started;
    controller.abort();
    expect((await pending).status).toBe(503);
    expect(upstreamAborted).toBe(true);
  });

  it.each(["application/json", "text/html"])("rejects a successful %s response without forwarding it", async (mime) => {
    const { app } = setup(fetchStub({ "/audio/speech": () => new Response(SECRET, { headers: { "content-type": mime } }) }));
    const response = await post(app);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(SECRET);
  });

  it("rejects empty audio and oversized audio without a Content-Length", async () => {
    const { app } = setup(fetchStub({ "/audio/speech": () => new Response(null, { headers: { "content-type": "audio/mpeg" } }) }));
    expect((await post(app)).status).toBe(502);
    const huge = setup(fetchStub({ "/audio/speech": () => new Response(new Uint8Array(4 * 1024 * 1024 + 1), {
      headers: { "content-type": "audio/mpeg" },
    }) }));
    expect((await post(huge.app)).status).toBe(502);
  });

  it("discards audio when credentials change during generation", async () => {
    let complete!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const { app, credentials } = setup(fetchStub({ "/audio/speech": () => {
      markStarted();
      return new Promise<Response>((resolve) => { complete = resolve; });
    } }));
    const pending = post(app);
    await started;
    credentials.clear();
    complete(mp3());
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "speech-disconnected" });
  });
});
