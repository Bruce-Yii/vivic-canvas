import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { createSearchClient, searchFallbackNote, SEARCH_PROVIDER, type SearchEvidence } from "../src/search/client.js";
import { callStepSearch, STEPSEARCH_PROVIDER } from "../src/search/stepsearch.js";
import { requestPublicHttps } from "../src/search/transport.js";
import { EXA_MCP_URL } from "../src/search/upstream/exa.js";
import { parseMacProxy, resolveSearchProxy } from "../src/openaiProxy.js";

// Synthetic fixtures only: no live provider, account or socket outside loopback.
vi.mock("../src/search/transport.js", async original => ({
  ...await original<typeof import("../src/search/transport.js")>(), requestPublicHttps: vi.fn(),
}));
vi.mock("../src/search/stepsearch.js", async original => ({
  ...await original<typeof import("../src/search/stepsearch.js")>(), callStepSearch: vi.fn(),
}));
const direct = vi.mocked(requestPublicHttps);
const stepsearch = vi.mocked(callStepSearch);

const TEST_KEY = "synthetic-fallback-test-key";
const evidence = (provider: SearchEvidence["provider"], url = "https://example.com/a"): SearchEvidence[] =>
  [{ title: "TEST", url, snippet: "TEST snippet", fetchedAt: new Date().toISOString(), provider, readFullPage: false }];
const exaReply = (url = "https://example.org/exa") => ({ status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({
  jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ title: "Exa", url, text: "Keyless." }] }) }] },
})) });

function harness(options: { gptConnected?: boolean; gptPreferred?: boolean; stepfun?: boolean; proxy?: string; timeoutMs?: number; attemptTimeoutMs?: number } = {}) {
  const credentials = new CredentialStore();
  if (options.stepfun) credentials.set({ apiKey: TEST_KEY, models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "TEST" });
  const gptSearch = vi.fn(async (_query: string, _signal: AbortSignal) => evidence("pi-web-access/gpt-oauth"));
  let current = true;
  const client = createSearchClient({ credentials,
    config: { ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(options.attemptTimeoutMs ? { attemptTimeoutMs: options.attemptTimeoutMs } : {}) },
    gpt: { connected: () => options.gptConnected ?? false, preferred: () => options.gptPreferred ?? false, search: gptSearch },
    searchProxy: () => options.proxy,
    captureSession: () => () => current });
  return { client, gptSearch, credentials, changeSession: () => { current = false; } };
}

beforeEach(() => {
  direct.mockReset(); direct.mockResolvedValue(exaReply());
  stepsearch.mockReset(); stepsearch.mockResolvedValue(evidence(STEPSEARCH_PROVIDER));
});

describe("search fallback chain", () => {
  it("uses only the selected, connected GPT when it answers", async () => {
    const h = harness({ gptConnected: true, gptPreferred: true, stepfun: true });
    expect(await h.client.webSearch("TEST")).toMatchObject([{ provider: "pi-web-access/gpt-oauth" }]);
    expect(stepsearch).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });

  it("never calls a selected but disconnected GPT; keyless search still works without any account", async () => {
    const h = harness({ gptConnected: false, gptPreferred: true });
    expect(await h.client.webSearch("TEST")).toMatchObject([{ provider: SEARCH_PROVIDER, url: "https://example.org/exa" }]);
    expect(h.gptSearch).not.toHaveBeenCalled();
    expect(direct.mock.calls.map(([url]) => url)).toEqual([EXA_MCP_URL]);
    expect(JSON.stringify(direct.mock.calls)).not.toContain(TEST_KEY);
  });

  it("a failed GPT search continues with StepSearch, then the keyless endpoint", async () => {
    const h = harness({ gptConnected: true, gptPreferred: true, stepfun: true });
    h.gptSearch.mockRejectedValue(new Error("PRIVATE upstream detail"));
    expect(await h.client.webSearch("TEST")).toMatchObject([{ provider: STEPSEARCH_PROVIDER }]);
    stepsearch.mockRejectedValue(new Error("PRIVATE stepsearch detail"));
    expect(await h.client.webSearch("TEST")).toMatchObject([{ provider: SEARCH_PROVIDER }]);
    expect(h.gptSearch).toHaveBeenCalledTimes(2);
  });

  it("StepFun selected: StepSearch first, then a connected GPT", async () => {
    const h = harness({ gptConnected: true, gptPreferred: false, stepfun: true });
    expect(await h.client.webSearch("TEST")).toMatchObject([{ provider: STEPSEARCH_PROVIDER }]);
    expect(h.gptSearch).not.toHaveBeenCalled();
    stepsearch.mockRejectedValue(new Error("quota"));
    expect(await h.client.webSearch("TEST")).toMatchObject([{ provider: "pi-web-access/gpt-oauth" }]);
    expect(direct).not.toHaveBeenCalled();
  });

  it("an empty answer tries the next route; an all-empty chain is a genuine empty list", async () => {
    const h = harness({ gptConnected: true, gptPreferred: true });
    h.gptSearch.mockResolvedValue([]);
    expect(await h.client.webSearch("上海今天天气")).toMatchObject([{ provider: SEARCH_PROVIDER }]);
    direct.mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] } })) });
    expect(await h.client.webSearch("TEST")).toEqual([]);
  });

  it("all routes failing names every route, keeps the first error code and leaks nothing", async () => {
    const h = harness({ gptConnected: true, gptPreferred: true, stepfun: true });
    h.gptSearch.mockRejectedValue(new Error(`PRIVATE ${TEST_KEY}`));
    stepsearch.mockRejectedValue(new Error(`PRIVATE ${TEST_KEY}`));
    direct.mockRejectedValue(new Error("PRIVATE socket"));
    const error = await h.client.webSearch("TEST").catch(e => e);
    expect(error).toMatchObject({ code: "search-unavailable", message: expect.stringContaining("GPT 搜索、StepSearch、公共搜索") });
    expect(String(error.message)).not.toMatch(/PRIVATE|synthetic/);
  });

  it("a stalled route gets its own deadline, yet the caller's deadline ends the whole chain", async () => {
    const stalled = harness({ gptConnected: true, gptPreferred: true, attemptTimeoutMs: 20 });
    stalled.gptSearch.mockImplementation(() => new Promise(() => {}));
    expect(await stalled.client.webSearch("TEST")).toMatchObject([{ provider: SEARCH_PROVIDER }]);
    direct.mockClear();
    const h = harness({ gptConnected: true, gptPreferred: true, timeoutMs: 20 });
    h.gptSearch.mockImplementation(() => new Promise(() => {}));
    await expect(h.client.webSearch("TEST")).rejects.toMatchObject({ code: "search-timeout" });
    expect(direct).not.toHaveBeenCalled();
  });

  it("caller cancellation and a provider switch stop the chain instead of falling back", async () => {
    const h = harness({ gptConnected: true, gptPreferred: true, stepfun: true });
    const controller = new AbortController();
    h.gptSearch.mockImplementation(async () => { controller.abort(); throw new Error("aborted"); });
    await expect(h.client.webSearch("TEST", controller.signal)).rejects.toMatchObject({ code: "search-cancelled" });
    h.gptSearch.mockImplementation(async () => { h.changeSession(); throw new Error("switched"); });
    await expect(h.client.webSearch("TEST")).rejects.toMatchObject({ code: "search-cancelled" });
    expect(stepsearch).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });

  it("names the route that actually answered when it is not the expected one", () => {
    expect(searchFallbackNote("gpt", evidence(SEARCH_PROVIDER))).toBe("GPT 搜索不可用，已改用公共搜索");
    expect(searchFallbackNote("stepsearch", evidence("pi-web-access/gpt-oauth"))).toBe("StepSearch不可用，已改用GPT 搜索");
    expect(searchFallbackNote("gpt", evidence("pi-web-access/gpt-oauth"))).toBeUndefined();
    expect(searchFallbackNote("exa", evidence(SEARCH_PROVIDER))).toBeUndefined();
  });
});

