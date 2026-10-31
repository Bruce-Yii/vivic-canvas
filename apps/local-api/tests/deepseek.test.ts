import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { CredentialStore } from "../src/credentials.js";
import { runIntent } from "../src/intent/pipeline.js";
import type { IntentRouter } from "../src/decision/router.js";
import { IntentResponseSchema } from "../src/schemas.js";
import { chatJson } from "../src/stepfun.js";
import { authed, chatOk, emptyContext, TEST_TOKEN, testConfig } from "./helpers.js";

const KEY = "TEST-deepseek-private-key-0123456789";
const credential = { apiKey: KEY, models: ["deepseek-flash"], defaultModel: "deepseek-flash", checkedAt: "now" };
const isolatedConfig = (env: NodeJS.ProcessEnv = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "vivic-deepseek-"));
  try { return loadConfig({ VIVIC_LOCAL_TOKEN: TEST_TOKEN, ...env }, dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};

describe("VIVIC_MAIN_PROVIDER configuration", () => {
  it("defaults to today's StepFun behavior and a 4096 planner cap", () => {
    const config = isolatedConfig();
    expect(config.mainProvider).toBe("stepfun");
    expect(config.deepseekBaseUrl).toBe("https://api.deepseek.com");
    expect(config.deepseekModel).toBe("deepseek-flash");
    expect(config.deepseekApiKey).toBeUndefined();
    expect(config.planMaxTokens).toBe(4096);
  });

  it("parses the DeepSeek switch, fixed model, base URL and env-only key", () => {
    const config = isolatedConfig({
      VIVIC_MAIN_PROVIDER: " DeepSeek ",
      DEEPSEEK_API_KEY: ` ${KEY} `,
      VIVIC_DEEPSEEK_BASE_URL: "https://api.deepseek.test/v1///",
      VIVIC_DEEPSEEK_MODEL: "deepseek-chat",
      VIVIC_PLAN_MAX_TOKENS: "2048",
    });
    expect(config).toMatchObject({
      mainProvider: "deepseek", deepseekBaseUrl: "https://api.deepseek.test/v1",
      deepseekModel: "deepseek-chat", deepseekApiKey: KEY, planMaxTokens: 2048,
    });
  });

  it.each(["stepfun", "other", "", "   "])("keeps %j on the StepFun default", value => {
    expect(isolatedConfig({ VIVIC_MAIN_PROVIDER: value }).mainProvider).toBe("stepfun");
  });

  it.each([
    ["1024", 1024], ["8192", 8192], ["4096", 4096],
    ["1023", 4096], ["8193", 4096], ["4096.5", 4096], ["NaN", 4096], ["", 4096],
  ])("bounds VIVIC_PLAN_MAX_TOKENS=%j to %i", (value, expected) => {
    expect(isolatedConfig({ VIVIC_PLAN_MAX_TOKENS: value }).planMaxTokens).toBe(expected);
  });

  it("rejects an unsafe model id instead of sending it upstream", () => {
    expect(isolatedConfig({ VIVIC_DEEPSEEK_MODEL: "deepseek flash\nPRIVATE" }).deepseekModel).toBe("deepseek-flash");
  });
});

describe("official DeepSeek request body", () => {
  const fetchOnce = () => vi.fn<typeof fetch>(async () => Response.json({
    choices: [{ message: { content: '{"ok":true}' } }],
  }));

  it("uses /chat/completions with the fixed model and thinking disabled", async () => {
    const fetchImpl = fetchOnce();
    const result = await chatJson(credential, [{ role: "user", content: "测试" }],
      { baseUrl: "https://api.deepseek.com/", provider: "deepseek", fetchImpl }, { maxTokens: 4096 });
    expect(result).toEqual({ ok: true, value: { ok: true } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "deepseek-flash", temperature: .2, response_format: { type: "json_object" },
      thinking: { type: "disabled" }, max_tokens: 4096,
    });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("reasoning_effort");
  });

  it("keeps streaming, JSON mode and thinking disabled on the streamed request", async () => {
    const wire = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '{"ok":true}' } }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }));
    const result = await chatJson(credential, [{ role: "user", content: "测试" }],
      { baseUrl: "https://api.deepseek.com", provider: "deepseek", fetchImpl },
      { maxTokens: 4096, onTextDelta: vi.fn<(delta: string) => void>() });
    expect(result).toEqual({ ok: true, value: { ok: true } });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toMatchObject({
      stream: true, thinking: { type: "disabled" }, response_format: { type: "json_object" },
    });
  });

  it("leaves the StepFun Plan body unchanged when no provider is selected", async () => {
    const fetchImpl = fetchOnce();
    await chatJson(credential, [{ role: "user", content: "测试" }],
      { baseUrl: "https://api.stepfun.test/step_plan/v1", fetchImpl }, { maxTokens: 4096 });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(body).not.toHaveProperty("thinking");
    expect(body).toMatchObject({ model: "deepseek-flash", temperature: .2,
      response_format: { type: "json_object" }, max_tokens: 4096 });
  });

  it("never echoes the key in a provider error", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { code: "invalid_api_key", message: `Incorrect API key provided: ${KEY}` },
    }), { status: 401, headers: { "content-type": "application/json" } }));
    const result = await chatJson(credential, [{ role: "user", content: "测试" }],
      { baseUrl: "https://api.deepseek.com", provider: "deepseek", fetchImpl });
    expect(result).toMatchObject({ ok: false, code: "provider", status: 401 });
    expect((result as { error: string }).error).toContain("HTTP 401");
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("DeepSeek app path", () => {
  const deepseekConfig = (overrides: Parameters<typeof testConfig>[0] = {}) => testConfig({
    mainProvider: "deepseek", deepseekApiKey: KEY,
    deepseekBaseUrl: "https://api.deepseek.test", deepseekModel: "deepseek-flash",
    planMaxTokens: 4096, ...overrides,
  });

  it("plans through the official endpoint with the fixed model and no /models discovery", async () => {
    const urls: string[] = [], bodies: Array<Record<string, unknown>> = [], events: unknown[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return chatOk({ reply: "秋叶落在纸上，风把句子吹轻。" });
    });
    const app = createApp({ config: deepseekConfig(), fetchImpl, onDiagnostic: event => events.push(event) });
    try {
      const response = await app.request("/api/intent", { method: "POST", headers: authed,
        body: JSON.stringify({ text: "帮我写一首关于秋天的短诗", canvasContext: emptyContext() }) });
      const body = await response.json();
      expect(body.kind).toBe("envelope");
      // The status slot is still named "stepfun"; the result label must say
      // which provider actually produced it.
      expect(body.usedProvider).toBe("deepseek");
      expect(urls).toEqual(["https://api.deepseek.test/chat/completions"]);
      expect(bodies[0]).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" },
        response_format: { type: "json_object" }, max_tokens: 4096 });
      expect(JSON.stringify(events)).not.toContain(KEY);
      expect(JSON.stringify(body)).not.toContain(KEY);
    } finally { app.dispose(); }
  });

  it("reports the fixed model without leaking the key", async () => {
    const app = createApp({ config: deepseekConfig(), fetchImpl: vi.fn<typeof fetch>() });
    try {
      const response = await app.request("/api/providers/status", { headers: authed });
      const body = await response.json();
      expect(body.providers[0]).toMatchObject({ name: "deepseek", connected: true,
        defaultModel: "deepseek-flash", models: ["deepseek-flash"] });
      expect(JSON.stringify(body)).not.toContain(KEY);
    } finally { app.dispose(); }
  });

  it("fails clearly without DEEPSEEK_API_KEY and never falls back to StepFun", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error("no network expected"); });
    const app = createApp({ config: testConfig({ mainProvider: "deepseek" }), fetchImpl });
    try {
      const response = await app.request("/api/intent", { method: "POST", headers: authed,
        body: JSON.stringify({ text: "帮我写一首关于秋天的短诗", canvasContext: emptyContext() }) });
      const body = await response.json();
      expect(body.kind).toBe("error");
      expect(body.message).toContain("DEEPSEEK_API_KEY");
      expect(body.message).toContain("不会回退 StepFun");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { app.dispose(); }
  });

  it("does not accept a StepFun key in DeepSeek mode", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = createApp({ config: deepseekConfig(), fetchImpl });
    try {
      const response = await app.request("/api/credentials/stepfun/validate", { method: "POST", headers: authed,
        body: JSON.stringify({ apiKey: "TEST-stepfun-key-only" }) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, connected: false });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { app.dispose(); }
  });
});

