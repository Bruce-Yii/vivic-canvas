import type { z } from "zod";
import {
  findPreset, pickDefaultModel, toModelInfo, validateProtocolModel,
  type ModelInfo, type ModelsResult, type ProviderConfig, type ProviderErrorType,
  type ProviderProtocol, type ProviderRole, type TestConnectionResult,
} from "./types.js";

/**
 * Protocol-aware provider client.
 *
 * One class serves every supported protocol so the settings UI never has to
 * know request shapes. Two rules matter for correctness:
 *  - a "connection test" must be a real inference (a 200 on /health proves
 *    nothing about whether the model can answer), and
 *  - the 4B and 2B decision models speak different bodies on the same path,
 *    so the protocol decides the payload.
 */

export const TEST_TIMEOUT_MS = 30_000;
export const MODELS_TIMEOUT_MS = 15_000;

const trimBase = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

/** StepFun Plan serves generations from /step_plan/v1 but the catalog from /v1. */
export const modelsUrl = (config: Pick<ProviderConfig, "protocol" | "baseUrl">): string => {
  const base = trimBase(config.baseUrl);
  if (config.protocol === "stepfun-plan" && /stepfun\.com/i.test(base)) {
    return "https://api.stepfun.com/v1/models";
  }
  if (config.protocol === "startlux-native" || config.protocol === "legacy-2b") return `${base}/models`;
  return `${base}/models`;
};

export const chatUrl = (config: Pick<ProviderConfig, "protocol" | "baseUrl">): string =>
  `${trimBase(config.baseUrl)}/chat/completions`;

export const decisionsUrl = (config: Pick<ProviderConfig, "baseUrl">): string =>
  `${trimBase(config.baseUrl)}/decisions`;

/** Speech-to-text endpoints are not chat completions: an ASR-only provider must
 *  be probed on the transcription route, or "test connection" always 404s. */
export const transcribeUrl = (config: Pick<ProviderConfig, "baseUrl">): string =>
  `${trimBase(config.baseUrl)}/audio/transcriptions`;

/** True when the provider serves speech-to-text only (no main/decision model). */
export const asrOnlyProvider = (roles: readonly ProviderRole[] | undefined): boolean =>
  Array.isArray(roles) && roles.includes("asr") && !roles.some(role => role === "main" || role === "decision");

/** 0.2 s of 16 kHz mono 16-bit PCM silence, built in memory: a transport probe,
 *  never user audio, and no binary asset to ship. */
export const probeWav = (): ArrayBuffer => {
  const dataBytes = 3_200 * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, dataBytes, true);
  // PCM payload is already all zero bytes: silence.
  void bytes;
  return buffer;
};

export const authHeaders = (
  config: Pick<ProviderConfig, "protocol" | "presetId" | "apiKey" | "headers">,
): Record<string, string> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const preset = findPreset(config.presetId);
  const style = preset?.auth ?? "bearer";
  if (config.apiKey && style !== "none") {
    if (style === "api-key-header") headers[preset?.apiKeyHeader ?? "x-api-key"] = config.apiKey;
    else headers.authorization = `Bearer ${config.apiKey}`;
  }
  for (const [key, value] of Object.entries(config.headers ?? {})) {
    if (/^[A-Za-z0-9-]{1,64}$/.test(key) && !/^authorization$/i.test(key)) headers[key] = value;
  }
  return headers;
};

/** Never echo the key, a URL with credentials, or an upstream body verbatim. */
const safeSnippet = (text: string): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
};

const classifyHttp = (status: number, body: string): { errorType: ProviderErrorType; error: string } => {
  const text = body.toLowerCase();
  if (status === 401 || status === 403) {
    return { errorType: "auth", error: `鉴权失败（HTTP ${status}）：API Key 无效、过期或没有该模型的权限。` };
  }
  if (status === 404) {
    return { errorType: "not-found", error: `端点不存在（HTTP 404）：请检查 Base URL 是否包含正确的版本前缀（如 /v1）。` };
  }
  if (/no active step plan subscription|step plan|subscription/i.test(text)) {
    return { errorType: "unsupported", error: "该 Key 没有 Step Plan 订阅（HTTP 400 no active step plan subscription）。请改用 StepFun 普通 API（/v1）预设。" };
  }
  if (/field required/i.test(text) && /state|questions/.test(text)) {
    return { errorType: "protocol", error: "请求体与模型协议不匹配（HTTP 422：需要 state/questions）。4B 必须使用 StartLux 原生协议。" };
  }
  if (/use 1.{0,3}2000 characters of input|characters of input/i.test(text)) {
    return { errorType: "protocol", error: "请求体与模型协议不匹配（HTTP 400：需要 input）。该模型使用旧版 {input, labels} 协议。" };
  }
  if (status === 429) {
    return { errorType: "unknown", error: "请求过于频繁（HTTP 429）：已达速率或并发上限，请稍后重试。" };
  }
  if (status >= 500) {
    return { errorType: "unknown", error: `上游服务错误（HTTP ${status}）：服务端暂时不可用。` };
  }
  return { errorType: "unknown", error: `请求被拒绝（HTTP ${status}）：${safeSnippet(body) || "上游未返回原因"}` };
};

