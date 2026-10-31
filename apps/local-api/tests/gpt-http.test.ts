import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import { GptProvider } from "../src/gpt/provider.js";
import { GPT_MODELS, GPT_RESPONSES } from "../src/gpt/transport.js";
import { IntentResponseSchema } from "../src/schemas.js";
import { authed, emptyContext, testConfig } from "./helpers.js";
import type { PreferenceStore, ProviderPreferences } from "../src/preferences.js";

// Every route runs through the real Hono middleware, GPT provider, Pi SDK,
// intent pipeline and search adapter. No real login, socket, disk auth or TTS
// playback: in-memory credentials and injected TEST HTTP replies only.
vi.mock("../src/search/transport.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/search/transport.js")>(),
  requestPublicHttps: vi.fn(() => { throw new Error("TEST forbids fallback Exa/page network"); }),
}));
import { requestPublicHttps } from "../src/search/transport.js";
import { STEPSEARCH_ENDPOINT } from "../src/search/stepsearch.js";
import { EXA_MCP_URL } from "../src/search/upstream/exa.js";

const ACCESS = "TEST-http-gpt-access";
const REFRESH = "TEST-http-gpt-refresh";
const STEP_KEY = "TEST-independent-stepfun-speech-key";
const MODEL = "gpt-test-http-text";
const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]);
const frame = (type: string, rest: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
const notePlan = (text: string) => ({ actions: [{ type: "card.create", card: {
  id: "TEST-gpt-note", type: "NoteCard", variant: "minimal", displayProps: { text }, sourceData: {}, sources: [],
  layout: { x: 0, y: 0, width: 264, height: 120, pinned: false },
  metadata: { createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z", aliases: ["TEST / DEMO"] },
} }] });

function piSse(value: unknown) {
  const text = JSON.stringify(value);
  const item = { id: "msg_TEST_HTTP", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return new Response([
    frame("response.created", { response: { id: "resp_TEST_HTTP", status: "in_progress" } }),
    frame("response.output_item.added", { output_index: 0, item: { ...item, content: [], status: "in_progress" } }),
    frame("response.output_text.delta", { output_index: 0, content_index: 0, delta: text }),
    frame("response.output_item.done", { output_index: 0, item }),
    frame("response.completed", { response: { id: "resp_TEST_HTTP", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

function searchSse(contentType: string | null = "text/event-stream", outputInDone = false) {
  const output = [
    { id: "TEST-web", type: "web_search_call", status: "completed", action: { type: "search", query: "TEST", sources: [] } },
    { id: "TEST-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "TEST sourced fact.", annotations: [{ type: "url_citation", url: "https://example.com/test", title: "TEST citation", start_index: 0, end_index: 18 }] }] },
  ];
  const wire = (outputInDone ? output.map((item, output_index) => frame("response.output_item.done", { output_index, item })).join("") : "")
    + frame("response.completed", { response: { id: "TEST-search", status: "completed", error: null, output: outputInDone ? [] : output } });
  return new Response(new TextEncoder().encode(wire), contentType ? { headers: { "content-type": contentType } } : {});
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(stepfunConnected = true) {
  const ownStorage = new InMemoryCredentialStore();
  const piStorage = new InMemoryCredentialStore();
  await piStorage.modify("openai", async () => ({ type: "oauth", access: ACCESS, refresh: REFRESH, expires: Date.UTC(2100, 0, 1) }));
  const credentials = new CredentialStore();
  if (stepfunConnected) credentials.set({ apiKey: STEP_KEY, models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "TEST" });
  let answer: (body: Record<string, unknown>, init?: RequestInit) => Response | Promise<Response> = () => piSse({ ok: true });
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === GPT_MODELS) return Response.json({ models: [{ slug: MODEL, visibility: "list" }, { slug: "gpt-test-http-other", visibility: "list" }] });
    if (url === GPT_RESPONSES) return answer(JSON.parse(String(init?.body)), init);
    if (url === "https://unit.test/v1/audio/speech") return new Response(AUDIO, { headers: { "content-type": "audio/mpeg" } });
    throw new Error(`TEST forbids endpoint/fallback: ${url}`);
  });
  const gpt = new GptProvider({ ownStorage, piStorage, fetchImpl });
  const app = createApp({ config: testConfig({ searchEnabled: true }), credentials, gpt, fetchImpl });
  const post = (path: string, body: unknown = {}) => app.request(path, { method: "POST", headers: authed, body: JSON.stringify(body) });
  const get = (path: string) => app.request(path, { headers: authed });
  const connect = async () => {
    const response = await post("/api/gpt/connect", { source: "pi" });
    expect(await response.json()).toMatchObject({ ok: true, connected: true, defaultModel: MODEL });
    expect(await (await post("/api/providers/select", { provider: "gpt" })).json()).toEqual({ ok: true, activeProvider: "gpt" });
    fetchImpl.mockClear();
  };
  const intent = () => post("/api/intent", { text: "帮我梳理这段项目思路", canvasContext: emptyContext() });
  return { app, gpt, credentials, piStorage, ownStorage, fetchImpl, post, get, connect, intent, answer: (next: typeof answer) => { answer = next; } };
}

// Only tests asserting the failed-GPT search fallback may reach keyless search.
let keylessFallbackExpected = false;
beforeEach(() => {
  keylessFallbackExpected = false;
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("TEST forbids ambient network"); }));
  vi.mocked(requestPublicHttps).mockClear();
});
afterEach(() => {
  const networkCalls = vi.mocked(fetch).mock.calls.length;
  const fallbackCalls = vi.mocked(requestPublicHttps).mock.calls.length;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  expect(networkCalls, "No test may attempt ambient HTTP/OAuth refresh").toBe(0);
  if (!keylessFallbackExpected) expect(fallbackCalls, "GPT must never reach native Exa/page fallback transport").toBe(0);
});

describe("GPT app routes through real Pi completions", () => {
  it("selected GPT uses its own verified model and never falls back to connected StepFun", async () => {
    const f = await fixture(); await f.connect();
    f.answer(() => piSse(notePlan("TEST GPT response")));
    const response = await f.intent();
    expect(await response.json()).toMatchObject({ kind: "envelope", usedProvider: "gpt", envelope: notePlan("TEST GPT response") });
    expect(f.fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([GPT_RESPONSES]);
    const status = await f.get("/api/providers/status");
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.json()).toMatchObject({ activeProvider: "gpt", providers: [{ name: "stepfun", connected: true }, { name: "gpt", connected: true }] });
    const body = JSON.parse(String(f.fetchImpl.mock.calls[0]![1]?.body));
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).toMatchObject({ model: MODEL, store: false, stream: true });
    await f.gpt.disconnect();
  });

  it("active GPT and StepFun speech key remain independent across either disconnect", async () => {
    const f = await fixture(); await f.connect();
    f.answer(() => piSse(notePlan("TEST text only")));
    const speech = await f.post("/api/speech", { text: "TEST speech" });
    expect(speech.status).toBe(200);
    expect(new Uint8Array(await speech.arrayBuffer())).toEqual(AUDIO);
    const speechInit = f.fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/audio/speech"))![1];
    expect(new Headers(speechInit?.headers).get("authorization")).toBe(`Bearer ${STEP_KEY}`);
    expect(String(speechInit?.body)).not.toContain(ACCESS);
    await f.post("/api/credentials/stepfun/disconnect");
    expect((await f.post("/api/speech", { text: "TEST no key" })).status).toBe(503);
    expect(await (await f.intent()).json()).toMatchObject({ kind: "envelope", usedProvider: "gpt" });
    expect(f.gpt.status().connected).toBe(true);
    f.credentials.set({ apiKey: STEP_KEY, models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "TEST" });
    await f.post("/api/gpt/disconnect");
    expect((await f.post("/api/speech", { text: "TEST separate key" })).status).toBe(200);
    expect(f.credentials.status().connected).toBe(true);
    expect(await (await f.get("/api/providers/status")).json()).toMatchObject({ activeProvider: "gpt" });
    expect(f.fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/chat/completions"))).toBe(false);
  });

  it("GPT without StepFun speech supports plain-text planning and reports speech unavailable", async () => {
    const f = await fixture(false); await f.connect();
    expect(f.gpt.status().capabilities).toEqual(["chat", "structured"]);
    f.answer(() => piSse(notePlan("TEST plain text")));
    expect(await (await f.intent()).json()).toMatchObject({ kind: "envelope", usedProvider: "gpt" });
    expect(await (await f.post("/api/speech", { text: "TEST" })).json()).toMatchObject({ ok: false, code: "speech-disconnected" });
    expect(f.fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([GPT_RESPONSES]);
    await f.gpt.disconnect();
  });

  it("a disconnected selected GPT uses local rules, never an available StepFun planner", async () => {
    const f = await fixture();
    await f.post("/api/providers/select", { provider: "gpt" });
    expect(await (await f.intent()).json()).toMatchObject({ kind: "unknown", usedProvider: "rules-offline", message: expect.stringContaining("GPT") });
    const rule = await f.post("/api/intent", { text: "创建一个一分钟倒计时", canvasContext: emptyContext() });
    expect(await rule.json()).toMatchObject({ kind: "envelope", usedProvider: "rules" });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["disconnect", "provider", "model"] as const)("drops a late GPT intent after %s changes", async change => {
    const f = await fixture(); await f.connect();
    const entered = deferred<AbortSignal>(); const late = deferred<Response>();
    f.answer((body, init) => {
      if (body.model === "gpt-test-http-other") return piSse({ ok: true });
      entered.resolve(init!.signal!); return late.promise;
    });
    const pending = f.intent();
    const signal = await entered.promise;
    if (change === "disconnect") await f.post("/api/gpt/disconnect");
    if (change === "provider") await f.post("/api/providers/select", { provider: "stepfun" });
    if (change === "model") expect(await (await f.post("/api/providers/model", { provider: "gpt", model: "gpt-test-http-other" })).json()).toMatchObject({ ok: true, connected: true });
    if (change !== "provider") expect(signal.aborted).toBe(true);
    late.resolve(piSse(notePlan("TEST stale must not execute")));
    const result = await (await pending).json();
    expect(result).toMatchObject({ kind: "error", usedProvider: "gpt" });
    expect(result).not.toHaveProperty("envelope");
    expect(JSON.stringify(result)).not.toContain("TEST stale must not execute");
    await f.gpt.disconnect();
  });

  it("upstream HTTP error body, trace headers, refresh/access tokens never reach GPT route responses", async () => {
    const f = await fixture(); await f.connect();
    f.answer(() => Response.json({ error: { message: `PRIVATE ${ACCESS} ${REFRESH} ${STEP_KEY}`, code: ACCESS } }, { status: 403, headers: { "x-request-id": REFRESH, "set-cookie": `secret=${ACCESS}`, authorization: `Bearer ${ACCESS}` } }));
    const responses = [await f.intent(), await f.post("/api/gpt/connect", { source: "pi" }), await f.get("/api/providers/status"), await f.get("/api/gpt/login/status")];
    for (const response of responses) {
      const output = `${JSON.stringify([...response.headers])} ${await response.text()}`;
      expect(output).not.toMatch(/PRIVATE|TEST-http-gpt-access|TEST-http-gpt-refresh|TEST-independent-stepfun-speech-key|set-cookie/);
    }
    expect(f.gpt.status().connected).toBe(false);
  });

  it("authentication-storage failures never echo raw messages, credential paths or tokens", async () => {
    keylessFallbackExpected = true;
    const f = await fixture(); await f.connect();
    vi.spyOn(f.piStorage, "read").mockRejectedValue(new Error(`PRIVATE /Users/TEST/.pi/agent/auth.json ${ACCESS} ${REFRESH}`));
    const search = await f.post("/api/search", { query: "TEST" });
    expect(search.status).toBe(502);
    const result = await search.json();
    expect(result).toMatchObject({ ok: false, code: "search-unavailable" });
    const connect = await f.post("/api/gpt/connect", { source: "pi" });
    const failed = await connect.json();
    expect(failed).toMatchObject({ ok: false, connected: false });
    expect(JSON.stringify([result, failed, f.gpt.loginStatus()])).not.toMatch(/PRIVATE|\/Users\/TEST|auth\.json|TEST-http-gpt-access|TEST-http-gpt-refresh|TEST-independent/);
    // The failed GPT search continued only through the other search routes.
    expect(f.fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([STEPSEARCH_ENDPOINT]);
    expect(vi.mocked(requestPublicHttps).mock.calls.map(([url]) => url)).toEqual([EXA_MCP_URL]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses model output that asks for coding tools and exposes no tool-execution endpoint", async () => {
    const f = await fixture(); await f.connect();
    f.answer(() => piSse({ actions: [{ type: "bash", command: "TEST never execute" }] }));
    const result = await (await f.intent()).json();
    expect(result).toMatchObject({ kind: "clarify" });
    expect(result).not.toHaveProperty("envelope");
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    for (const path of ["/api/bash", "/api/read", "/api/write", "/api/edit", "/api/tools/call"]) expect((await f.post(path, { command: "TEST" })).status).toBe(404);
    for (const [, init] of f.fetchImpl.mock.calls) expect(JSON.parse(String(init?.body))).not.toHaveProperty("tools");
    expect(requestPublicHttps).not.toHaveBeenCalled();
    await f.gpt.disconnect();
  });

  it.each([
    ["/api/providers/select", { provider: "anthropic" }],
    ["/api/providers/select", { provider: "openai" }],
    ["/api/providers/select", { provider: "gpt", endpoint: "https://evil.test" }],
    ["/api/providers/model", { provider: "anthropic", model: MODEL }],
    ["/api/providers/model", { provider: "gpt", model: "https://evil.test/model" }],
    ["/api/providers/model", { provider: "gpt", model: MODEL, baseUrl: "https://evil.test" }],
    ["/api/gpt/connect", { source: "anthropic" }],
    ["/api/gpt/connect", { source: "pi", endpoint: "https://evil.test" }],
    ["/api/gpt/connect", { source: "pi", apiKey: ACCESS }],
    ["/api/gpt/login/start", { endpoint: "https://evil.test" }],
    ["/api/gpt/login/start", { provider: "anthropic" }],
  ] as const)("rejects unsupported provider/config on %s before any fetch or login", async (path, body) => {
    const f = await fixture();
    expect((await f.post(path, body)).status).toBe(400);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.gpt.loginStatus()).toEqual({ phase: "idle" });
  });

  it.each(["/api/gpt/connect", "/api/gpt/disconnect", "/api/gpt/login/start", "/api/gpt/login/input", "/api/gpt/login/cancel", "/api/providers/select", "/api/providers/model"])("requires local bearer for %s without starting any OAuth callback", async path => {
    const f = await fixture();
    const response = await f.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.gpt.loginStatus()).toEqual({ phase: "idle" });
  });

  it("idle login status/input/cancel routes never access auth files or start authorization", async () => {
    const f = await fixture();
    const status = await f.get("/api/gpt/login/status");
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.json()).toMatchObject({ login: { phase: "idle" }, provider: { connected: false } });
    expect(await (await f.post("/api/gpt/login/input", { value: "TEST unused callback" })).json()).toEqual({ ok: false });
    expect(await (await f.post("/api/gpt/login/cancel")).json()).toEqual({ ok: true });
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { contentType: "text/event-stream", outputInDone: false },
    { contentType: null, outputInDone: false },
    { contentType: "text/event-stream", outputInDone: true },
    { contentType: null, outputInDone: true },
  ])("routes GPT search with Content-Type $contentType, done-items $outputInDone through completed citations", async ({ contentType, outputInDone }) => {
    const f = await fixture(); await f.connect();
    f.answer(body => {
      expect(body.tools).toEqual([{ type: "web_search" }]);
      const upstream = searchSse(contentType, outputInDone);
      expect(upstream.headers.get("content-type")).toBe(contentType);
      return upstream;
    });
    const response = await f.post("/api/search", { query: "TEST React libraries" });
    expect(await response.json()).toMatchObject({ ok: true, results: [{ title: "TEST citation", url: "https://example.com/test", provider: "pi-web-access/gpt-oauth", readFullPage: false }] });
    const intent = await f.post("/api/intent", { text: "搜索 TEST React libraries", canvasContext: emptyContext() });
    const result = IntentResponseSchema.parse(await intent.json());
    expect(result).toMatchObject({ kind: "envelope", usedProvider: "search" });
    expect(result.envelope?.actions.some(action => action.type === "card.create" && action.card.type === "SearchResultCard" && action.card.sources[0]?.provider === "pi-web-access/gpt-oauth")).toBe(true);
    expect(f.fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([GPT_RESPONSES, GPT_RESPONSES]);
    expect(requestPublicHttps).not.toHaveBeenCalled();
    await f.gpt.disconnect();
  });

  it("search with a disconnected selected GPT skips GPT and tries StepSearch, then keyless search", async () => {
    keylessFallbackExpected = true;
    const f = await fixture(); await f.post("/api/providers/select", { provider: "gpt" });
    const response = await f.post("/api/search", { query: "TEST" });
    expect(response.status).toBe(502);
    const result = await response.json();
    expect(result).toMatchObject({ ok: false, code: "search-unavailable", error: expect.stringContaining("StepSearch、公共搜索") });
    expect(JSON.stringify(result)).not.toContain(STEP_KEY);
    expect(f.fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([STEPSEARCH_ENDPOINT]);
    expect(vi.mocked(requestPublicHttps).mock.calls.map(([url]) => url)).toEqual([EXA_MCP_URL]);
    expect(JSON.stringify(vi.mocked(requestPublicHttps).mock.calls)).not.toContain(STEP_KEY);
  });

  it("a provider switch also drops citations from an outstanding direct /api/search request", async () => {
    const f = await fixture(); await f.connect();
    const entered = deferred<void>(); const late = deferred<Response>();
    f.answer(() => { entered.resolve(); return late.promise; });
    const pending = f.post("/api/search", { query: "TEST" });
    await entered.promise;
    await f.post("/api/providers/select", { provider: "stepfun" });
    late.resolve(searchSse());
    const response = await pending;
    const result = await response.json();
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toHaveProperty("results");
    await f.gpt.disconnect();
  });
});

describe("connection choice survives a backend restart", () => {
  const memoryPreferences = (initial: ProviderPreferences = {}): PreferenceStore & { value: ProviderPreferences } => {
    const store = { value: { ...initial },
      read: () => store.value,
      update: (change: Partial<Record<keyof ProviderPreferences, string | undefined>>) => {
        store.value = Object.fromEntries(Object.entries({ ...store.value, ...change }).filter(([, v]) => v !== undefined)) as ProviderPreferences;
      } };
    return store;
  };
  const boot = async (preferences: PreferenceStore, respond: () => Response | Promise<Response> = () => piSse({ ok: true })) => {
    const piStorage = new InMemoryCredentialStore();
    await piStorage.modify("openai", async () => ({ type: "oauth", access: ACCESS, refresh: REFRESH, expires: Date.UTC(2100, 0, 1) }));
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === GPT_MODELS) return Response.json({ models: [{ slug: MODEL, visibility: "list" }, { slug: "gpt-test-http-other", visibility: "list" }] });
      if (url === GPT_RESPONSES) return respond();
      throw new Error(`TEST forbids endpoint: ${url}`);
    });
    const gpt = new GptProvider({ ownStorage: new InMemoryCredentialStore(), piStorage, fetchImpl });
    const app = createApp({ config: testConfig({ searchEnabled: false }), credentials: new CredentialStore(), gpt, fetchImpl, preferences });
    const post = (path: string, body: unknown = {}) => app.request(path, { method: "POST", headers: authed, body: JSON.stringify(body) });
    const status = async () => (await app.request("/api/providers/status", { headers: authed })).json() as Promise<Record<string, unknown> & { providers: Array<{ name: string; connected: boolean; defaultModel?: string }> }>;
    return { app, gpt, post, status, fetchImpl };
  };

  it("remembers the selected provider, GPT source and model, and forgets them on disconnect", async () => {
    const preferences = memoryPreferences();
    const f = await boot(preferences);
    await f.post("/api/gpt/connect", { source: "pi" });
    await f.post("/api/providers/select", { provider: "gpt" });
    await f.post("/api/providers/model", { provider: "gpt", model: "gpt-test-http-other" });
    expect(preferences.value).toEqual({ activeProvider: "gpt", gptSource: "pi", gptModel: "gpt-test-http-other" });
    expect(JSON.stringify(preferences.value)).not.toMatch(/TEST-http-gpt-(access|refresh)/);
    await f.post("/api/gpt/disconnect");
    expect(preferences.value).toEqual({ activeProvider: "gpt" });
  });

  it("restores the remembered GPT login on start, and an early intent waits for it", async () => {
    const f = await boot(memoryPreferences({ activeProvider: "gpt", gptSource: "pi", gptModel: "gpt-test-http-other" }));
    expect(await f.status()).toMatchObject({ activeProvider: "gpt", restoring: "gpt" });
    const response = await f.post("/api/intent", { text: "帮我梳理这段项目思路", canvasContext: emptyContext() });
    expect(await response.json()).toMatchObject({ usedProvider: "gpt" });
    const status = await f.status();
    expect(status.restoring).toBeUndefined();
    expect(status.providers.find(p => p.name === "gpt")).toMatchObject({ connected: true, defaultModel: "gpt-test-http-other" });
  });

  it("falls back to the default model when the remembered one is gone", async () => {
    const preferences = memoryPreferences({ gptSource: "pi", gptModel: "gpt-test-retired" });
    const f = await boot(preferences);
    await vi.waitFor(async () => expect((await f.status()).restoring).toBeUndefined());
    expect((await f.status()).providers.find(p => p.name === "gpt")).toMatchObject({ connected: true });
    expect(preferences.value.gptModel).not.toBe("gpt-test-retired");
  });

  it("each backend instance reports its own id", async () => {
    const a = await boot(memoryPreferences()), b = await boot(memoryPreferences());
    const [first, again, other] = [await a.status(), await a.status(), await b.status()];
    expect(first.instance).toBe(again.instance);
    expect(first.instance).not.toBe(other.instance);
  });
});
