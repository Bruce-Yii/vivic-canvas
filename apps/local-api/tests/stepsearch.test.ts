import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSearchClient, STEPSEARCH_PROVIDER } from "../src/search/index.js";
import { STEPSEARCH_ENDPOINT } from "../src/search/stepsearch.js";
import { EXA_MCP_URL } from "../src/search/upstream/exa.js";
import { CredentialStore } from "../src/credentials.js";
import { requestPublicHttps } from "../src/search/transport.js";
import { createApp } from "../src/app.js";
import { authed, emptyContext, testConfig } from "./helpers.js";

vi.mock("../src/search/transport.js", async original => ({
  ...await original<typeof import("../src/search/transport.js")>(), requestPublicHttps: vi.fn(),
}));
const publicRequest = vi.mocked(requestPublicHttps);
// Synthetic test fixture only. No user credentials or authenticated live calls.
const TEST_KEY = "synthetic-stepsearch-test-key";
const credential = () => ({ apiKey: TEST_KEY, models: ["step-3.5-flash"],
  defaultModel: "step-3.5-flash", checkedAt: new Date().toISOString() });
const row = { title: "React Flow", url: "https://reactflow.dev/", snippet: "A canvas library." };
const sources = { results: [row] };
// Parameter schema supplied by mainline's authenticated tools/list probe.
// Mainline also verified both JSON text and structuredContent with results rows.
// These remain synthetic protocol fixtures; this file makes no live requests.
const schema = { type: "object", properties: {
  query: { type: "string" }, n: { type: "integer", minimum: 1, maximum: 20 },
  category: { type: "string", enum: ["programming", "research", "gov", "business"] },
  use_common_search: { type: "boolean" },
}, required: ["query"] };
type Rpc = { id?: number; method: string; params?: Record<string, unknown> };
const json = (value: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json", ...headers },
});
const rpc = (id: number | undefined, result: unknown) => ({ jsonrpc: "2.0", id, result });
function harness(override?: (message: Rpc, init: RequestInit) => Response | Promise<Response> | undefined) {
  const store = new CredentialStore(); store.set(credential());
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const message = JSON.parse(String(init?.body)) as Rpc;
    const replacement = override?.(message, init!);
    if (replacement !== undefined) return await replacement;
    if (message.method === "initialize") return json(rpc(message.id, {
      protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock-step", version: "1" },
    }), { "mcp-session-id": "session-fixture" });
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "tools/list") return json(rpc(message.id, { tools: [
      { name: "web_search", inputSchema: schema }, { name: "web_fetch", inputSchema: { type: "object" } },
      { name: "bash", inputSchema: { type: "object" } },
    ] }));
    return json(rpc(message.id, { content: [{ type: "text", text: JSON.stringify(sources) }] }));
  });
  const fetchImpl = fetcher as typeof fetch;
  return { store, fetcher, fetchImpl, client: createSearchClient({ credentials: store, fetchImpl }) };
}
beforeEach(() => publicRequest.mockReset());
// A failed paid route may only continue to the keyless endpoint, never with the Plan Key.
const expectKeylessFallbackOnly = () => {
  expect(publicRequest).toHaveBeenCalledTimes(1);
  expect(publicRequest.mock.calls[0][0]).toBe(EXA_MCP_URL);
  expect(JSON.stringify(publicRequest.mock.calls)).not.toContain(TEST_KEY);
};