describe("keyless search egress", () => {
  let proxy: Server | undefined;
  afterEach(async () => {
    await new Promise<void>(resolve => (proxy ? proxy.close(() => resolve()) : resolve()));
    proxy = undefined;
  });

  it("tries the user's proxy first and falls back to the pinned direct route when it fails", async () => {
    const connects: string[] = [];
    proxy = createServer();
    proxy.on("connect", (request, socket) => { connects.push(request.url ?? ""); socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
    await new Promise<void>(resolve => proxy!.listen(0, "127.0.0.1", resolve));
    const h = harness({ proxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/` });
    expect(await h.client.webSearch("TEST")).toMatchObject([{ provider: SEARCH_PROVIDER }]);
    expect(connects).toEqual(["mcp.exa.ai:443"]);
    expect(direct.mock.calls.map(([url]) => url)).toEqual([EXA_MCP_URL]);
  });

  it("page fetches never use the search proxy", async () => {
    const connects: string[] = [];
    proxy = createServer();
    proxy.on("connect", (request, socket) => { connects.push(request.url ?? ""); socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
    await new Promise<void>(resolve => proxy!.listen(0, "127.0.0.1", resolve));
    const h = harness({ proxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/` });
    direct.mockResolvedValue({ status: 200, contentType: "text/plain", body: Buffer.from("Public text") });
    expect(await h.client.fetchContent("https://example.com/")).toMatchObject({ text: "Public text" });
    expect(connects).toEqual([]);
  });

  it("resolves the search proxy setting: auto follows env > OS, direct opts out, a URL wins", () => {
    const system = () => "http://127.0.0.1:7890/";
    expect(resolveSearchProxy("auto", {}, system)).toEqual({ url: "http://127.0.0.1:7890/", source: "system" });
    expect(resolveSearchProxy("auto", { HTTPS_PROXY: "http://10.0.0.1:8080" }, system)).toEqual({ url: "http://10.0.0.1:8080/", source: "env" });
    expect(resolveSearchProxy("direct", { HTTPS_PROXY: "http://10.0.0.1:8080" }, system)).toBeUndefined();
    expect(resolveSearchProxy("127.0.0.1:9000", {}, system)).toEqual({ url: "http://127.0.0.1:9000/", source: "VIVIC_SEARCH_PROXY" });
    expect(resolveSearchProxy("auto", {}, () => undefined)).toBeUndefined();
  });

  it("reads the macOS system proxy, HTTPS before HTTP, only when enabled", () => {
    const scutil = (lines: string[]) => `<dictionary> {\n${lines.map(line => `  ${line}`).join("\n")}\n}`;
    expect(parseMacProxy(scutil(["HTTPEnable : 1", "HTTPPort : 1081", "HTTPProxy : 127.0.0.1", "HTTPSEnable : 1", "HTTPSPort : 7890", "HTTPSProxy : 127.0.0.1"])))
      .toBe("http://127.0.0.1:7890/");
    expect(parseMacProxy(scutil(["HTTPEnable : 1", "HTTPPort : 1081", "HTTPProxy : proxy.corp.test", "HTTPSEnable : 0"]))).toBe("http://proxy.corp.test:1081/");
    expect(parseMacProxy(scutil(["HTTPEnable : 0", "HTTPSEnable : 0", "ExceptionsList : <array> {"]))).toBeUndefined();
  });
});
