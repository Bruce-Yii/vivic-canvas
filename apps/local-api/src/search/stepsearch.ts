import { z } from "zod";
import { SearchError } from "./errors.js";
import { publicHttpsUrl } from "./policy.js";
import { abortError } from "./transport.js";
import type { SearchEvidence } from "./client.js";

// This endpoint is deliberately NOT configurable, even via the model base URL.
export const STEPSEARCH_ENDPOINT = "https://api.stepfun.com/step_plan/v1/mcp/web_search/mcp";
export const STEPSEARCH_PROVIDER = "stepfun/stepsearch-mcp";
// Live StepSearch honors 2024-11-05. Requesting 2025-06-18 instead returned
// 2025-11-25, which this adapter has not implemented or validated.
const VERSION = "2024-11-05";
const invalid = () => new SearchError("search-invalid-response", "StepSearch 返回了不支持的协议或来源格式。", 502);
const tooLarge = () => new SearchError("search-too-large", "StepSearch 响应超过大小限制。", 413);

/** Also bounds injected transports/readers which do not honor AbortSignal. */
export async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); throw abortError(signal); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rpcResult(value: unknown, id: number): Record<string, unknown> | undefined {
  if (!object(value) || value.jsonrpc !== "2.0") throw invalid();
  // Server notifications are data only. No sampling, roots, tools or code dispatch.
  if (typeof value.method === "string" && value.id === undefined && value.result === undefined && value.error === undefined) return;
  if (value.id !== id || value.error !== undefined || !object(value.result)) throw invalid();
  return value.result;
}

/** Bounded UTF-8 JSON / SSE; stop and cancel as soon as our RPC response arrives. */
async function readResult(response: Response, id: number, signal: AbortSignal, maxBytes: number) {
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json" && type !== "text/event-stream") throw invalid();
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw tooLarge();
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let buffer = "";
  let line = "";
  let data: string[] = [];
  let skipLf = false;
  const eventLine = (value: string) => {
    if (value === "") {
      const payload = data.join("\n"); data = [];
      if (payload) return rpcResult(JSON.parse(payload), id);
    } else if (value.startsWith("data:")) {
      data.push(value.slice(5).replace(/^ /, ""));
    }
    return undefined;
  };
  try {
    while (true) {
      const chunk = await untilAborted(reader.read(), signal);
      if (!chunk.done) {
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw tooLarge();
      }
      const text = decoder.decode(chunk.value, { stream: !chunk.done });
      if (type === "application/json") buffer += text;
      else for (const char of text) {
        if (skipLf && char === "\n") { skipLf = false; continue; }
        skipLf = char === "\r";
        if (char === "\r" || char === "\n") {
          const result = eventLine(line); line = "";
          if (result) return result;
        } else line += char;
      }
      if (chunk.done) break;
    }
    if (type === "application/json") {
      const result = rpcResult(JSON.parse(buffer), id);
      if (result) return result;
    }
    // SSE requires an empty line to dispatch an event; incomplete events fail closed.
    throw invalid();
  } finally {
    // Do not wait for a malicious source's cancellation promise.
    void reader.cancel().catch(() => {});
  }
}

const StringInput = z.strictObject({
  type: z.literal("string"), description: z.string().optional(), title: z.string().optional(),
  minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional(),
});
const CountInput = z.strictObject({
  type: z.enum(["integer", "number"]), description: z.string().optional(), title: z.string().optional(),
  minimum: z.number().optional(), maximum: z.number().optional(), default: z.number().optional(),
});
const InputSchema = z.strictObject({
  type: z.literal("object"), properties: z.record(z.string(), z.unknown()),
  required: z.array(z.string()).max(20).optional(), additionalProperties: z.boolean().optional(),
  description: z.string().optional(), title: z.string().optional(), $schema: z.string().optional(),
});

/** Narrow schema negotiation, not an arbitrary JSON Schema interpreter.
 * Unknown required fields/constraints fail BEFORE a potentially charged call.
 * Mainline verified query:string, n:integer(1..20), plus optional category and
 * use_common_search on 2026-10-15. Still check the advertised schema every session.
 */
function searchArguments(raw: unknown, query: string, maxResults: number) {
  const schema = InputSchema.safeParse(raw);
  if (!schema.success) throw invalid();
  const properties = schema.data.properties;
  const q = StringInput.safeParse(properties.query);
  if (!q.success || query.length < (q.data.minLength ?? 0) || query.length > (q.data.maxLength ?? Infinity)) throw invalid();
  const args: Record<string, string | number> = { query };
  // Only the mainline-verified count parameter is sent, if MCP advertises it.
  if (properties.n !== undefined) {
    const n = CountInput.safeParse(properties.n);
    if (!n.success) throw invalid();
    const count = Math.min(maxResults, Math.floor(n.data.maximum ?? maxResults));
    if (count < Math.max(1, n.data.minimum ?? 1)) throw invalid();
    args.n = count;
  }
  if (schema.data.required?.some(name => !Object.hasOwn(args, name))) throw invalid();
  return args;
}

const Sources = z.object({ results: z.array(z.object({
  title: z.string().trim().min(1).max(10_000), url: z.string().min(1).max(2048),
  snippet: z.string().max(100_000),
})).max(100) });
const ToolResult = z.object({
  isError: z.boolean().optional(), structuredContent: z.unknown().optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).max(100).optional(),
});
const clean = (text: string, max: number) => text.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);

