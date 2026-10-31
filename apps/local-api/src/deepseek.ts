import { createBudget } from "./intent/budget.js";
import { parseModelJson, type ChatMessage, type StepfunResult } from "./stepfun.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_MODELS = ["deepseek-flash", "deepseek-v4-pro"] as const;
export type DeepseekModel = typeof DEEPSEEK_MODELS[number];
export interface DeepseekCredential { apiKey: string; defaultModel: DeepseekModel; checkedAt: string }
export const deepseekModel = (value?: string): DeepseekModel | undefined =>
  !value || value === "deepseek-chat" || value === "deepseek-v4-flash" || value === "deepseek-flash" ? "deepseek-flash"
    : value === "deepseek-v4-pro" ? value : undefined;

/** Keys stay in the account's short-lived server session, never in status JSON. */
export class DeepseekCredentialStore {
  #credential?: DeepseekCredential;
  #error?: string;
  getSecret() { return this.#credential; }
  set(value: DeepseekCredential) { this.#credential = value; this.#error = undefined; }
  clear() { this.#credential = undefined; this.#error = undefined; }
  recordError(message: string) { this.#error = message; }
  status() {
    return { name: "deepseek" as const, connected: Boolean(this.#credential),
      capabilities: this.#credential ? ["structured", "chat", ...(this.#credential.defaultModel === "deepseek-flash" ? ["vision"] : [])] : ["structured", "chat"],
      ...(this.#credential ? { models: [...DEEPSEEK_MODELS], defaultModel: this.#credential.defaultModel, checkedAt: this.#credential.checkedAt } : {}),
      ...(this.#error ? { lastError: this.#error } : {}) };
  }
}
export interface DeepseekDeps { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal }
const failure = (status?: number): StepfunResult<never> => ({ ok: false, code: "provider", ...(status ? { status } : {}),
  error: status === 401 || status === 403 ? "DeepSeek Key 无效或没有权限" : status === 429 ? "DeepSeek 当前繁忙" : "DeepSeek 暂时不可用" });
async function boundedJson(response: Response) {
  if (Number(response.headers.get("content-length")) > 8 * 1024 * 1024) throw Error("response-limit");
  const reader = response.body?.getReader(); if (!reader) throw Error("missing-body");
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const part = await reader.read(); if (part.done) break;
    total += part.value.length;
    if (total > 8 * 1024 * 1024) { await reader.cancel(); throw Error("response-limit"); }
    chunks.push(part.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
async function run<T>(deps: DeepseekDeps, work: (signal: AbortSignal) => Promise<StepfunResult<T>>): Promise<StepfunResult<T>> {
  const budget = createBudget(deps.timeoutMs ?? 45_000, [deps.signal]);
  try { return await budget.run(() => work(budget.signal)); }
  catch {
    return { ok: false, code: deps.signal?.aborted ? "cancelled" : budget.signal.aborted ? "timeout" : "network",
      error: deps.signal?.aborted ? "请求已取消" : budget.signal.aborted ? "DeepSeek 请求超时" : "DeepSeek 连接暂不可用" };
  } finally { budget.dispose(); }
}
export function deepseekChat(credential: DeepseekCredential, messages: ChatMessage[], deps: DeepseekDeps, maxTokens = 8192): Promise<StepfunResult<unknown>> {
  return run(deps, async signal => {
    if (credential.defaultModel !== "deepseek-flash" && messages.some(message => message.images?.length))
      return { ok: false, code: "provider", error: "当前 DeepSeek 模型不支持图片，请选择 Flash 或保留原来的视觉模型。" };
    const response = await (deps.fetchImpl ?? fetch)(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${credential.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: credential.defaultModel, temperature: 0, thinking: { type: "disabled" },
        response_format: { type: "json_object" }, max_tokens: maxTokens,
        messages: messages.map(message => message.images?.length ? { role: message.role,
          content: [{ type: "text", text: message.content }, ...message.images.map(image => ({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data}` } }))] }
          : { role: message.role, content: message.content }) }),
    });
    if (!response.ok) { void response.body?.cancel(); return failure(response.status); }
    const body = await boundedJson(response) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) return { ok: false, code: "invalid-response", error: "DeepSeek 没有返回可用内容" };
    try { return { ok: true, value: parseModelJson(content) }; }
    catch { return { ok: false, code: "invalid-response", error: "DeepSeek 返回内容未通过 JSON 校验" }; }
  });
}
export function validateDeepseek(apiKey: string, model: DeepseekModel, deps: DeepseekDeps): Promise<StepfunResult<Omit<DeepseekCredential, "apiKey">>> {
  return run({ ...deps, timeoutMs: deps.timeoutMs ?? 12_000 }, async signal => {
    const response = await (deps.fetchImpl ?? fetch)(`${DEEPSEEK_BASE_URL}/models`, {
      headers: { authorization: `Bearer ${apiKey}` }, signal, redirect: "error",
    });
    if (!response.ok) { void response.body?.cancel(); return failure(response.status); }
    const body = await boundedJson(response) as { data?: Array<{ id?: string }> };
    if (!body.data?.some(item => item.id === model)) return { ok: false, code: "provider", error: "该 DeepSeek 模型暂不可用" };
    const checkedAt = new Date().toISOString();
    const probe = await deepseekChat({ apiKey, defaultModel: model, checkedAt }, [
      { role: "system", content: '你是一个 JSON 接口。只返回 JSON 对象 {"ok":true}。' }, { role: "user", content: '连接测试，请返回 {"ok":true}。' },
    ], { ...deps, signal }, 256);
    if (!probe.ok) return probe;
    return probe.value && typeof probe.value === "object" && "ok" in probe.value && probe.value.ok === true
      ? { ok: true, value: { defaultModel: model, checkedAt } }
      : { ok: false, code: "invalid-response", error: "DeepSeek 没有确认本次连接测试" };
  });
}
