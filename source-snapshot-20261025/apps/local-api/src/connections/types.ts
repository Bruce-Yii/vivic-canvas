import { z } from "zod";
import { DINGTALK_READ_TOOLS } from "./dingtalkCatalog.js";

export const ProviderSchema = z.enum(["feishu", "mcdonalds", "wecom", "dingtalk"]);
export type ConnectionProvider = z.infer<typeof ProviderSchema>;
export const ConnectionConfigSchema = z.object({
  provider: ProviderSchema,
  transport: z.enum(["mcp", "cli"]).default("mcp"),
  token: z.string().trim().min(8).max(8192).regex(/^[^\r\n\0]+$/).optional(),
  endpoint: z.string().trim().max(8192).optional(),
  appId: z.string().trim().regex(/^cli_[A-Za-z0-9_-]{4,100}$/).optional(),
}).strict();
export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;
export interface ReadTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface ConnectionStatus {
  provider: ConnectionProvider;
  label: string;
  configured: boolean;
  connected: boolean;
  transport?: "mcp" | "cli";
  checkedAt?: string;
  error?: string;
  tools: ReadTool[];
}
export interface ConnectionResult {
  provider: ConnectionProvider;
  source: string;
  tool: string;
  title: string;
  checkedAt: string;
  text: string;
  links: Array<{ title: string; url: string }>;
  truncated: boolean;
  query: { tool: string; args: Record<string, unknown> };
}
export const LABELS: Record<ConnectionProvider, string> = { feishu: "飞书", mcdonalds: "麦当劳", wecom: "企业微信", dingtalk: "钉钉" };
export class ConnectionError extends Error {
  readonly code: string;
  readonly status: 400 | 401 | 403 | 409 | 413 | 429 | 502 | 503;
  constructor(code: string, message: string, status: 400 | 401 | 403 | 409 | 413 | 429 | 502 | 503 = 400) { super(message); this.code = code; this.status = status; }
}

export const FEISHU_READ_TOOLS = ["search-doc", "fetch-doc", "list-docs", "get-comments", "search-user", "get-user"];
const MCD_READ_TOOLS = new Set(["campaign-calendar", "available-coupons", "query-my-coupons", "query-my-account", "list-nutrition-foods", "query-nearby-stores", "query-meals", "query-meal-detail", "query-store-coupons", "query-order", "order-list", "mall-order-list", "query-lottery-info", "query-my-prizes", "query-party-city", "query-party-store", "query-partystore-date", "query-partystore-session", "delivery-query-addresses", "delivery-query-stores", "query-meal-assistance"]);
export function readToolAllowed(provider: ConnectionProvider, name: string, annotations: unknown): boolean {
  if (provider === "feishu") return FEISHU_READ_TOOLS.includes(name);
  if (provider === "mcdonalds") return MCD_READ_TOOLS.has(name);
  if (provider !== "dingtalk" || !DINGTALK_READ_TOOLS.includes(name)) return false;
  const hints = annotations && typeof annotations === "object" ? annotations as Record<string, unknown> : {};
  return hints.readOnlyHint !== false && hints.destructiveHint !== true;
}

/** Providers may only supply official HTTPS endpoints. Never accept arbitrary hosts or redirects. */
export function endpointFor(config: ConnectionConfig): URL {
  const raw = config.provider === "feishu" ? "https://mcp.feishu.cn/mcp"
    : config.provider === "mcdonalds" ? "https://mcp.mcd.cn" : config.endpoint;
  if (!raw) throw new ConnectionError("endpoint-required", "请粘贴钉钉官方 MCP 服务地址。");
  let url: URL;
  try { url = new URL(raw); } catch { throw new ConnectionError("invalid-endpoint", "MCP 服务地址格式不正确。"); }
  const allowed = config.provider === "dingtalk" ? ["mcp-gw.dingtalk.com"] : config.provider === "feishu" ? ["mcp.feishu.cn"] : ["mcp.mcd.cn"];
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || url.hash || !allowed.includes(url.hostname)) {
    throw new ConnectionError("invalid-endpoint", "只支持此平台的官方 HTTPS MCP 地址。");
  }
  return url;
}