describe("planner provider label", () => {
  const credentials = new CredentialStore();
  credentials.set(credential);
  const reply = () => vi.fn<typeof fetch>(async () => chatOk({ reply: "好" }));
  const request = { text: "帮我写一首关于秋天的短诗", canvasContext: emptyContext() };
  const shadow: IntentRouter = { mode: "shadow",
    routeUtterance: vi.fn(async () => ({ route: "chat" as const, probability: .9, probabilities: { chat: .9 }, none: false, latencyMs: 1 })),
    chooseTarget: vi.fn(async () => null) };

  it("labels an official DeepSeek answer as deepseek, not stepfun", async () => {
    const result = await runIntent(request, { credentials, mainProvider: "deepseek",
      stepfun: { baseUrl: "https://api.deepseek.test", provider: "deepseek", fetchImpl: reply() } });
    expect(result).toMatchObject({ kind: "envelope", usedProvider: "deepseek" });
  });

  it("keeps the stepfun label when the main provider is unset", async () => {
    const result = await runIntent(request, { credentials,
      stepfun: { baseUrl: "https://unit.test/v1", fetchImpl: reply() } });
    expect(result).toMatchObject({ kind: "envelope", usedProvider: "stepfun" });
  });

  it("carries deepseek into the decision trace and response schema", async () => {
    const result = await runIntent(request, { credentials, mainProvider: "deepseek", router: shadow, slotPlanning: false,
      stepfun: { baseUrl: "https://api.deepseek.test", provider: "deepseek", fetchImpl: reply() } });
    expect(result.trace?.legacyUsedProvider).toBe("deepseek");
    expect(IntentResponseSchema.safeParse(result).success).toBe(true);
  });
});