/** Node's fetch nests the real cause; walk the chain (and AggregateError members). */
const causeCode = (error: unknown): string => {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): string => {
    if (!value || depth > 5 || seen.has(value)) return "";
    seen.add(value);
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,40}$/.test(code)) return code;
    const members = (value as { errors?: unknown }).errors;
    if (Array.isArray(members)) {
      for (const member of members) {
        const found = visit(member, depth + 1);
        if (found) return found;
      }
    }
    return visit((value as { cause?: unknown }).cause, depth + 1);
  };
  return visit(error, 0);
};

const classifyTransport = (error: unknown): { errorType: ProviderErrorType; error: string } => {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const code = causeCode(error);
  if (name === "TimeoutError" || (name === "AbortError" && /timeout/i.test(message))) {
    return { errorType: "timeout", error: "连接超时：端点在规定时间内没有响应。" };
  }
  if (name === "AbortError") return { errorType: "timeout", error: "请求已取消。" };
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(message)) {
    return { errorType: "network", error: "端口拒绝连接（ECONNREFUSED）：目标地址没有服务在监听，或端口不对。" };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /ENOTFOUND|getaddrinfo/.test(message)) {
    return { errorType: "network", error: "域名解析失败：请检查 Base URL 的域名或本机 DNS。" };
  }
  if (code === "ETIMEDOUT" || /ETIMEDOUT/.test(message)) {
    return { errorType: "timeout", error: "网络连接超时：目标不可达或被防火墙拦截。" };
  }
  if (/CERT|TLS|SSL/i.test(code) || /certificate|self.signed/i.test(message)) {
    return { errorType: "network", error: "TLS 证书校验失败：自签证书或证书链不完整。" };
  }
  // Some Node/OS combinations discard the syscall code entirely ("fetch
  // failed"), so the fallback must still tell the user what to check.
  const opaque = /fetch failed|network error|failed to fetch/i.test(message);
  const detail = opaque || !message ? "" : `：${safeSnippet(message)}`;
  return {
    errorType: "network",
    error: `无法连接目标端点${detail}。请检查 Base URL 的主机与端口是否正确，以及目标服务（本地模型/网关）是否已启动${code ? `（${code}）` : ""}。`,
  };
};

const withTimeout = (ms: number, parent?: AbortSignal): AbortSignal =>
  parent ? AbortSignal.any([parent, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

const parseModelIds = (body: unknown): string[] | undefined => {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const data = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : undefined;
  if (!data) return undefined;
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry === "string") { ids.push(entry); continue; }
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id
      : typeof row.name === "string" ? row.name
      : typeof row.model === "string" ? row.model : undefined;
    if (id) ids.push(id);
  }
  return [...new Set(ids)];
};

const startluxBody = (model: string) => ({
  model,
  state: { utterance: "把卡片放一屏" },
  questions: {
    intent: {
      type: "choice",
      instructions: "仅做连接测试，不执行任何操作。",
      criteria: { fit: "一屏显示全部", other: "其他" },
    },
  },
});

const legacyBody = (model: string) => ({
  model,
  input: "把卡片放一屏",
  labels: { fit: "一屏显示全部", other: "其他" },
  threshold: 0.5,
});

const chatBody = (model: string) => ({
  model,
  messages: [{ role: "user", content: "只回复 ok" }],
  max_tokens: 8,
  temperature: 0,
  stream: false,
});

/** A reachable ASR endpoint rejects the built-in silence with an audio-domain
 *  error ("no speech found"): URL, key and model were all accepted, which is
 *  what a connection test proves. Anything about format/auth/route stays a
 *  failure, so a broken request shape can never masquerade as "connected". */
const noSpeechProbe = (body: string): boolean =>
  /no speech|speech not found|no speech detected|empty audio|audio is empty|unable to transcribe|没有(?:检测到)?(?:语音|说话)|静音/u.test(body);