describe("StepSearch MCP protocol and evidence", () => {
  it("negotiates the real protocol/schema, sends only query/n to the fixed endpoint, and preserves citations", async () => {
    const h = harness();
    expect(await h.client.webSearch(" React Flow ")).toEqual([{ ...row, provider: STEPSEARCH_PROVIDER,
      fetchedAt: expect.any(String), readFullPage: false }]);
    const messages = h.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(messages).toEqual([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vivic-search", version: "0.6.0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "web_search", arguments: { query: "React Flow", n: 5 } } },
    ]);
    for (const [url, init] of h.fetcher.mock.calls) {
      expect(url).toBe(STEPSEARCH_ENDPOINT);
      expect(init).toMatchObject({ redirect: "error", credentials: "omit", method: "POST" });
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TEST_KEY}`, Accept: "application/json, text/event-stream" });
      expect(String(init?.body)).not.toContain(TEST_KEY);
    }
    expect(h.fetcher.mock.calls[0][1]?.headers).not.toHaveProperty("Mcp-Session-Id");
    for (const [, init] of h.fetcher.mock.calls.slice(1)) expect(init?.headers).toMatchObject({
      "Mcp-Session-Id": "session-fixture", "MCP-Protocol-Version": "2024-11-05",
    });
    expect(publicRequest).not.toHaveBeenCalled();
  });

  it.each(["2025-03-26", "2025-06-18"])("accepts negotiated version %s and stateless MCP", async version => {
    const h = harness(message => message.method === "initialize" ? json(rpc(message.id, {
      protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" },
    })) : undefined);
    expect(await h.client.webSearch("test")).toHaveLength(1);
    expect(h.fetcher.mock.calls[1][1]?.headers).not.toHaveProperty("Mcp-Session-Id");
  });

  it("accepts an empty initialized stream, paginates tools/list within a fixed bound and limits n", async () => {
    const h = harness(message => {
      if (message.method === "notifications/initialized") return new Response(new Uint8Array(), { status: 202 });
      if (message.method === "tools/list") return json(rpc(message.id, message.params?.cursor
        ? { tools: [{ name: "web_search", inputSchema: schema }] }
        : { tools: [{ name: "web_fetch", inputSchema: {} }], nextCursor: "next" }));
    });
    const client = createSearchClient({ credentials: h.store, fetchImpl: h.fetchImpl, config: { maxResults: 2 } });
    await client.webSearch("test");
    expect(JSON.parse(String(h.fetcher.mock.calls.at(-1)?.[1]?.body)).params.arguments.n).toBe(2);
    expect(h.fetcher).toHaveBeenCalledTimes(5);
  });

  it("reads chunked UTF-8 multiline SSE with CRLF, ignores notifications, cancels an open stream on its response", async () => {
    const cancelled = vi.fn();
    const h = harness(message => {
      if (message.method !== "tools/call") return;
      const payload = `: heartbeat\r\nevent: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\r\n\r\ndata: ${JSON.stringify(rpc(message.id, { structuredContent: { results: [{ ...row, title: "画布" }] } })).replace(',"result"', ',\r\ndata: "result"')}\r\n\r\n`;
      const bytes = new TextEncoder().encode(payload);
      return new Response(new ReadableStream({ start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      }, cancel: cancelled }), { headers: { "content-type": "text/event-stream" } });
    });
    expect((await h.client.webSearch("test"))[0].title).toBe("画布");
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("validates and caps structured sources, deduplicates safe citations and never reads pages", async () => {
    const h = harness(message => message.method === "tools/call" ? json(rpc(message.id, { structuredContent: { results: [
      { ...row, title: "t".repeat(500), snippet: "s".repeat(1000) },
      { ...row, url: `${row.url}#duplicate` }, { ...row, url: "https://127.0.0.1" },
      { ...row, url: "http://example.org" }, { ...row, url: "https://example.org", title: "Second" },
    ] } })) : undefined);
    const results = await h.client.webSearch("test");
    expect(results).toHaveLength(2);
    expect(results[0].title).toHaveLength(300);
    expect(results[0].snippet).toHaveLength(700);
    expect(results.every(result => result.readFullPage === false)).toBe(true);
    expect(h.fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([
    { results: [{ url: row.url, snippet: "no title" }] },
    { results: [{ title: row.title, url: row.url }] },
    { results: [{ ...row, title: TEST_KEY }] },
    { results: [{ ...row, url: `https://example.org/?secret=${TEST_KEY}` }] },
    { results: [{ ...row, url: "https://10.0.0.1" }] },
    { results: [{ ...row, snippet: 5 }] },
    { notSources: [] },
  ])("rejects invalid, invented or credential-reflecting evidence", async payload => {
    const h = harness(message => message.method === "tools/call" ? json(rpc(message.id, { structuredContent: payload })) : undefined);
    await expect(h.client.webSearch("test")).rejects.toMatchObject({ code: "search-invalid-response" });
    expectKeylessFallbackOnly();
  });

  it("returns a genuine empty list without inventing citations", async () => {
    const h = harness(message => message.method === "tools/call" ? json(rpc(message.id, { structuredContent: { results: [] } })) : undefined);
    expect(await h.client.webSearch("test")).toEqual([]);
  });

  it("prefers the verified structuredContent snippet and never copies long page content into evidence", async () => {
    const h = harness(message => message.method === "tools/call" ? json(rpc(message.id, {
      content: [{ type: "text", text: JSON.stringify({ results: [{ ...row, snippet: "Other text block" }] }) }],
      structuredContent: { query: "test", category: "", results: [{ ...row, position: 1,
        time: "2026-10-15", snippet: "First line\nSecond line", content: "PAGE CONTENT ".repeat(1000) }] },
    })) : undefined);
    const results = await h.client.webSearch("test");
    expect(results[0].snippet).toBe("First line Second line");
    expect(JSON.stringify(results)).not.toMatch(/PAGE CONTENT|Other text block/);
  });

  it.each([
    { ...schema, required: ["query", "category"] },
    { ...schema, properties: { ...schema.properties, query: { type: "array" } } },
    { ...schema, properties: { ...schema.properties, query: { type: "string", pattern: "private" } } },
    { ...schema, oneOf: [] },
    { type: "object", properties: { search_query: { type: "string" } }, required: ["search_query"] },
  ])("fails closed on unsupported input schema before charged calls", async inputSchema => {
    const h = harness(message => message.method === "tools/list" ? json(rpc(message.id, { tools: [{ name: "web_search", inputSchema }] })) : undefined);
    await expect(h.client.webSearch("test")).rejects.toMatchObject({ code: "search-invalid-response" });
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });
});

