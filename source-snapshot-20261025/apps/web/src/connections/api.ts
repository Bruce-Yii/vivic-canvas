export type ConnectionProvider = "feishu" | "mcdonalds" | "wecom" | "dingtalk";
export interface ReadTool { name: string; title: string; description: string; inputSchema: Record<string, unknown> }
export interface ConnectionStatus { provider: ConnectionProvider; label: string; configured: boolean; connected: boolean; transport?: "mcp" | "cli"; checkedAt?: string; error?: string; tools: ReadTool[] }
export interface ConnectionResult { provider: ConnectionProvider; source: string; tool: string; title: string; checkedAt: string; text: string; links: Array<{ title: string; url: string }>; truncated: boolean; query?: { tool: string; args: Record<string, unknown> } }
interface ConnectionResponse { ok: boolean; connections?: ConnectionStatus[]; result?: ConnectionResult; error?: string }
export async function connectionRequest(action: "status" | "configure" | "test" | "disconnect" | "query" | "ask", body?: unknown, signal?: AbortSignal): Promise<ConnectionResponse> {
  const response = await fetch(`/api/connections/${action}`, { method: action === "status" ? "GET" : "POST", credentials: "same-origin", cache: "no-store", signal,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await response.json() as ConnectionResponse;
  if (!response.ok || !data.ok) throw new Error(data.error || "连接服务暂时不可用。");
  return data;
}
export function connectionsChanged() { window.dispatchEvent(new Event("vivic:connections-changed")); }
