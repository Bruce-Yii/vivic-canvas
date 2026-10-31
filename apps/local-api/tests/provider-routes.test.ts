import { describe, expect, it } from "vitest";
import { ProviderClient } from "../src/providers/client.js";
import { createProviderRoutes } from "../src/providers/routes.js";
import { ProviderStore, type ProviderStoreOptions, type SecretCodec } from "../src/providers/store.js";
import { fetchStub } from "./helpers.js";

const codec: SecretCodec = {
  encrypt: (plain) => `enc:${Buffer.from(plain).toString("base64")}`,
  decrypt: (blob) => blob?.startsWith("enc:") ? Buffer.from(blob.slice(4), "base64").toString("utf8") : undefined,
};

const API_KEY = "sk-route-secret-0123456789";

const memoryFs = () => {
  const files = new Map<string, string>();
  return {
    existsSync: (path: string) => files.has(path),
    readFileSync: (path: string) => files.get(path) ?? "",
    writeFileSync: (path: string, data: string) => { files.set(path, String(data)); },
    mkdirSync: () => undefined,
  } as unknown as NonNullable<ProviderStoreOptions["fs"]>;
};

const makeApp = (routes: Record<string, (init?: RequestInit) => Response | Promise<Response>> = {}) => {
  const store = new ProviderStore({ dataDir: "/mem", secrets: codec, fs: memoryFs() });
  const client = new ProviderClient({ fetchImpl: fetchStub(routes) });
  const app = createProviderRoutes({ store, client });
  return { app, store };
};

const create = async (app: ReturnType<typeof makeApp>["app"], overrides: Record<string, unknown> = {}) => {
  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "测试平台",
      protocol: "openai-compatible",
      baseUrl: "https://api.example.test/v1",
      apiKey: API_KEY,
      model: "gpt-4o-mini",
      roles: ["main"],
      ...overrides,
    }),
  });
  return { response, body: await response.json() as Record<string, unknown> };
};

const chatOk = () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
  status: 200, headers: { "content-type": "application/json" },
});

