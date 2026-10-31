import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createApp } from "../src/app.js";
import { createOnlineSessionApp } from "../src/online/appFactory.js";
import { CredentialStore } from "../src/credentials.js";
import { GptProvider } from "../src/gpt/provider.js";
import { STEPFUN_PLAN_BASE_URL } from "../src/config.js";
import { authed, chatOk, emptyContext, modelsOk, testConfig, TEST_TOKEN } from "./helpers.js";

const ORIGIN = "https://vivic.example";
const KEY_A = "TEST-online-private-A";
const KEY_B = "TEST-online-private-B";
const sessions: Array<{ dispose(): void }> = [];
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.restoreAllMocks(); });
function online(fetchImpl?: typeof fetch) {
  const session = createOnlineSessionApp({ token: TEST_TOKEN, origin: ORIGIN }, { fetchImpl });
  sessions.push(session);
  const request = (route: string, body?: unknown, signal?: AbortSignal) => Promise.resolve(session.fetch(new Request(`${ORIGIN}${route}`, {
    method: body === undefined ? "GET" : "POST", headers: { ...authed, origin: ORIGIN },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}),
  })));
  return { ...session, request };
}
const keyOf = (init?: RequestInit) => new Headers(init?.headers).get("authorization");

describe("online app assembly", () => {
  it("isolates validated keys and uses only fixed official endpoints", async () => {
    const observed: Array<{ url: string; key: string | null }> = [];
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input); observed.push({ url, key: keyOf(init) });
      if (url === "https://api.stepfun.com/v1/models") return modelsOk(["step-3.5-flash"]);
      if (url === `${STEPFUN_PLAN_BASE_URL}/chat/completions`) return chatOk({ ok: true });
      throw new Error("Unexpected TEST endpoint");
    });
    const a = online(upstream), b = online(upstream);
    expect(await (await a.request("/api/credentials/stepfun/validate", { apiKey: KEY_A })).json()).toMatchObject({ connected: true });
    expect(await (await b.request("/api/providers/status")).json()).toMatchObject({ activeProvider: "stepfun", providers: [{ connected: false }] });
    expect(await (await b.request("/api/credentials/stepfun/validate", { apiKey: KEY_B })).json()).toMatchObject({ connected: true });
    const statusA = await (await a.request("/api/providers/status")).json();
    expect(statusA.providers).toHaveLength(1);
    expect(statusA.providers[0]).toMatchObject({ name: "stepfun", connected: true });
    expect(JSON.stringify(statusA)).not.toMatch(/TEST-online-private|Bearer/);
    expect(observed.map(call => call.key)).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_A}`, `Bearer ${KEY_B}`, `Bearer ${KEY_B}`]);
    await a.request("/api/credentials/stepfun/disconnect", {});
    expect(await (await b.request("/api/providers/status")).json()).toMatchObject({ providers: [{ connected: true }] });
  });

  it("never reads local auth/mobile/cache or preferences and rejects local routes", async () => {
    const exists = vi.spyOn(fs, "existsSync");
    const read = vi.spyOn(fs, "readFileSync");
    const stat = vi.spyOn(fsPromises, "stat");
    const gpt = new GptProvider();
    const connect = vi.spyOn(gpt, "connect");
    const startLogin = vi.spyOn(gpt, "startLogin");
    const preferences = { read: vi.fn(() => ({ activeProvider: "gpt", gptSource: "pi" })), update: vi.fn() };
    const app = createApp({ mode: "online", config: testConfig({ managedDecisionEnabled: true }), gpt,
      preferences: preferences as never });
    sessions.push(app);
    const status = await (await app.request("/api/providers/status", { headers: authed })).json();
    expect(status.providers.map((provider: { name: string }) => provider.name)).toEqual(["stepfun"]);
    for (const route of ["/api/gpt/login/status", "/api/gpt/connect", "/api/gpt/login/start", "/api/mobile/status", "/api/mobile/session",
      "/api/decision/models", "/api/decision/prepare", "/api/decision/enable", "/api/decision/clear", "/api/decision/stop"]) {
      expect((await app.request(route, { method: route.endsWith("status") || route.endsWith("models") ? "GET" : "POST", headers: authed,
        body: route.endsWith("status") || route.endsWith("models") ? undefined : "{}" })).status).toBe(404);
    }
    for (const route of ["/api/providers/select", "/api/providers/model"]) {
      expect((await app.request(route, { method: "POST", headers: authed, body: JSON.stringify({ provider: "gpt", ...(route.endsWith("model") ? { model: "gpt-test" } : {}) }) })).status).toBe(400);
    }
    expect(await (await app.request("/api/decision/status", { headers: authed })).json()).toMatchObject({ enabled: false, bytes: 0 });
    app.dispose();
    expect(preferences.read).not.toHaveBeenCalled(); expect(preferences.update).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled(); expect(startLogin).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled();
  });

  it("a disconnected validation cannot restore its key after a late catalog result", async () => {
    let release!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const catalog = new Promise<Response>(resolve => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/models")) { entered(); return catalog; }
      return chatOk({ ok: true });
    });
    const session = online(fetchImpl);
    const pending = session.request("/api/credentials/stepfun/validate", { apiKey: KEY_A });
    await started;
    await session.request("/api/credentials/stepfun/disconnect", {});
    release(modelsOk(["step-3.5-flash"]));
    expect((await pending).status).toBe(409);
    expect(await (await session.request("/api/providers/status")).json()).toMatchObject({ providers: [{ connected: false }] });
  });

  it.each(["dispose", "request-abort"])("%s aborts upstream validation and cannot store late credentials", async action => {
    let seenSignal: AbortSignal | undefined, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      seenSignal = init?.signal ?? undefined; entered();
      return new Promise<Response>(() => {}); // Simulates an upstream that ignores cancellation.
    });
    const credentials = new CredentialStore();
    const app = createApp({ mode: "online", config: testConfig({ requestTimeoutMs: 1000 }), credentials, fetchImpl });
    sessions.push(app);
    const controller = new AbortController();
    const pending = app.request("/api/credentials/stepfun/validate", { method: "POST", headers: authed, body: JSON.stringify({ apiKey: KEY_A }), signal: controller.signal });
    await started;
    if (action === "dispose") app.dispose(); else controller.abort();
    expect((await pending).status).toBe(409);
    expect(seenSignal?.aborted).toBe(true);
    expect(credentials.getSecret()).toBeUndefined();
  });

  it("a newer successful connection survives an older cancelled validation", async () => {
    let firstSignal: AbortSignal | undefined, entered!: () => void, release!: (value: Response) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const oldCatalog = new Promise<Response>(resolve => { release = resolve; });
    const session = online(vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/models") && keyOf(init) === `Bearer ${KEY_A}`) {
        firstSignal = init?.signal ?? undefined; entered(); return oldCatalog;
      }
      return String(input).endsWith("/models") ? modelsOk(["step-3.5-flash"]) : chatOk({ ok: true });
    }));
    const old = session.request("/api/credentials/stepfun/validate", { apiKey: KEY_A });
    await started;
    expect(await (await session.request("/api/credentials/stepfun/validate", { apiKey: KEY_B })).json()).toMatchObject({ connected: true });
    expect(firstSignal?.aborted).toBe(true);
    release(new Response(null, { status: 401 }));
    expect((await old).status).toBe(409);
    expect(await (await session.request("/api/providers/status")).json()).toMatchObject({ providers: [{ connected: true }] });
  });

  it("app disposal clears an already validated memory credential", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: KEY_A, defaultModel: "step-3.5-flash", models: ["step-3.5-flash"], checkedAt: "TEST" });
    const app = createApp({ mode: "online", config: testConfig(), credentials }); sessions.push(app);
    app.dispose();
    expect(credentials.getSecret()).toBeUndefined();
  });

  it("disposal aborts all factory work and destroys memory without deleting saved OAuth", async () => {
    let entered!: () => void, signal: AbortSignal | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => { signal = init?.signal ?? undefined; entered(); return new Promise<Response>(() => {}); });
    const disconnect = vi.spyOn(GptProvider.prototype, "disconnect");
    const session = online(fetchImpl);
    const pending = session.request("/api/credentials/stepfun/validate", { apiKey: KEY_A });
    await started; session.dispose();
    expect(signal?.aborted).toBe(true);
    expect((await pending).status).toBe(409);
    expect((await session.request("/api/providers/status")).status).toBe(410);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("missing or stale browser position always clarifies without server IP lookup", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error("No network expected"); });
    const session = online(fetchImpl);
    for (const route of ["/api/locale", "/api/weather/here"]) {
      expect(await (await session.request(route, {})).json()).toMatchObject({ kind: "clarify" });
    }
    for (const text of ["我在哪里", "天气"]) {
      expect(await (await session.request("/api/intent", { text, canvasContext: emptyContext() })).json()).toMatchObject({ kind: "clarify" });
    }
    expect(await (await session.request("/api/locale", { deviceLocation: { latitude: 31.23, longitude: 121.47, accuracyM: 100,
      capturedAt: new Date(Date.now() - 86400000).toISOString() } })).json()).toMatchObject({ kind: "clarify" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("honors an authorized fresh browser fix without network-region fallback", async () => {
    const urls: string[] = [];
    const session = online(vi.fn<typeof fetch>(async input => {
      const url = String(input); urls.push(url);
      if (!url.includes("photon")) throw new Error("Only reverse geocoding expected");
      return Response.json({ features: [{ properties: { city: "上海市", state: "上海市", country: "中国", countrycode: "cn" } }] });
    }));
    const result = await (await session.request("/api/locale", { deviceLocation: { latitude: 31.23, longitude: 121.47, accuracyM: 100,
      capturedAt: new Date().toISOString() } })).json();
    expect(result).toMatchObject({ kind: "locale", locale: { basis: "device", name: "上海市" } });
    expect(urls).toHaveLength(1); expect(urls[0]).toContain("photon");
  });

  it("validates cloud model output through the existing Action boundary", async () => {
    let reply: unknown = { ok: true };
    const session = online(vi.fn<typeof fetch>(async input => String(input).endsWith("/models") ? modelsOk(["step-3.5-flash"]) : chatOk(reply)));
    await session.request("/api/credentials/stepfun/validate", { apiKey: KEY_A });
    reply = { cards: [{ scene_id: "quote_note", data: { text: "好的设计，是让人感觉不到设计。", source: "《设计心理学》", tag: "阅读" } }] };
    const result = await (await session.request("/api/intent", { text: "记一句今天读到的话：“好的设计，是让人感觉不到设计。”——来自《设计心理学》", canvasContext: emptyContext() })).json();
    expect(result).toMatchObject({ kind: "envelope", usedProvider: "stepfun" });
    expect(result.envelope.actions.some((action: { type: string }) => action.type === "card.create")).toBe(true);
    reply = { actions: [{ type: "shell.exec", command: "TEST never execute" }] };
    const rejected = await (await session.request("/api/intent", { text: "做一下这个复杂任务", canvasContext: emptyContext() })).json();
    expect(rejected.kind).not.toBe("envelope");
    expect(JSON.stringify(rejected)).not.toContain("TEST never execute");
  });
});
