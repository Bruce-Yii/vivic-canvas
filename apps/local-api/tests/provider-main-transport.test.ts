import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { DEFAULT_DEEPSEEK_MODEL } from "../src/config.js";
import { ProviderStore } from "../src/providers/store.js";
import { authed, chatOk, emptyContext, TEST_TOKEN, testConfig } from "./helpers.js";

/**
 * A saved `main` provider must decide the planner transport on its own:
 * its base URL, key and model. No env key, no StepFun fallback, no offline
 * answer. These tests cover the online deployment shape where the provider
 * store is the only source of truth.
 */

const DEEPSEEK_KEY = "sk-test-saved-deepseek-0001";
const OTHER_KEY = "sk-test-saved-openai-0002";

const store = () => new ProviderStore({ dataDir: "C:\\nonexistent", persist: false });

const deepSeekRow = (target: ProviderStore, overrides: Record<string, unknown> = {}) => target.create({
  name: "DeepSeek 官方 (seed)", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com/v1",
  apiKey: DEEPSEEK_KEY, model: "deepseek-chat", roles: ["main"], ...overrides,
});

const online = (target: ProviderStore, fetchImpl: typeof fetch) =>
  createApp({ config: testConfig(), mode: "online", providerStore: target, fetchImpl });

const intent = (app: ReturnType<typeof createApp>, text: string) => app.request("/api/intent", {
  method: "POST", headers: authed, body: JSON.stringify({ text, canvasContext: emptyContext() }),
});