describe("provider routes", () => {
  it("lists the preset catalogue", async () => {
    const { app } = makeApp();
    const body = await (await app.request("/presets")).json() as { presets: Array<{ id: string }> };
    expect(body.presets.length).toBeGreaterThan(10);
    expect(body.presets.map((preset) => preset.id)).toContain("ollama");
  });

  it("creates a provider and never returns the key", async () => {
    const { app } = makeApp();
    const { response, body } = await create(app);
    expect(response.status).toBe(201);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(API_KEY);
    const provider = body.provider as Record<string, unknown>;
    expect(provider.hasApiKey).toBe(true);
    expect(provider.apiKeyHint).toBeTruthy();
    expect(provider.apiKey).toBeUndefined();
  });

  it("rejects an invalid configuration with a readable reason", async () => {
    const { app } = makeApp();
    const badUrl = await create(app, { baseUrl: "not-a-url" });
    expect(badUrl.response.status).toBe(400);
    expect(String(badUrl.body.error)).toMatch(/地址/);

    const badCombo = await create(app, { model: "startlux-decision-4b" });
    expect(badCombo.response.status).toBe(400);
    expect(String(badCombo.body.error)).toMatch(/4B/);
  });

  it("lists providers without keys and updates one in place", async () => {
    const { app } = makeApp();
    const { body } = await create(app);
    const id = (body.provider as { id: string }).id;

    const listed = await (await app.request("/")).json() as { providers: Array<Record<string, unknown>> };
    expect(listed.providers).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(API_KEY);

    const patched = await app.request(`/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o" }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { provider: { model: string } }).provider.model).toBe("gpt-4o");

    const deleted = await app.request(`/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    const empty = await (await app.request("/")).json() as { providers: unknown[] };
    expect(empty.providers).toHaveLength(0);
  });

  it("404s unknown providers", async () => {
    const { app } = makeApp();
    expect((await app.request("/missing/test", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request("/missing", { method: "DELETE" })).status).toBe(404);
  });

  it("tests a provider with a real inference and reports latency", async () => {
    const { app } = makeApp({ "/chat/completions": chatOk, "/models": () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), { status: 200 }) });
    const { body } = await create(app);
    const id = (body.provider as { id: string }).id;

    const tested = await app.request(`/${id}/test`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    const result = await tested.json() as Record<string, unknown>;
    expect(tested.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.model).toBe("gpt-4o-mini");
    expect(JSON.stringify(result)).not.toContain(API_KEY);

    // The status endpoint now reflects the recorded probe.
    const status = await (await app.request("/")).json() as { providers: Array<Record<string, unknown>> };
    expect(status.providers[0]!.connected).toBe(true);
    expect(status.providers[0]!.latencyMs).toBeTypeOf("number");
  });

  it("returns a typed error and status for a failed test", async () => {
    const { app } = makeApp({ "/chat/completions": () => new Response("no", { status: 401 }) });
    const { body } = await create(app);
    const id = (body.provider as { id: string }).id;

    const tested = await app.request(`/${id}/test`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(tested.status).toBe(401);
    const result = await tested.json() as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.errorType).toBe("auth");
  });

  it("tests a stored ASR-only provider on the transcription route", async () => {
    const calls: string[] = [];
    const store = new ProviderStore({ dataDir: "/mem", secrets: codec, fs: memoryFs() });
    const client = new ProviderClient({ fetchImpl: fetchStub({
      "/audio/transcriptions": () => new Response(JSON.stringify({ text: "你好" }), {
        status: 200, headers: { "content-type": "application/json" } }),
    }, url => calls.push(url)) });
    const app = createProviderRoutes({ store, client });
    const { body } = await create(app, { roles: ["asr"], model: "stepaudio-2.5-asr",
      baseUrl: "https://api.stepfun.com/v1" });
    const id = (body.provider as { id: string }).id;

    const tested = await app.request(`/${id}/test`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    const result = await tested.json() as Record<string, unknown>;
    expect(tested.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.model).toBe("stepaudio-2.5-asr");
    // Chat/completions would be a guaranteed 404 for a pure ASR provider; the
    // probe is a real transcription (a successful probe may also list models).
    expect(calls[0]).toBe("https://api.stepfun.com/v1/audio/transcriptions");
    expect(calls.some(url => url.endsWith("/chat/completions"))).toBe(false);
  });

  it("follows unsaved roles overrides in the test body", async () => {
    const calls: string[] = [];
    const store = new ProviderStore({ dataDir: "/mem", secrets: codec, fs: memoryFs() });
    const client = new ProviderClient({ fetchImpl: fetchStub({
      "/audio/transcriptions": () => new Response(JSON.stringify({ text: "" }), { status: 200 }),
    }, url => calls.push(url)) });
    const app = createProviderRoutes({ store, client });
    const { body } = await create(app);
    const id = (body.provider as { id: string }).id;

    const tested = await app.request(`/${id}/test`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ roles: ["asr"], model: "stepaudio-2.5-asr" }),
    });
    expect((await tested.json() as Record<string, unknown>).ok).toBe(true);
    expect(calls[0]).toBe("https://api.example.test/v1/audio/transcriptions");
    expect(calls.some(url => url.endsWith("/chat/completions"))).toBe(false);
  });

  it("rejects a 4B model on the legacy protocol before calling upstream", async () => {
    let called = false;
    const { app } = makeApp();
    const client = new ProviderClient({
      fetchImpl: (async () => { called = true; return new Response("{}"); }) as typeof fetch,
    });
    const store = new ProviderStore({ dataDir: "/mem", secrets: codec, fs: memoryFs() });
    const routes = createProviderRoutes({ store, client });
    // Store a valid 4B provider, then test it with a legacy override.
    const created = await routes.request("/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "gw", protocol: "startlux-native",
        baseUrl: "https://gw.example.test/api/v1", model: "startlux-decision-4b", roles: ["decision"] }),
    });
    const id = ((await created.json()) as { provider: { id: string } }).provider.id;

    const tested = await routes.request(`/${id}/test`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol: "legacy-2b", model: "startlux-decision-4b" }),
    });
    expect(tested.status).toBe(400);
    const result = await tested.json() as Record<string, unknown>;
    expect(result.errorType).toBe("protocol");
    expect(called).toBe(false);
    void app;
  });

  it("proxies the model catalogue", async () => {
    const { app } = makeApp({ "/models": () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "bge-m3" }] }), { status: 200 }) });
    const { body } = await create(app);
    const id = (body.provider as { id: string }).id;

    const models = await app.request(`/${id}/models`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(models.status).toBe(200);
    const result = await models.json() as { ok: boolean; models: Array<{ id: string; kind: string }> };
    expect(result.ok).toBe(true);
    expect(result.models.map((model) => model.id)).toEqual(["gpt-4o", "bge-m3"]);
    expect(result.models.find((model) => model.id === "bge-m3")!.kind).toBe("embedding");
  });

  it("falls back to preset models when the catalogue endpoint is missing", async () => {
    const { app } = makeApp({ "/models": () => new Response("nope", { status: 404 }) });
    const { body } = await create(app, { presetId: "moonshot", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" });
    const id = (body.provider as { id: string }).id;

    const models = await app.request(`/${id}/models`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    const result = await models.json() as { ok: boolean; fallback?: boolean; models: Array<{ id: string }> };
    expect(result.ok).toBe(true);
    expect(result.fallback).toBe(true);
    expect(result.models.map((model) => model.id)).toContain("moonshot-v1-8k");
  });
});