function evidence(raw: unknown, key: string, maxResults: number): SearchEvidence[] {
  const tool = ToolResult.safeParse(raw);
  if (!tool.success || tool.data.isError) throw invalid();
  // Only explicit JSON citations are accepted. No guessed titles or parsed prose.
  const payload: unknown = tool.data.structuredContent ?? JSON.parse((tool.data.content ?? []).map(item => item.text).join("\n"));
  const sources = Sources.safeParse(payload);
  if (!sources.success) throw invalid();
  // A provider must never reflect the credential into cards, logs or exports.
  if (JSON.stringify(sources.data).includes(key) || JSON.stringify(sources.data).includes(encodeURIComponent(key))) throw invalid();
  const results: SearchEvidence[] = [];
  const seen = new Set<string>();
  const fetchedAt = new Date().toISOString();
  for (const row of sources.data.results) {
    let url: URL;
    try { url = publicHttpsUrl(row.url); } catch { continue; }
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    results.push({ title: clean(row.title, 300), url: url.href, snippet: clean(row.snippet, 700),
      provider: STEPSEARCH_PROVIDER, fetchedAt, readFullPage: false });
    if (results.length >= maxResults) break;
  }
  if (sources.data.results.length && !results.length) throw invalid();
  return results;
}

/** One isolated MCP session per search. No credential/session cache or retries. */
export async function callStepSearch(options: {
  apiKey: string; query: string; maxResults: number; maxBytes: number;
  signal: AbortSignal; fetchImpl?: typeof fetch; assertCurrent: () => void;
}): Promise<SearchEvidence[]> {
  const { signal, assertCurrent } = options;
  let session: string | undefined;
  let version: string | undefined;
  let nextId = 0;
  async function post(method: string, params?: unknown, notification = false): Promise<Record<string, unknown>> {
    assertCurrent();
    if (signal.aborted) throw abortError(signal);
    const id = notification ? undefined : ++nextId;
    const pending = (options.fetchImpl ?? fetch)(STEPSEARCH_ENDPOINT, {
      method: "POST", redirect: "error", credentials: "omit", signal,
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session ? { "Mcp-Session-Id": session } : {}), ...(version ? { "MCP-Protocol-Version": version } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, ...(params !== undefined ? { params } : {}) }),
    });
    // Cancel late responses even if a test/custom transport ignores cancellation.
    void pending.then(res => { if (signal.aborted) void res.body?.cancel().catch(() => {}); }, () => {});
    let response: Response;
    try { response = await untilAborted(pending, signal); }
    catch {
      if (signal.aborted) throw abortError(signal);
      throw new SearchError("search-unavailable", "StepSearch 网络连接失败，请稍后重试。", 502);
    }
    try {
      assertCurrent();
      if (response.status === 401 || response.status === 403) throw new SearchError("search-auth-required", "StepSearch 认证失败，请检查 Plan Key 或重新连接。", 503);
      if (response.status === 429) throw new SearchError("search-rate-limited", "StepSearch 额度或请求频率受限，请稍后重试。", 429);
      if (!response.ok || response.redirected || (response.url && response.url !== STEPSEARCH_ENDPOINT)) {
        throw new SearchError("search-unavailable", "StepSearch 当前不可用，请稍后重试。", 502);
      }
      if (notification) {
        if (response.status !== 202) throw invalid();
        // Fetch can expose an empty 202 body as a stream instead of null.
        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const chunk = await untilAborted(reader.read(), signal);
              if (chunk.done) break;
              if (chunk.value.byteLength) throw invalid();
            }
          } finally { void reader.cancel().catch(() => {}); }
        }
        assertCurrent();
        return {};
      }
      const result = await readResult(response, id!, signal, options.maxBytes);
      assertCurrent();
      if (method === "initialize") {
        const value = response.headers.get("mcp-session-id");
        if (value !== null) {
          if (!/^[\x21-\x7e]{1,1024}$/.test(value)) throw invalid();
          session = value;
        }
      }
      return result;
    } finally { if (!response.body?.locked) void response.body?.cancel().catch(() => {}); }
  }
  try {
    const initialized = await post("initialize", { protocolVersion: VERSION, capabilities: {},
      clientInfo: { name: "vivic-search", version: "0.6.0" } });
    if (![VERSION, "2025-03-26", "2025-06-18"].includes(String(initialized.protocolVersion))
      || !object(initialized.capabilities) || !object(initialized.capabilities.tools)
      || !object(initialized.serverInfo) || typeof initialized.serverInfo.name !== "string"
      || typeof initialized.serverInfo.version !== "string") throw invalid();
    version = String(initialized.protocolVersion);
    await post("notifications/initialized", undefined, true);
    // Bounded pagination. Only web_search is callable, regardless of advertised tools.
    let cursor: string | undefined;
    const cursors = new Set<string>();
    let found: Record<string, unknown> | undefined;
    for (let page = 0; page < 3; page++) {
      const list = await post("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(list.tools) || list.tools.length > 100 || !list.tools.every(object)) throw invalid();
      const matches = list.tools.filter(tool => tool.name === "web_search");
      if (matches.length > 1 || (found && matches.length)) throw invalid();
      found ??= matches[0];
      if (list.nextCursor === undefined) break;
      if (typeof list.nextCursor !== "string" || !list.nextCursor.length || list.nextCursor.length > 1024
        || cursors.has(list.nextCursor) || page === 2) throw invalid();
      cursor = list.nextCursor; cursors.add(cursor);
    }
    if (!found) throw invalid();
    const args = searchArguments(found.inputSchema, options.query, options.maxResults);
    const result = await post("tools/call", { name: "web_search", arguments: args });
    assertCurrent();
    return evidence(result, options.apiKey, options.maxResults);
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    if (error instanceof SearchError) throw error;
    throw invalid();
  }
}
