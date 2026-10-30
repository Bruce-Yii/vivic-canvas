import { ConnectionError, endpointFor, FEISHU_READ_TOOLS, readToolAllowed, type ConnectionConfig, type ReadTool } from "./types.js";
import { reviewedDingtalkSchema } from "./dingtalkCatalog.js";

const MAX_RESPONSE = 256 * 1024;
export class McpConnection {
  private sessionId?: string;
  private protocol = "2025-03-26";
  private nextId = 0;
  private readonly config: ConnectionConfig;
  private readonly fetchImpl: typeof fetch;
  constructor(config: ConnectionConfig, fetchImpl: typeof fetch = fetch) { this.config = config; this.fetchImpl = fetchImpl; }
  private async request(method: string, params: unknown, signal: AbortSignal, notification = false): Promise<unknown> {
    const url = endpointFor(this.config);
    const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": this.protocol });
    if (this.config.provider === "feishu") {
      headers.set("X-Lark-MCP-UAT", this.config.token!);
      headers.set("X-Lark-MCP-Allowed-Tools", FEISHU_READ_TOOLS.join(","));
    } else if (this.config.token) headers.set("Authorization", `Bearer ${this.config.token}`);
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    const id = ++this.nextId;
    const response = await this.fetchImpl(url, { method: "POST", redirect: "error", headers,
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) }), signal });
    if (!response.ok) {
      void response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new ConnectionError("authorization-required", "授权已过期或权限不足，请重新连接。", 401);
      if (response.status === 429) throw new ConnectionError("provider-rate-limit", "此服务请求较多，请稍后再试。", 429);
      throw new ConnectionError("provider-unavailable", "服务暂时无法完成查询，请稍后重试。", 502);
    }
    const sessionId = response.headers.get("Mcp-Session-Id");
    if (sessionId && /^[\x21-\x7e]{1,256}$/.test(sessionId)) this.sessionId = sessionId;
    if (notification) { void response.body?.cancel(); return undefined; }
    if (!response.body || Number(response.headers.get("content-length")) > MAX_RESPONSE) { void response.body?.cancel(); throw new ConnectionError("response-too-large", "服务返回的内容过多，请缩小查询范围。", 413); }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "", size = 0;
    const sse = response.headers.get("content-type")?.includes("text/event-stream");
    const parse = (raw: string): unknown | undefined => {
      let item: { id?: unknown; result?: unknown; error?: unknown };
      try { item = JSON.parse(raw); } catch { return undefined; }
      if (!item || item.id !== id) return undefined;
      if (item.error) throw new ConnectionError("provider-query-failed", "服务拒绝了查询，请检查参数或授权范围。", 502);
      return item.result;
    };
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_RESPONSE) throw new ConnectionError("response-too-large", "服务返回的内容过多，请缩小查询范围。", 413);
        text += decoder.decode(part.value, { stream: true });
        if (sse) {
          text = text.replace(/\r\n/g, "\n");
          let split: number;
          while ((split = text.indexOf("\n\n")) >= 0) {
            const event = text.slice(0, split); text = text.slice(split + 2);
            const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            const result = data ? parse(data) : undefined;
            if (result !== undefined) return result;
          }
        }
      }
      const result = parse(sse ? text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n") : text + decoder.decode());
      if (result !== undefined) return result;
      throw new ConnectionError("invalid-provider-response", "服务返回了无法读取的内容。", 502);
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async discover(signal: AbortSignal): Promise<ReadTool[]> {
    const init = await this.request("initialize", { protocolVersion: this.protocol, capabilities: {}, clientInfo: { name: "Vivic", version: "0.1.0" } }, signal) as { protocolVersion?: string };
    if (typeof init?.protocolVersion === "string" && /^\d{4}-\d{2}-\d{2}$/.test(init.protocolVersion)) this.protocol = init.protocolVersion;
    await this.request("notifications/initialized", undefined, signal, true);
    const tools: ReadTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const result = await this.request("tools/list", cursor ? { cursor } : {}, signal) as { tools?: unknown[]; nextCursor?: unknown };
      if (!Array.isArray(result?.tools)) throw new ConnectionError("invalid-tool-list", "服务未返回可用查询工具。", 502);
      for (const raw of result.tools.slice(0, 150)) {
        if (!raw || typeof raw !== "object") continue;
        const tool = raw as Record<string, unknown>;
        if (typeof tool.name !== "string" || !/^[\w.\/-]{1,128}$/.test(tool.name) || !readToolAllowed(this.config.provider, tool.name, tool.annotations)) continue;
        if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema) || JSON.stringify(tool.inputSchema).length > 16000) continue;
        const inputSchema = this.config.provider === "dingtalk" ? reviewedDingtalkSchema(tool.name, tool.inputSchema as Record<string, unknown>) : tool.inputSchema as Record<string, unknown>;
        if (!inputSchema) continue;
        tools.push({ name: tool.name, title: typeof tool.title === "string" ? tool.title.slice(0, 100) : tool.name,
          description: typeof tool.description === "string" ? tool.description.slice(0, 500) : "", inputSchema });
      }
      if (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor.length > 2048) break;
      cursor = result.nextCursor;
    }
    return tools.filter((tool, index) => tools.findIndex(other => tool.name === other.name) === index).slice(0, 80);
  }
  call(name: string, args: Record<string, unknown>, signal: AbortSignal) { return this.request("tools/call", { name, arguments: args }, signal); }
}
