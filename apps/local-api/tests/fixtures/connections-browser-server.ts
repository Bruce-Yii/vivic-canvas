/** Isolated browser acceptance harness. Real online handler/apps, synthetic upstream only.
 * No provider credentials or host accounts are read. Production host policy is untouched. */
import { serve } from "@hono/node-server";
import { createOnlineHandler } from "../../src/online/sessions.js";
import { createOnlineSessionApp } from "../../src/online/appFactory.js";

const json = (body: unknown, status = 200, headers?: HeadersInit) => Response.json(body, { status, headers });
const calls: Array<{ method: string; name?: string }> = [];
const fetchFixture: typeof fetch = async (input, init) => {
  const url = String(input);
  const payload = JSON.parse(String(init?.body ?? "{}"));
  if (url.startsWith("https://api.stepfun.com/")) {
    if (url.endsWith("/models")) return json({ data: [{ id: "step-3.5-flash" }] });
    const messages = payload.messages as Array<{ role: string; content: string }>;
    const planning = messages[0]?.content.includes("只读资料查询规划器");
    const request = planning ? JSON.parse(messages.at(-1)!.content) : {};
    const result = !planning ? { ok: true } : String(request.question).includes("删除") ? { tool: "create-doc", args: {} }
      : request.source === "麦当劳" ? { tool: "campaign-calendar", args: {} } : { tool: "search-doc", args: { query: request.question } };
    calls.push({ method: planning ? "model.plan" : "model.probe" });
    return json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  }
  if (!url.startsWith("https://mcp.feishu.cn/") && !url.startsWith("https://mcp.mcd.cn")) throw new Error("Unexpected fixture endpoint");
  calls.push({ method: payload.method, name: payload.params?.name });
  if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
  const feishu = url.includes("feishu");
  const result = payload.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "Vivic acceptance fixture", version: "1" } }
    : payload.method === "tools/list" ? { tools: [feishu
      ? { name: "search-doc", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false } }
      : { name: "campaign-calendar", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      { name: "create-doc", inputSchema: { type: "object" } }, { name: "auto-bind-coupons", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: feishu ? "TEST FIXTURE · 杭州旅行计划\n周六上午西湖步行，下午参观博物馆。\n这是浏览器验收夹具，不是真实飞书文档。\nhttps://example.com/fixture-hangzhou"
        : "TEST FIXTURE · 十月活动日历\n本条仅验证麦当劳 MCP 接入流程，不代表真实优惠。\nhttps://example.com/fixture-mcd-calendar" }] };
  return json({ jsonrpc: "2.0", id: payload.id, result }, 200, { "Mcp-Session-Id": "fixture-browser-session" });
};
const handler = createOnlineHandler({ origin: "http://localhost:17894", createSessionApp: session => createOnlineSessionApp(session, { fetchImpl: fetchFixture }) });
const server = serve({ hostname: "127.0.0.1", port: 17895, fetch: request => new URL(request.url).pathname === "/__fixture/calls" ? json({ calls }) : handler.fetch(request) });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void handler.dispose().finally(() => server.close()); });