describe("StepSearch isolation, limits and lifecycle", () => {
  it.each([401, 403, 429, 302, 404, 500])("only falls back to keyless search and never leaks upstream errors on HTTP %s", async status => {
    const h = harness(() => new Response(`PRIVATE ${TEST_KEY}`, { status, headers: { location: "https://evil.example/" } }));
    try { await h.client.webSearch("test"); expect.fail("expected failure"); }
    catch (error) {
      expect(error).toMatchObject({ code: status === 429 ? "search-rate-limited" : [401, 403].includes(status) ? "search-auth-required" : "search-unavailable" });
      expect(String(error)).not.toMatch(/PRIVATE|synthetic-stepsearch-test-key|evil/);
    }
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expectKeylessFallbackOnly();
  });

  it.each(["unsupported-version", "invalid-session", "missing-tools", "cursor-loop", "unaccepted-notification", "notification-body", "wrong-origin"])("rejects %s safely during protocol negotiation", async mode => {
    const h = harness(message => {
      if (message.method === "initialize" && ["unsupported-version", "invalid-session", "missing-tools", "wrong-origin"].includes(mode)) {
        const response = json(rpc(message.id, { protocolVersion: mode === "unsupported-version" ? "2099-01-01" : "2024-11-05",
          capabilities: mode === "missing-tools" ? {} : { tools: {} }, serverInfo: { name: "mock", version: "1" } }),
        mode === "invalid-session" ? { "mcp-session-id": "invalid session" } : undefined);
        if (mode === "wrong-origin") Object.defineProperty(response, "url", { value: "https://evil.example/mcp" });
        return response;
      }
      if (message.method === "notifications/initialized" && mode.startsWith("unaccepted")) return new Response(null, { status: 200 });
      if (message.method === "notifications/initialized" && mode === "notification-body") return new Response("PRIVATE", { status: 202 });
      if (message.method === "tools/list" && mode === "cursor-loop") return json(rpc(message.id, { tools: [], nextCursor: "loop" }));
    });
    await expect(h.client.webSearch("test")).rejects.toMatchObject({ code: mode === "wrong-origin" ? "search-unavailable" : "search-invalid-response" });
    expect(h.fetcher.mock.calls.some(([, init]) => JSON.parse(String(init?.body)).method === "tools/call")).toBe(false);
    expectKeylessFallbackOnly();
  });

  it.each([
    (id: number) => ({ jsonrpc: "2.0", id: id + 1, result: {} }),
    (id: number) => ({ jsonrpc: "1.0", id, result: {} }),
    (id: number) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: `PRIVATE ${TEST_KEY}` } }),
    (id: number) => rpc(id, { isError: true, content: [{ type: "text", text: `PRIVATE ${TEST_KEY}` }] }),
  ])("rejects invalid/error RPC envelopes without reflecting body", async body => {
    const h = harness(message => message.method === "tools/call" ? json(body(message.id!)) : undefined);
    await expect(h.client.webSearch("test")).rejects.toMatchObject({ code: "search-invalid-response" });
    expectKeylessFallbackOnly();
  });

  it.each(["declared", "streamed", "unsupported-type", "malformed-json", "truncated-sse", "bad-utf8"])("bounds and cancels %s bodies", async mode => {
    const cancel = vi.fn();
    const h = harness(message => {
      if (message.method !== "tools/call") return;
      let bytes = new TextEncoder().encode("x".repeat(4097));
      if (mode === "malformed-json") bytes = new TextEncoder().encode("{");
      if (mode === "truncated-sse") bytes = new TextEncoder().encode(`data: ${JSON.stringify(rpc(message.id, {}))}\n`);
      if (mode === "bad-utf8") bytes = new Uint8Array([255]);
      const headers: Record<string, string> = { "content-type": mode === "unsupported-type" ? "text/html" : mode === "truncated-sse" ? "text/event-stream" : "application/json" };
      if (mode === "declared") headers["content-length"] = "4097";
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes);
        if (["malformed-json", "truncated-sse"].includes(mode)) controller.close();
      }, cancel }), { headers });
    });
    // malformed/truncated bodies must end to distinguish corruption from a stall.
    const client = createSearchClient({ credentials: h.store, fetchImpl: h.fetchImpl, config: { maxResponseBytes: 4096, timeoutMs: 30 } });
    const expected = ["declared", "streamed"].includes(mode) ? "search-too-large"
      : "search-invalid-response";
    await expect(client.webSearch("test")).rejects.toMatchObject({ code: expected });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledTimes(["malformed-json", "truncated-sse"].includes(mode) ? 0 : 1);
  });

  it("uses one deadline across the handshake and cancels a stalled body", async () => {
    const cancel = vi.fn();
    const h = harness(message => message.method === "tools/call" ? new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/event-stream" } }) : undefined);
    const client = createSearchClient({ credentials: h.store, fetchImpl: h.fetchImpl, config: { timeoutMs: 15 } });
    await expect(client.webSearch("test")).rejects.toMatchObject({ code: "search-timeout" });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledTimes(1);
    const abort = new AbortController(); abort.abort(new Error("PRIVATE"));
    await expect(h.client.webSearch("test", abort.signal)).rejects.toMatchObject({ code: "search-cancelled" });
    expect(h.fetcher).toHaveBeenCalledTimes(4);
  });

  it("cancels a transport ignoring abort and discards its late response", async () => {
    let finish!: (response: Response) => void;
    const h = harness(() => new Promise<Response>(resolve => { finish = resolve; }));
    const abort = new AbortController();
    const pending = h.client.webSearch("test", abort.signal);
    abort.abort(new Error("PRIVATE"));
    await expect(pending).rejects.toMatchObject({ code: "search-cancelled" });
    const cancel = vi.fn();
    finish(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json" } }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["initialize", "notifications/initialized", "tools/list", "tools/call"])("discards results after disconnect/reconnect during %s, even with the same key", async method => {
    let h: ReturnType<typeof harness>;
    h = harness(message => {
      if (message.method !== method) return;
      h.store.clear(); h.store.set(credential());
    });
    await expect(h.client.webSearch("test")).rejects.toMatchObject({ code: "search-cancelled" });
    expect(publicRequest).not.toHaveBeenCalled();
    expect(h.fetcher.mock.calls.at(-1)?.[1]?.body).toContain(method);
  });

  it("shares admission limits across direct search and public fetch and rejects bad queries before requests", async () => {
    const h = harness();
    const client = createSearchClient({ credentials: h.store, fetchImpl: h.fetchImpl, config: { requestsPerMinute: 1 } });
    await expect(client.webSearch("\u0000")).rejects.toMatchObject({ code: "search-invalid-input" });
    expect(h.fetcher).not.toHaveBeenCalled();
    await client.webSearch("test");
    await expect(client.fetchContent("https://example.com")).rejects.toMatchObject({ code: "search-rate-limited" });
    expect(publicRequest).not.toHaveBeenCalled();
  });

  it("keeps keyless Exa when disconnected and drops its results if a connection is established in flight", async () => {
    const h = harness(); h.store.clear();
    publicRequest.mockImplementation(async () => {
      h.store.set(credential());
      return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(rpc(1, { content: [{ type: "text", text: JSON.stringify({ results: [{ title: row.title, url: row.url, text: row.snippet }] }) }] }))) };
    });
    await expect(h.client.webSearch("test")).rejects.toMatchObject({ code: "search-cancelled" });
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(publicRequest.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
  });

  it("wires /search and intent to the same in-memory Plan credential; /fetch retains the public pinned transport", async () => {
    const h = harness();
    const app = createApp({ config: testConfig({ searchEnabled: true }), credentials: h.store, fetchImpl: h.fetchImpl });
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: authed, body: JSON.stringify(body) });
    const response = await post("/api/search", { query: "React Flow" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, results: [{ provider: STEPSEARCH_PROVIDER }] });
    const intent = await post("/api/intent", { text: "搜索React Flow", canvasContext: emptyContext() });
    expect(await intent.json()).toMatchObject({ kind: "envelope", usedProvider: "search", envelope: {
      actions: expect.arrayContaining([expect.objectContaining({ type: "card.create", card: expect.objectContaining({
        sources: [expect.objectContaining({ provider: STEPSEARCH_PROVIDER, url: row.url })],
      }) })]),
    } });
    publicRequest.mockResolvedValue({ status: 200, contentType: "text/plain", body: Buffer.from("Public text") });
    expect((await post("/api/fetch", { url: "https://example.com" })).status).toBe(200);
    expect(publicRequest).toHaveBeenCalledTimes(1);
    expect(publicRequest.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
    expect(h.fetcher).toHaveBeenCalledTimes(8);
  });
});
