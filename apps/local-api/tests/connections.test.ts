import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../src/connections/manager.js";
import { createConnectionRoutes } from "../src/connections/routes.js";
import { endpointFor, readToolAllowed } from "../src/connections/types.js";
import { cliArguments, isolatedCliEnvironment, type CliRunner } from "../src/connections/cli.js";
import { validateToolArguments } from "../src/connections/schema.js";
import { reviewedDingtalkSchema, DINGTALK_READ_TOOLS } from "../src/connections/dingtalkCatalog.js";
import { createOnlineHandler } from "../src/online/sessions.js";
import { createOnlineSessionApp } from "../src/online/appFactory.js";
import { authed, chatOk, modelsOk, TEST_TOKEN } from "./helpers.js";

const TOKEN = "test-only-provider-token-111";
const SIGNAL = () => new AbortController().signal;
const schema = { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false };
function provider(options: { sse?: boolean; tools?: unknown[]; content?: unknown; status?: number; delayed?: boolean } = {}) {
  const calls: Array<{ method: string; params?: { name?: string }; headers: Headers; url: string }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ ...body, headers: new Headers(init?.headers), url: String(input) });
    if (options.status) return new Response("upstream PRIVATE detailed error", { status: options.status });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (options.delayed && body.method === "tools/call") return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("upstream secret error")), { once: true }));
    const result = body.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "TEST", version: "1" } }
      : body.method === "tools/list" ? { tools: options.tools ?? [{ name: "search-doc", inputSchema: schema }, { name: "create-doc", inputSchema: schema }, { name: "auto-bind-coupons", inputSchema: schema }] }
        : options.content ?? { content: [{ type: "text", text: "真实响应占位：测试 fixture https://example.com/source" }] };
    const packet = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    return new Response(options.sse ? `event: message\r\ndata: ${packet}\r\n\r\n` : packet, { headers: { "Content-Type": options.sse ? "text/event-stream" : "application/json", "Mcp-Session-Id": "test-session" } });
  });
  return { fetchImpl, calls };
}
async function ready(options: Parameters<typeof provider>[0] = {}) {
  const upstream = provider(options); const manager = new ConnectionManager({ fetchImpl: upstream.fetchImpl });
  manager.configure({ provider: "feishu", token: TOKEN }); await manager.test("feishu", SIGNAL());
  return { manager, ...upstream };
}