export interface ProviderClientDeps {
  fetchImpl?: typeof fetch;
  testTimeoutMs?: number;
  modelsTimeoutMs?: number;
}

export class ProviderClient {
  readonly #fetch: typeof fetch;
  readonly #testTimeoutMs: number;
  readonly #modelsTimeoutMs: number;

  constructor(deps: ProviderClientDeps = {}) {
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#testTimeoutMs = deps.testTimeoutMs ?? TEST_TIMEOUT_MS;
    this.#modelsTimeoutMs = deps.modelsTimeoutMs ?? MODELS_TIMEOUT_MS;
  }

  /**
   * Real inference probe. Returns latency and the model that answered; a
   * transport/HTTP/protocol failure is reported with a typed reason.
   */
  async testConnection(
    config: ProviderConfig,
    options: { signal?: AbortSignal; model?: string } = {},
  ): Promise<TestConnectionResult> {
    const model = options.model ?? config.model;
    if (!model) {
      return { ok: false, error: "请先选择或填写模型名。", errorType: "protocol" };
    }
    const protocolCheck = validateProtocolModel(config.protocol, model);
    if (!protocolCheck.ok) return { ok: false, error: protocolCheck.error, errorType: "protocol" };

    const started = performance.now();
    const signal = withTimeout(this.#testTimeoutMs, options.signal);
    try {
      // A pure-ASR provider has no chat model at all: chat/completions is a 404
      // by definition, which used to make "test connection" always fail while
      // /api/transcribe worked. Probe the route the roles actually serve.
      if (asrOnlyProvider(config.roles)) return await this.#testTranscription(config, model, signal, started);
      const { url, body } = this.#probeRequest(config, model);
      const response = await this.#fetch(url, {
        method: "POST",
        headers: authHeaders(config),
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
      const latencyMs = Math.round(performance.now() - started);
      const text = await response.text();
      if (!response.ok) {
        const { errorType, error } = classifyHttp(response.status, text);
        return { ok: false, error, errorType, httpStatus: response.status, latencyMs };
      }
      const parsed = this.#parseProbeResponse(config.protocol, text);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error, errorType: "invalid-response", httpStatus: response.status, latencyMs };
      }
      return { ok: true, latencyMs, model, httpStatus: response.status };
    } catch (error) {
      const { errorType, error: message } = classifyTransport(error);
      return { ok: false, error: message, errorType, latencyMs: Math.round(performance.now() - started) };
    }
  }

