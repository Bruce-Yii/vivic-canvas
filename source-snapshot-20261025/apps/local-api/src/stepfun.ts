import { setTimeout as delay } from "node:timers/promises";
import type { StepfunCredential } from "./credentials.js";
import { CONNECTION_TIMEOUT_MS, INFERENCE_TIMEOUT_MS, STEPFUN_PLAN_BASE_URL } from "./config.js";
import { createBudget } from "./intent/budget.js";
import { describeProviderError } from "./providerError.js";

/**
 * StepFun Plan client. Generations use /step_plan/v1 exclusively by default.
 * The official model catalog is GET /v1/models (metadata, not generation).
 * Every network path degrades to an honest Chinese error — never throws a
 * stack trace at the HTTP layer, never fakes success. fetch is injectable
 * for tests; a STEPFUN_BASE_URL override supports the guarded e2e stub.
 */

export interface StepfunDeps {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type StepfunErrorCode = "cancelled" | "timeout" | "network" | "provider" | "invalid-response";
export type StepfunResult<T> = { ok: true; value: T } |
  { ok: false; error: string; status?: number; code?: StepfunErrorCode };

const providerRequest = async <T>(
  context: string,
  deps: StepfunDeps,
  defaultTimeout: number,
  work: (signal: AbortSignal) => Promise<StepfunResult<T>>,
): Promise<StepfunResult<T>> => {
  const budget = createBudget(deps.timeoutMs ?? defaultTimeout, [deps.signal]);
  try {
    return await budget.run(() => work(budget.signal));
  } catch (err) {
    // Never echo an abort reason: it may be caller-supplied private text.
    const reason = budget.signal.aborted ? budget.signal.reason : err;
    const cancelled = deps.signal?.aborted && deps.signal.reason?.name !== "TimeoutError";
    const timeout = !cancelled && reason?.name === "TimeoutError";
    return { ok: false, code: cancelled ? "cancelled" : timeout ? "timeout" : "network",
      error: `${context}：${cancelled ? "请求已取消" : timeout ? "请求超时" : "网络请求失败"}` };
  } finally {
    budget.dispose();
  }
};

// Official Plan reasoning models, verified against the docs on 2026-10-15.
export const PLAN_CHAT_MODELS = [
  "step-3.5-flash", "step-3.5-flash-2603", "step-3.7-flash",
  "step-5-preview", "step-router-v1",
];

const PREFERRED_MODELS = [
  "step-3.5-flash",
  "step-3.5-flash-2603",
  "step-3.7-flash",
  "step-5-preview",
  "step-router-v1",
  "step-3",
  "step-2-16k",
  "step-1-128k",
  "step-1-32k",
  "step-1-8k",
];

// Speech/media/generation endpoints are not chat completions; never default
// to them, or /chat/completions 404s (seen live: fallback picked step-tts-mini).
const NON_CHAT_PATTERN =
  /tts|asr|search|gui|music|realtime|audio(?!.*chat)|-gen-|preview/i;

export const pickDefaultModel = (ids: string[]): string | undefined =>
  PREFERRED_MODELS.find((m) => ids.includes(m)) ??
  ids.find((id) => !NON_CHAT_PATTERN.test(id) && id.startsWith("step-"));

interface ModelsResponse {
  data?: Array<{ id?: string }>;
}

export const validateKey = async (
  apiKey: string,
  deps: StepfunDeps,
): Promise<StepfunResult<Omit<StepfunCredential, "apiKey">>> => {
  return providerRequest("无法连接 StepFun", deps, CONNECTION_TIMEOUT_MS, async (signal) => {
    const fetchImpl = deps.fetchImpl ?? fetch;
    // Only metadata uses /v1; generation always stays on the configured base.
    const base = deps.baseUrl.replace(/\/+$/, "");
    const modelsBase = base === STEPFUN_PLAN_BASE_URL ? "https://api.stepfun.com/v1" : base;
    const res = await fetchImpl(`${modelsBase}/models`, {
      headers: { authorization: `Bearer ${apiKey}` }, signal, redirect: "error",
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: "provider", status: res.status, error: await describeProviderError(res, apiKey) };
    }
    if (!res.ok) {
      return { ok: false, code: "provider", status: res.status, error: `StepFun 连接测试失败（HTTP ${res.status}）` };
    }
    let body: ModelsResponse;
    try {
      body = (await res.json()) as ModelsResponse;
      if (!body || !Array.isArray(body.data)) throw new Error("invalid catalog");
    } catch {
      signal.throwIfAborted();
      return { ok: false, code: "invalid-response", error: "StepFun 返回了无法解析的响应" };
    }
    const models = (body.data ?? [])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(id));
    if (models.length === 0) {
      return { ok: false, error: "StepFun 已连通但未返回任何模型" };
    }
    const isPlan = deps.baseUrl.replace(/\/+$/, "") === STEPFUN_PLAN_BASE_URL;
    const defaultModel = pickDefaultModel(
      isPlan ? models.filter((id) => PLAN_CHAT_MODELS.includes(id)) : models,
    );
    if (!defaultModel) {
      return { ok: false, error: "StepFun 未返回可用的 Plan 对话模型（语音模型不能用于规划）" };
    }
    return {
      ok: true,
      value: {
        models,
        defaultModel,
        checkedAt: new Date().toISOString(),
      },
    };
  });
};