describe("VIVIC_PLAN_MAX_TOKENS in the planner", () => {
  const setup = (planMaxTokens?: number) => {
    const bodies: Array<Record<string, unknown>> = [];
    const credentials = new CredentialStore();
    credentials.set(credential);
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return chatOk({ reply: "好" });
    });
    const deps = { credentials, stepfun: { baseUrl: "https://unit.test/v1", fetchImpl },
      ...(planMaxTokens === undefined ? {} : { planMaxTokens }) };
    return { deps, bodies };
  };

  it("defaults to 4096 instead of the old 8192", async () => {
    const { deps, bodies } = setup();
    await runIntent({ text: "帮我写一首关于秋天的短诗", canvasContext: emptyContext() }, deps);
    expect(bodies[0]!.max_tokens).toBe(4096);
  });

  it("honors an explicit env-style override up to 8192", async () => {
    const { deps, bodies } = setup(8192);
    await runIntent({ text: "帮我写一首关于秋天的短诗", canvasContext: emptyContext() }, deps);
    expect(bodies[0]!.max_tokens).toBe(8192);
  });

  it("keeps reminder planning at 4096 even when the cap is raised", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const credentials = new CredentialStore();
    credentials.set(credential);
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return chatOk({ reminders: [{ afterSeconds: 300, text: "喝水" }] });
    });
    await runIntent({ text: "请在五分钟后提醒我喝水", canvasContext: emptyContext() }, {
      credentials, stepfun: { baseUrl: "https://unit.test/v1", fetchImpl }, planMaxTokens: 8192,
    });
    expect(bodies[0]!.max_tokens).toBe(4096);
  });
});