  /** Real speech-to-text probe for an ASR-only provider: multipart, built-in
   *  silence sample, and a decoded `text` field as the only success criterion. */
  async #testTranscription(
    config: ProviderConfig,
    model: string,
    signal: AbortSignal,
    started: number,
  ): Promise<TestConnectionResult> {
    const form = new FormData();
    form.append("file", new Blob([probeWav()], { type: "audio/wav" }), "probe.wav");
    form.append("model", model);
    const headers = authHeaders(config);
    // fetch must set the multipart boundary itself.
    delete headers["content-type"];
    try {
      const response = await this.#fetch(transcribeUrl(config), {
        method: "POST", headers, body: form, signal, redirect: "error",
      });
      const latencyMs = Math.round(performance.now() - started);
      const text = await response.text();
      if (!response.ok) {
        // Silence is not speech: the endpoint answering "no speech found" still
        // confirms the route, the key and the model; every other error does not.
        if (noSpeechProbe(text)) return { ok: true, latencyMs, model, httpStatus: response.status };
        const { errorType, error } = classifyHttp(response.status, text);
        return { ok: false, error, errorType, httpStatus: response.status, latencyMs };
      }
      let body: unknown;
      try { body = JSON.parse(text); } catch {
        return { ok: false, latencyMs, httpStatus: response.status, errorType: "invalid-response",
          error: "语音识别响应不是 JSON：端点可能不是 /audio/transcriptions。" };
      }
      const record = body && typeof body === "object" ? body as Record<string, unknown> : undefined;
      if (!record || typeof record.text !== "string") {
        return { ok: false, latencyMs, httpStatus: response.status, errorType: "invalid-response",
          error: "语音识别响应缺少 text 字段：端点可能不是 /audio/transcriptions。" };
      }
      return { ok: true, latencyMs, model, httpStatus: response.status };
    } catch (error) {
      const { errorType, error: message } = classifyTransport(error);
      return { ok: false, error: message, errorType, latencyMs: Math.round(performance.now() - started) };
    }
  }

  #probeRequest(config: ProviderConfig, model: string): { url: string; body: unknown } {
    switch (config.protocol) {
      case "startlux-native":
        return { url: decisionsUrl(config), body: startluxBody(model) };
      case "legacy-2b":
        return { url: decisionsUrl(config), body: legacyBody(model) };
      case "stepfun-v1":
      case "stepfun-plan":
      case "openai-compatible":
      default:
        return { url: chatUrl(config), body: chatBody(model) };
    }
  }

  #parseProbeResponse(
    protocol: ProviderProtocol,
    text: string,
  ): { ok: true } | { ok: false; error: string } {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, error: "上游返回了无法解析的响应（不是 JSON）。" };
    }
    if (!body || typeof body !== "object") return { ok: false, error: "上游返回了空的响应体。" };
    const record = body as Record<string, unknown>;
    if (record.error) {
      const message = typeof record.error === "string" ? record.error
        : typeof (record.error as { message?: unknown }).message === "string"
          ? String((record.error as { message?: unknown }).message) : "";
      const classified = classifyHttp(400, message);
      return { ok: false, error: classified.error };
    }
    if (protocol === "startlux-native") {
      const answers = record.answers;
      if (!answers || typeof answers !== "object") {
        return { ok: false, error: "4B 原生响应缺少 answers 字段：端点可能不是 StartLux 原生协议。" };
      }
      return { ok: true };
    }
    if (protocol === "legacy-2b") {
      if (typeof record.choice !== "string" && record.choice !== null) {
        return { ok: false, error: "旧版决策响应缺少 choice 字段：端点可能不是 2B 适配器协议。" };
      }
      return { ok: true };
    }
    const choices = record.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return { ok: false, error: "OpenAI 兼容响应缺少 choices 字段：端点可能不是 chat/completions。" };
    }
    return { ok: true };
  }

  /**
   * Live catalog discovery. Falls back to the preset's static list when the
   * platform has no /models endpoint, so the user still never types a name.
   */
  async fetchModels(
    config: ProviderConfig,
    options: { signal?: AbortSignal } = {},
  ): Promise<ModelsResult> {
    const preset = findPreset(config.presetId);
    const fallback = (error?: string, errorType?: ProviderErrorType): ModelsResult => {
      const staticIds = preset?.defaultModels ?? [];
      if (staticIds.length) {
        return {
          ok: true,
          models: staticIds.map(toModelInfo),
          fallback: true,
          ...(error ? { error } : {}),
          ...(errorType ? { errorType } : {}),
        };
      }
      return {
        ok: false,
        error: error ?? "该平台不支持 /models 发现，且没有内置模型清单；请手动填写模型名。",
        ...(errorType ? { errorType } : {}),
      };
    };

    if (preset && !preset.supportsModelsEndpoint) {
      return fallback("该平台没有公开的 /models 端点，已使用内置模型清单。", "unsupported");
    }

    const signal = withTimeout(this.#modelsTimeoutMs, options.signal);
    try {
      const response = await this.#fetch(modelsUrl(config), {
        method: "GET",
        headers: (() => {
          const headers = authHeaders(config);
          delete headers["content-type"];
          return headers;
        })(),
        signal,
        redirect: "error",
      });
      const text = await response.text();
      if (!response.ok) {
        const { errorType, error } = classifyHttp(response.status, text);
        return fallback(error, errorType);
      }
      let body: unknown;
      try { body = JSON.parse(text); } catch { return fallback("模型列表不是合法 JSON。", "invalid-response"); }
      const ids = parseModelIds(body);
      if (!ids || ids.length === 0) return fallback("模型列表为空或格式不符合 data[].id。", "invalid-response");
      const models: ModelInfo[] = ids.map(toModelInfo);
      const preferred = preset?.defaultModel ? [preset.defaultModel, ...(preset.defaultModels ?? [])] : undefined;
      // Keep the preset default first when present so the UI preselects it.
      const sorted = pickDefaultModel(models, preferred);
      const ordered = sorted ? [models.find((m) => m.id === sorted)!, ...models.filter((m) => m.id !== sorted)] : models;
      return { ok: true, models: ordered, httpStatus: response.status };
    } catch (error) {
      const { errorType, error: message } = classifyTransport(error);
      return fallback(message, errorType);
    }
  }

  /** Pick a default model for a freshly discovered list. */
  static pickDefault(models: readonly ModelInfo[], presetId?: string): string | undefined {
    const preset = findPreset(presetId);
    return pickDefaultModel(models, preset ? [preset.defaultModel, ...preset.defaultModels].filter((v): v is string => Boolean(v)) : undefined);
  }
}

export type ProviderClientSchema = z.ZodType<ProviderClient>;