export interface ChatMessage {
  role: "system" | "user";
  content: string;
  images?: Array<{ type: "image"; mime: "image/png" | "image/jpeg" | "image/webp"; data: string }>;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 800;
const MAX_RETRY_AFTER_MS = 5000;

/** JSON mode normally returns a bare object; tolerate a fenced or prefixed one. */
export const parseModelJson = (content: string): unknown => {
  const text = content.trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)?.[1];
    if (fenced) return JSON.parse(fenced);
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw error;
  }
};

const retryAfterMs = (value: string | null): number => {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : RETRY_DELAY_MS;
};

/**
 * One JSON-mode chat completion; the caller parses/validates the payload.
 * A dropped connection or a 429/5xx produced no answer, so it is attempted
 * once more inside the caller's deadline. A timeout, a refusal or an
 * unusable answer is returned as-is.
 */
export const chatJson = async (
  credential: StepfunCredential,
  messages: ChatMessage[],
  deps: StepfunDeps,
  options?: { maxTokens?: number },
): Promise<StepfunResult<unknown>> => {
  const first = await chatJsonOnce(credential, messages, deps, options);
  if (first.ok || deps.signal?.aborted) return first;
  const wait = first.code === "network" ? RETRY_DELAY_MS
    : first.code === "provider" && first.status && RETRYABLE_STATUS.has(first.status) ? first.retryAfterMs ?? RETRY_DELAY_MS : undefined;
  if (wait === undefined) return first;
  try { await delay(wait, undefined, deps.signal ? { signal: deps.signal } : undefined); } catch { return first; }
  return chatJsonOnce(credential, messages, deps, options);
};

const chatJsonOnce = async (
  credential: StepfunCredential,
  messages: ChatMessage[],
  deps: StepfunDeps,
  options?: { maxTokens?: number },
): Promise<StepfunResult<unknown> & { retryAfterMs?: number }> => providerRequest("模型请求失败", deps, INFERENCE_TIMEOUT_MS, async (signal) => {
  const res = await (deps.fetchImpl ?? fetch)(`${deps.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: credential.defaultModel,
      messages: messages.map(message => message.images?.length ? { role: message.role,
        content: [{ type: "text", text: message.content }, ...message.images.map(image => ({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data}` } }))],
      } : { role: message.role, content: message.content }),
      temperature: 0.2,
      response_format: { type: "json_object" },
      // Official docs (2026-10-15) confirm these exact models only:
      // /docs/zh/guides/models/step-3.5-flash (2603: low/high)
      // /docs/zh/guides/models/step-3.7-flash (low/medium/high)
      ...(["step-3.5-flash-2603", "step-3.7-flash"].includes(credential.defaultModel)
        ? { reasoning_effort: "low" } : {}),
      ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
    }),
    signal,
    redirect: "error",
  });
  if (!res.ok) {
    const retryAfter = res.headers.get("retry-after");
    return { ok: false, code: "provider", status: res.status, error: await describeProviderError(res, credential.apiKey),
      ...(retryAfter ? { retryAfterMs: retryAfterMs(retryAfter) } : {}) };
  }
  // A body cut off mid-read is a network failure, not a malformed answer.
  const raw = await res.text();
  let body: { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> };
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, code: "provider", status: res.status, error: "模型服务返回了无法解析的响应" };
  }
  const choice = body?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, code: "invalid-response", error: choice?.finish_reason === "length"
      ? "模型思考用尽了输出长度，没有给出结果" : "模型没有返回内容" };
  }
  try {
    return { ok: true, value: parseModelJson(content) };
  } catch {
    return { ok: false, code: "invalid-response", error: "模型返回了非 JSON 内容" };
  }
});

/**
 * The probe proves the key may run Plan inference. A reasoning model can
 * spend its small probe allowance thinking and return no JSON; that is still
 * an accepted HTTP 200 generation, so it must not fail the connection.
 */
export const probeAnswered = (probe: StepfunResult<unknown>): boolean =>
  probe.ok || probe.code === "invalid-response";

/** Both catalog and generation probe share ONE connection-test deadline. */
export const validateConnection = async (
  apiKey: string,
  deps: StepfunDeps,
): Promise<StepfunResult<Omit<StepfunCredential, "apiKey">>> =>
  providerRequest("无法连接 StepFun", deps, CONNECTION_TIMEOUT_MS, async (signal) => {
    const bounded = { ...deps, timeoutMs: deps.timeoutMs ?? CONNECTION_TIMEOUT_MS, signal };
    let catalog = await validateKey(apiKey, bounded);
    // The catalog is a read-only GET: a dropped connection or 5xx is retried once.
    if (!catalog.ok && (catalog.code === "network" || (catalog.status ?? 0) >= 500)) {
      await delay(RETRY_DELAY_MS, undefined, { signal });
      catalog = await validateKey(apiKey, bounded);
    }
    if (!catalog.ok) return catalog;
    signal.throwIfAborted();
    const probe = await chatJson({ apiKey, ...catalog.value }, [
      { role: "system", content: '连接测试。只输出 JSON {"ok":true}，无需解释。' },
      { role: "user", content: "测试连接" },
    ], bounded, { maxTokens: 256 });
    if (!probe.ok && !probeAnswered(probe)) return { ...probe, error: `Plan 推理验证失败：${probe.error}` };
    return { ok: true, value: { ...catalog.value, checkedAt: new Date().toISOString() } };
  });