describe("session-owned external connections", () => {
  it("discovers and executes only approved read tools using actual MCP wire methods", async () => {
    const { manager, calls } = await ready();
    expect(manager.status()[0]).toMatchObject({ connected: true, tools: [{ name: "search-doc", title: "搜索文档" }] });
    const result = await manager.query("feishu", "search-doc", { query: "旅行计划" }, SIGNAL());
    expect(result).toMatchObject({ provider: "feishu", source: "飞书", title: "搜索文档", truncated: false, links: [{ url: "https://example.com/source" }] });
    expect(calls.map(item => item.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(calls[0]!.headers.get("X-Lark-MCP-UAT")).toBe(TOKEN);
    expect(calls[0]!.headers.get("X-Lark-MCP-Allowed-Tools")).not.toContain("create-doc");
    expect(calls.at(-1)!.headers.get("Mcp-Session-Id")).toBe("test-session");
    expect(JSON.stringify(manager.status())).not.toContain(TOKEN);
    manager.dispose();
  });
  it("supports Streamable HTTP SSE replies", async () => {
    const { manager } = await ready({ sse: true });
    expect((await manager.query("feishu", "search-doc", { query: "周报" }, SIGNAL())).text).toContain("fixture"); manager.dispose();
  });
  it("refuses write tools and invalid arguments before any upstream query", async () => {
    const { manager, calls } = await ready(); const before = calls.length;
    await expect(manager.query("feishu", "create-doc", { query: "x" }, SIGNAL())).rejects.toMatchObject({ code: "tool-not-allowed" });
    await expect(manager.query("feishu", "search-doc", { query: 42 }, SIGNAL())).rejects.toMatchObject({ code: "invalid-tool-arguments" });
    await expect(manager.query("feishu", "search-doc", { query: "x", command: "delete" }, SIGNAL())).rejects.toMatchObject({ code: "invalid-tool-arguments" });
    expect(calls).toHaveLength(before); manager.dispose();
  });
  it("turns a natural question into one advertised read-only call, with sourced facts from the tool", async () => {
    const { manager, calls } = await ready();
    const planner = vi.fn(async () => ({ tool: "search-doc", args: { query: "杭州旅行计划" } }));
    const result = await manager.ask("feishu", "帮我找杭州旅行计划", planner, SIGNAL());
    expect(result.text).toContain("fixture"); expect(result.query).toEqual({ tool: "search-doc", args: { query: "杭州旅行计划" } });
    expect(calls.filter(call => call.method === "tools/call")).toHaveLength(1);
    expect(JSON.stringify(planner.mock.calls)).not.toContain(TOKEN); manager.dispose();
  });
  it.each([{ tool: "create-doc", args: { query: "x" } }, { tool: "not-a-tool", args: {} }, { tool: "search-doc", args: { query: "x", shell: "bad" } }])("refuses unsafe or invalid model plans before upstream execution %o", async plan => {
    const { manager, calls } = await ready();
    await expect(manager.ask("feishu", "TEST", async () => plan, SIGNAL())).rejects.toBeDefined();
    expect(calls.filter(call => call.method === "tools/call")).toHaveLength(0); manager.dispose();
  });
  it("surfaces missing query details without a tool call", async () => {
    const { manager, calls } = await ready();
    await expect(manager.ask("feishu", "读一下", async () => ({ question: "请提供文档链接。" }), SIGNAL())).rejects.toMatchObject({ code: "query-clarification", message: "请提供文档链接。" });
    expect(calls.filter(call => call.method === "tools/call")).toHaveLength(0); manager.dispose();
  });
  it("does not execute a late model plan after disconnect", async () => {
    const { manager, calls } = await ready();
    let resolvePlan: (value: unknown) => void = () => {};
    const work = manager.ask("feishu", "TEST", () => new Promise(resolve => { resolvePlan = resolve; }), SIGNAL());
    manager.disconnect("feishu"); resolvePlan({ tool: "search-doc", args: { query: "x" } });
    await expect(work).rejects.toBeDefined(); expect(calls.filter(call => call.method === "tools/call")).toHaveLength(0); manager.dispose();
  });
  it("does not save a tool error body as a successful fact", async () => {
    const { manager } = await ready({ content: { content: [{ type: "text", text: JSON.stringify({ error: "Private upstream refusal" }) }] } });
    await expect(manager.query("feishu", "search-doc", { query: "x" }, SIGNAL())).rejects.toMatchObject({ code: "tool-query-failed" }); manager.dispose();
  });
  it("binds natural lookup to the real app-selected StepFun session", async () => {
    const mcp = provider();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("api.stepfun.com")) {
        if (String(input).endsWith("/models")) return modelsOk(["step-3.5-flash"]);
        const body = JSON.parse(String(init?.body));
        return chatOk(body.messages[0].content.includes("只读资料查询规划器") ? { tool: "search-doc", args: { query: "杭州" } } : { ok: true });
      }
      return mcp.fetchImpl(input, init);
    });
    const app = createOnlineSessionApp({ token: TEST_TOKEN, origin: "https://vivic.example" }, { fetchImpl });
    const send = async (route: string, body: unknown) => app.fetch(new Request(`https://vivic.example${route}`, { method: "POST", headers: { ...authed, origin: "https://vivic.example" }, body: JSON.stringify(body) }));
    try {
      expect((await send("/api/connections/configure", { provider: "feishu", token: TOKEN })).status).toBe(200);
      expect((await send("/api/connections/test", { provider: "feishu" })).status).toBe(200);
      expect((await send("/api/connections/ask", { provider: "feishu", question: "找杭州计划" })).status).toBe(409);
      expect((await send("/api/credentials/stepfun/validate", { apiKey: "TEST-only-stepfun-credential" })).status).toBe(200);
      const response = await send("/api/connections/ask", { provider: "feishu", question: "找杭州计划" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, result: { source: "飞书", query: { tool: "search-doc", args: { query: "杭州" } } } });
    } finally { app.dispose(); }
  });
  it("does not trust a destructive tool's readOnly hint", () => {
    expect(readToolAllowed("mcdonalds", "auto-bind-coupons", { readOnlyHint: true })).toBe(false);
    expect(readToolAllowed("dingtalk", "query_and_delete", { readOnlyHint: true })).toBe(false);
    expect(readToolAllowed("dingtalk", "search-doc", { readOnlyHint: true, destructiveHint: true })).toBe(false);
    expect(readToolAllowed("dingtalk", "search-doc", { readOnlyHint: true })).toBe(false);
    expect(readToolAllowed("dingtalk", "get_document_content", { readOnlyHint: true })).toBe(true);
  });
  it.each(["getAndPayOrder", "queryThenRedeemCoupon", "get_upload_info", "search_custom_unsafe", "query_document_and_send", "doc/get_document_content"])("rejects unreviewed DingTalk RPC %s even when mislabeled read-only", name => {
    expect(readToolAllowed("dingtalk", name, { readOnlyHint: true, destructiveHint: false })).toBe(false);
  });
  it("audits DingTalk selectors independently of the remote input contract", () => {
    expect(DINGTALK_READ_TOOLS).toEqual(["search_documents", "list_nodes", "get_document_info", "get_document_content"]);
    const good = { type: "object", properties: { nodeId: { type: "string" }, password: { type: "string" } }, required: ["nodeId"] };
    const audited = reviewedDingtalkSchema("get_document_content", good)!;
    expect(audited).toBeDefined(); expect(audited.additionalProperties).toBe(false);
    expect(() => validateToolArguments(audited, { nodeId: "known-doc" })).not.toThrow();
    expect(() => validateToolArguments(audited, { nodeId: "known-doc", pay: true })).toThrow();
    expect(reviewedDingtalkSchema("get_document_content", { ...good, properties: { ...good.properties, pay: { type: "boolean" } } })).toBeUndefined();
    expect(reviewedDingtalkSchema("get_document_content", { ...good, properties: { nodeId: { type: "object" } } })).toBeUndefined();
    expect(reviewedDingtalkSchema("get_document_content", { ...good, required: ["nodeId", "password"] })).toBeUndefined();
  });
  it("discovery omits mislabeled DingTalk calls and schema changes", async () => {
    const { fetchImpl } = provider({ tools: [
      { name: "getAndPayOrder", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } },
      { name: "get_document_info", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { nodeId: { type: "string" }, mode: { type: "string", enum: ["pay"] } }, required: ["nodeId"] } },
      { name: "get_document_content", inputSchema: { type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"] } },
    ] });
    const manager = new ConnectionManager({ fetchImpl }); manager.configure({ provider: "dingtalk", endpoint: "https://mcp-gw.dingtalk.com/server/TEST-fixture?key=TEST-only" });
    const statuses = await manager.test("dingtalk", SIGNAL());
    expect(statuses.find(status => status.provider === "dingtalk")?.tools.map(tool => tool.name)).toEqual(["get_document_content"]);
    await expect(manager.query("dingtalk", "getAndPayOrder", {}, SIGNAL())).rejects.toMatchObject({ code: "tool-not-allowed" }); manager.dispose();
  });
  it("bounds remote content and removes credentials from readable results", async () => {
    const { manager } = await ready({ content: { content: [{ type: "text", text: JSON.stringify({ token: TOKEN, text: TOKEN + "x".repeat(30_000), url: "https://example.com/a?token=private" }) }] } });
    const result = await manager.query("feishu", "search-doc", { query: "x" }, SIGNAL());
    expect(result.text.length).toBe(24000); expect(result.truncated).toBe(true); expect(result.text).not.toContain(TOKEN); expect(result.links).toHaveLength(0); manager.dispose();
  });
  it("aborts in-flight queries and forgets credentials on disconnect", async () => {
    const { manager } = await ready({ delayed: true });
    const work = manager.query("feishu", "search-doc", { query: "x" }, SIGNAL());
    manager.disconnect("feishu");
    await expect(work).rejects.toMatchObject({ code: "connection-unavailable" });
    expect(manager.status()[0]).toMatchObject({ connected: false, configured: false, tools: [] });
    await expect(manager.query("feishu", "search-doc", { query: "x" }, SIGNAL())).rejects.toMatchObject({ code: "connection-required" }); manager.dispose();
  });
  it("aborts on app disposal and blocks new configuration", async () => {
    const { manager } = await ready({ delayed: true });
    const work = manager.query("feishu", "search-doc", { query: "x" }, SIGNAL()); manager.dispose();
    await expect(work).rejects.toBeDefined(); expect(() => manager.configure({ provider: "feishu", token: TOKEN })).toThrow("会话已结束");
  });
  it("uses fixed official hosts and rejects credentials in URL authority, ports, fragments", () => {
    for (const endpoint of ["http://mcp-gw.dingtalk.com/a", "https://127.0.0.1/a", "https://mcp-gw.dingtalk.com.evil.test/a", "https://user:pass@mcp-gw.dingtalk.com/a", "https://mcp-gw.dingtalk.com:8443/a", "https://mcp-gw.dingtalk.com/a#fragment"]) {
      expect(() => endpointFor({ provider: "dingtalk", transport: "mcp", endpoint })).toThrow();
    }
    expect(endpointFor({ provider: "mcdonalds", transport: "mcp", endpoint: "https://evil.test", token: TOKEN }).href).toBe("https://mcp.mcd.cn/");
  });
  it("returns sanitized upstream failures without exception or token details", async () => {
    const { fetchImpl } = provider({ status: 401 }); const manager = new ConnectionManager({ fetchImpl });
    manager.configure({ provider: "mcdonalds", token: TOKEN });
    await expect(manager.test("mcdonalds", SIGNAL())).rejects.toMatchObject({ code: "authorization-required" });
    expect(JSON.stringify(manager.status())).not.toMatch(/PRIVATE|test-only/); manager.dispose();
  });
  it("does not inherit host CLI account; explicit supplied config is passed to isolated runner", async () => {
    const cli = vi.fn<CliRunner>(async () => ({ ok: true, data: { text: "fixture" } }));
    const manager = new ConnectionManager({ cli });
    expect(() => manager.configure({ provider: "feishu", transport: "cli", token: TOKEN })).toThrow("App ID");
    manager.configure({ provider: "feishu", transport: "cli", token: TOKEN, appId: "cli_testapp" });
    await manager.test("feishu", SIGNAL()); await manager.query("feishu", "search-doc", { query: "query" }, SIGNAL());
    expect(cli.mock.calls[0]?.[0]).toMatchObject({ token: TOKEN, appId: "cli_testapp" }); manager.dispose();
  });
  it("routes credentials only by JSON body and limits request size", async () => {
    const app = createConnectionRoutes(new ConnectionManager());
    expect((await app.request("/configure?token=not-supported", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status).toBe(400);
    expect((await app.request("/configure", { method: "POST", body: JSON.stringify({ token: "x".repeat(40_000) }) })).status).toBe(413);
  });
  it("keeps two real online cookie sessions isolated and rejects cross-origin connection changes", async () => {
    const { fetchImpl } = provider();
    const origin = "https://vivic.example";
    const handler = createOnlineHandler({ origin, createSessionApp: session => createOnlineSessionApp(session, { fetchImpl }) });
    const request = (route: string, method: string, cookie?: string, body?: unknown, customOrigin = origin) => new Request(origin + route, { method,
      headers: { Origin: customOrigin, ...(cookie ? { Cookie: cookie } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
      const a = (await handler.fetch(request("/api/online/session", "POST", undefined, {}))).headers.get("set-cookie")!.split(";")[0]!;
      const b = (await handler.fetch(request("/api/online/session", "POST", undefined, {}))).headers.get("set-cookie")!.split(";")[0]!;
      expect((await handler.fetch(request("/api/connections/configure", "POST", a, { provider: "feishu", token: TOKEN }))).status).toBe(200);
      expect((await handler.fetch(request("/api/connections/test", "POST", a, { provider: "feishu" }))).status).toBe(200);
      const stateA = await (await handler.fetch(request("/api/connections/status", "GET", a))).json();
      const stateB = await (await handler.fetch(request("/api/connections/status", "GET", b))).json();
      expect(stateA.connections[0].connected).toBe(true); expect(stateB.connections[0].configured).toBe(false);
      expect((await handler.fetch(request("/api/connections/query", "POST", b, { provider: "feishu", tool: "search-doc", args: { query: "x" } }))).status).toBe(409);
      expect((await handler.fetch(request("/api/connections/configure", "POST", a, { provider: "feishu", token: TOKEN }, "https://evil.example"))).status).toBe(403);
      expect(JSON.stringify(stateA)).not.toContain(TOKEN);
    } finally { await handler.dispose(); }
  });
});

describe("bounded CLI and input contracts", () => {
  it("does not pass host accounts, auth proxy, arbitrary environment or headers to CLI", () => {
    const env = isolatedCliEnvironment({ provider: "wecom", transport: "cli", token: TOKEN }, "TEST-isolated-root", { PATH: "TEST-path", HOME: "PRIVATE-host-home", WECOM_CLI_ACCESS_TOKEN: "PRIVATE-host-token", LARKSUITE_CLI_AUTH_PROXY: "PRIVATE-host-proxy", WECOM_CLI_ADDITIONAL_HEADERS: "PRIVATE-header" });
    expect(env.HOME).toBe("TEST-isolated-root"); expect(env.WECOM_CLI_ACCESS_TOKEN).toBe(TOKEN); expect(JSON.stringify(env)).not.toContain("PRIVATE");
  });
  it("places shell metacharacters in argv, never a command string", () => {
    expect(cliArguments("feishu", "search-doc", { query: "$(whoami); rm -rf /" })).toContain("$(whoami); rm -rf /");
    expect(() => cliArguments("wecom", "delete-doc", {})).toThrow("未开放");
    expect(() => cliArguments("wecom", "fetch-doc", { doc: "file:///etc/passwd" })).toThrow();
    expect(cliArguments("wecom", "fetch-doc", { doc: "https://doc.weixin.qq.com/doc/test_document" }).slice(0, 3)).toEqual(["doc", "contents", "get"]);
  });
  it("rejects complex remote refs and prototype pollution argument names", () => {
    expect(() => validateToolArguments({ $ref: "https://evil.test/schema" }, {})).toThrow();
    expect(() => validateToolArguments({ type: "object" }, JSON.parse('{"__proto__": {"x":1}}'))).toThrow();
    expect(() => validateToolArguments(schema, { query: "valid" })).not.toThrow();
  });
});
