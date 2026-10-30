export type LlmProvider = "stepfun" | "gpt";
export interface LoginStatus { phase: "idle" | "waiting" | "verifying" | "connected" | "error"; authUrl?: string; needsInput?: boolean; prompt?: string; error?: string; }
export function notifyProviderChange() { window.dispatchEvent(new Event("vivic:provider-change")); }
async function post(path: string, body = {}) {
  notifyProviderChange();
  // The backend's GPT check may spend up to 60 s on slow proxy tunnels.
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(75_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "连接请求失败。");
  return data as { ok: boolean; error?: string; lastError?: string; login?: LoginStatus };
}
export const selectLlmProvider = (provider: LlmProvider) => post("/api/providers/select", { provider });
export const selectLlmModel = (provider: LlmProvider, model: string) => post("/api/providers/model", { provider, model });
export const connectGpt = (source: "pi" | "vivic") => post("/api/gpt/connect", { source });
export const disconnectGpt = () => post("/api/gpt/disconnect");
export const startGptLogin = () => post("/api/gpt/login/start");
export const cancelGptLogin = () => post("/api/gpt/login/cancel");
export const completeGptLogin = (value: string) => post("/api/gpt/login/input", { value });
export const getGptLoginStatus = async (): Promise<{ login: LoginStatus }> => {
  const response = await fetch("/api/gpt/login/status", { cache: "no-store", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("无法查询登录状态。");
  return response.json();
};