describe("saved main provider drives the planner transport", () => {
  it("prefers a DeepSeek row saved after an enabled StepFun seed", async () => {
    vi.stubEnv("VIVIC_MAIN_PROVIDER", "");
    const target = store();
    target.create({ name: "StepFun (seed)", protocol: "stepfun-v1", baseUrl: "https://api.stepfun.com/v1",
      apiKey: "TEST-stepfun-key", model: "step-3.5-flash", roles: ["main"] });
    await new Promise(resolve => setTimeout(resolve, 2));
    deepSeekRow(target);
    const urls: string[] = [];
    const app = online(target, vi.fn<typeof fetch>(async input => {
      urls.push(String(input));
      return chatOk({ reply: "秋叶落在纸上。" });
    }));
    try {
      const status = await (await app.request("/api/providers/status", { headers: authed })).json();
      expect(status.providers[0]).toMatchObject({ name: "deepseek", connected: true });
      const response = await intent(app, "帮我写一首关于秋天的短诗");
      expect((await response.json()).usedProvider).toBe("deepseek");
      expect(urls).toEqual(["https://api.deepseek.com/v1/chat/completions"]);
    } finally { app.dispose(); vi.unstubAllEnvs(); }
  });

  it("uses a saved DeepSeek row without DEEPSEEK_API_KEY and never goes offline", async () => {
    vi.stubEnv("VIVIC_MAIN_PROVIDER", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const target = store();
    // Production shape: a disabled StepFun seed plus an enabled DeepSeek row
    // that has no presetId (created outside the preset picker).
    const stepfun = target.create({ name: "StepFun (seed)", protocol: "stepfun-v1",
      baseUrl: "https://api.stepfun.com/v1", apiKey: "TEST-stepfun-key", model: "step-3.5-flash", roles: ["main"] });
    target.update(stepfun.id, { enabled: false });
    deepSeekRow(target);

    const urls: string[] = [], bodies: Array<Record<string, unknown>> = [], headers: string[] = [];
    const app = online(target, vi.fn<typeof fetch>(async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      headers.push(new Headers(init?.headers).get("authorization") ?? "");
      return chatOk({ reply: "秋叶落在纸上。" });
    }));
    try {
      const status = await (await app.request("/api/providers/status", { headers: authed })).json();
      expect(status).toMatchObject({ activeProvider: "deepseek", mainProvider: "deepseek" });
      expect(status.providers[0]).toMatchObject({
        name: "deepseek", connected: true, models: ["deepseek-chat"], defaultModel: "deepseek-chat",
      });

      const response = await intent(app, "帮我写一首关于秋天的短诗");
      const body = await response.json();
      expect(body.kind).toBe("envelope");
      expect(body.usedProvider).toBe("deepseek");
      expect(String(body.message ?? "")).not.toContain("未连接模型");
      expect(urls).toEqual(["https://api.deepseek.com/v1/chat/completions"]);
      expect(bodies[0]).toMatchObject({ model: "deepseek-chat", thinking: { type: "disabled" },
        response_format: { type: "json_object" } });
      expect(headers[0]).toBe(`Bearer ${DEEPSEEK_KEY}`);
      expect(JSON.stringify(body)).not.toContain(DEEPSEEK_KEY);
      expect(JSON.stringify(status)).not.toContain(DEEPSEEK_KEY);
    } finally { app.dispose(); vi.unstubAllEnvs(); }
  });

  it("picks up a provider saved after the session app already exists", async () => {
    vi.stubEnv("VIVIC_MAIN_PROVIDER", "");
    const target = store();
    const urls: string[] = [];
    const app = online(target, vi.fn<typeof fetch>(async input => {
      urls.push(String(input));
      return chatOk({ reply: "秋叶落在纸上。" });
    }));
    try {
      // Saving settings on a live online session used to leave the cached app
      // with an empty planner credential until it expired.
      deepSeekRow(target);
      const status = await (await app.request("/api/providers/status", { headers: authed })).json();
      expect(status.providers[0]).toMatchObject({ name: "deepseek", connected: true });
      const response = await intent(app, "帮我写一首关于秋天的短诗");
      const body = await response.json();
      expect(body).toMatchObject({ kind: "envelope", usedProvider: "deepseek" });
      expect(urls).toEqual(["https://api.deepseek.com/v1/chat/completions"]);
    } finally { app.dispose(); vi.unstubAllEnvs(); }
  });

  it("falls back to the preset default model instead of reporting offline", async () => {
    vi.stubEnv("VIVIC_MAIN_PROVIDER", "");
    const target = store();
    deepSeekRow(target, { presetId: "deepseek", model: undefined, name: "DeepSeek 官方" });
    const bodies: Array<Record<string, unknown>> = [];
    const app = online(target, vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return chatOk({ reply: "秋叶落在纸上。" });
    }));
    try {
      const response = await intent(app, "帮我写一首关于秋天的短诗");
      expect((await response.json()).kind).toBe("envelope");
      expect(bodies[0]!.model).toBe(DEFAULT_DEEPSEEK_MODEL);
    } finally { app.dispose(); vi.unstubAllEnvs(); }
  });

  it("keeps another OpenAI-compatible endpoint on its own base URL and key", async () => {
    vi.stubEnv("VIVIC_MAIN_PROVIDER", "");
    const target = store();
    target.create({ name: "部署平台", protocol: "openai-compatible", baseUrl: "https://models.example.test/v1",
      apiKey: OTHER_KEY, model: "gpt-4o-mini", roles: ["main"] });
    const urls: string[] = [], bodies: Array<Record<string, unknown>> = [], headers: string[] = [];
    const app = online(target, vi.fn<typeof fetch>(async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      headers.push(new Headers(init?.headers).get("authorization") ?? "");
      return chatOk({ reply: "好" });
    }));
    try {
      const response = await intent(app, "帮我写一首关于秋天的短诗");
      const body = await response.json();
      expect(body.kind).toBe("envelope");
      expect(urls).toEqual(["https://models.example.test/v1/chat/completions"]);
      expect(bodies[0]).toMatchObject({ model: "gpt-4o-mini" });
      // Only the official DeepSeek body opts into `thinking`.
      expect(bodies[0]).not.toHaveProperty("thinking");
      expect(headers[0]).toBe(`Bearer ${OTHER_KEY}`);
    } finally { app.dispose(); vi.unstubAllEnvs(); }
  });
});
