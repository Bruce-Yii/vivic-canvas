import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import { STEPFUN_PLAN_BASE_URL } from "../src/config.js";
import { authed, testConfig } from "./helpers.js";

const file = () => {
  const bytes = Buffer.alloc(44 + 96000);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(96000, 40);
  const form = new FormData(); form.set("file", new Blob([bytes], { type: "audio/wav" }), "voice.wav");
  return form;
};

describe("mounted ASR route", () => {
  it("accepts a WAV larger than the ordinary JSON body limit without search middleware interference", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "unit-asr-secret", defaultModel: "step-3.5-flash", models: [], checkedAt: "now" });
    let called = 0;
    const app = createApp({ config: testConfig({ stepfunBaseUrl: STEPFUN_PLAN_BASE_URL }), credentials,
      search: { webSearch: async () => [], fetchContent: async () => { throw new Error("unused"); } },
      fetchImpl: (async (url, init) => {
        called += 1;
        expect(String(url)).toBe("https://api.stepfun.com/step_plan/v1/audio/asr/sse");
        const body = JSON.parse(String(init?.body));
        expect(Buffer.from(body.audio.data, "base64")).toHaveLength(96000);
        return new Response('data: {"type":"transcript.text.done","text":"十分钟后提醒我喝水"}\n\n', { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch,
    });
    expect((await app.request("/api/providers/status", { headers: authed })).status).toBe(200);
    const response = await app.request("/api/transcribe", { method: "POST",
      headers: { authorization: authed.authorization, "content-length": "96500" }, body: file() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, text: "十分钟后提醒我喝水" });
    expect(called).toBe(1);
  });
  it("requires the parent session authorization before touching audio or the provider", async () => {
    const app = createApp({ config: testConfig(), fetchImpl: async () => { throw new Error("must not call"); } });
    const response = await app.request("/api/transcribe", { method: "POST", body: file() });
    expect(response.status).toBe(401);
  });
  it("rejects cross-origin multipart submissions even when a proxy adds session auth", async () => {
    const app = createApp({ config: testConfig(), fetchImpl: async () => { throw new Error("must not call"); } });
    for (const origin of ["https://untrusted.example", "null"]) {
      const response = await app.request("/api/transcribe", { method: "POST",
        headers: { authorization: authed.authorization, origin }, body: file() });
      expect(response.status).toBe(403);
    }
  });
});
