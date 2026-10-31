import { z } from "zod";

/**
 * Generic model-provider configuration.
 *
 * A provider is one endpoint (base URL + credential + default model) that can
 * serve one or more roles. Settings here take precedence over the legacy
 * environment variables (VIVIC_MAIN_PROVIDER / VIVIC_DEEPSEEK_*) without
 * removing them: an empty store keeps today's behaviour byte for byte.
 */

export type ProviderProtocol =
  | "openai-compatible"
  | "stepfun-v1"
  | "stepfun-plan"
  | "startlux-native"
  | "legacy-2b";

export type ProviderRole = "main" | "decision" | "asr" | "tts" | "embedding";

export type ProviderKind = "preset" | "custom";

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  presetId?: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  /** Encrypted at rest; never serialized to clients. */
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
  roles: ProviderRole[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Safe shape for clients: no key material, only whether one is stored. */
export interface ProviderView {
  id: string;
  name: string;
  kind: ProviderKind;
  presetId?: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  model?: string;
  headers?: Record<string, string>;
  roles: ProviderRole[];
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyHint?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderStatus extends ProviderView {
  connected: boolean;
  latencyMs?: number;
  lastCheckedAt?: string;
  lastError?: string;
  errorType?: ProviderErrorType;
}

export type ProviderErrorType =
  | "timeout"
  | "network"
  | "auth"
  | "not-found"
  | "protocol"
  | "unsupported"
  | "invalid-response"
  | "unknown";

export type ModelKind = "chat" | "embedding" | "audio" | "unknown";

export interface ModelInfo {
  id: string;
  kind: ModelKind;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs?: number;
  model?: string;
  models?: number;
  error?: string;
  errorType?: ProviderErrorType;
  httpStatus?: number;
}

export interface ModelsResult {
  ok: boolean;
  models?: ModelInfo[];
  error?: string;
  errorType?: ProviderErrorType;
  httpStatus?: number;
  /** True when the preset's built-in list was used instead of a live call. */
  fallback?: boolean;
}

export interface ProviderPreset {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  /** Some platforms expose no /models; the preset carries a static list. */
  supportsModelsEndpoint: boolean;
  defaultModels: string[];
  defaultModel?: string;
  /** Auth style used by the platform. */
  auth: "bearer" | "api-key-header" | "none";
  apiKeyHeader?: string;
  description?: string;
  /** Roles this preset is a sensible default for. */
  roles?: ProviderRole[];
}

const MODEL_ID = /^[a-zA-Z0-9_.:\/-]{1,200}$/;

export const PROVIDER_PROTOCOLS = [
  "openai-compatible",
  "stepfun-v1",
  "stepfun-plan",
  "startlux-native",
  "legacy-2b",
] as const;

export const PROVIDER_ROLES = ["main", "decision", "asr", "tts", "embedding"] as const;

export const ProviderProtocolSchema = z.enum(PROVIDER_PROTOCOLS);
export const ProviderRoleSchema = z.enum(PROVIDER_ROLES);
export const ModelIdSchema = z.string().regex(MODEL_ID, "模型名只能包含字母、数字、点、冒号、斜线、下划线和连字符");

/** Operator-supplied endpoint: http(s) only, no embedded credentials. */
export const ProviderBaseUrlSchema = z.string().trim().min(1).max(2048).refine((value) => {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return (url.protocol === "http:" || url.protocol === "https:")
    && !url.username && !url.password && !url.hash;
}, "请填写合法的 http(s) 地址，且不要包含账号密码");

export const CreateProviderSchema = z.strictObject({
  name: z.string().trim().min(1).max(64),
  protocol: ProviderProtocolSchema,
  baseUrl: ProviderBaseUrlSchema,
  apiKey: z.string().min(1).max(4096).optional(),
  model: ModelIdSchema.optional(),
  headers: z.record(z.string().max(64), z.string().max(2048)).optional(),
  roles: z.array(ProviderRoleSchema).max(5).optional(),
  presetId: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
});

export const UpdateProviderSchema = CreateProviderSchema.partial().extend({
  /** Explicitly clear the stored key. */
  clearApiKey: z.boolean().optional(),
});

export type CreateProviderInput = z.infer<typeof CreateProviderSchema>;
export type UpdateProviderInput = z.infer<typeof UpdateProviderSchema>;

/**
 * Preset catalogue. Every field stays editable in the UI; the preset only
 * pre-fills sensible defaults so a user never has to type a model name.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "stepfun-v1",
    name: "StepFun API（普通 /v1）",
    protocol: "stepfun-v1",
    baseUrl: "https://api.stepfun.com/v1",
    supportsModelsEndpoint: true,
    auth: "bearer",
    defaultModels: ["step-3.5-flash", "step-3.7-flash", "step-5-preview", "step-3", "step-2-16k"],
    defaultModel: "step-3.5-flash",
    description: "阶跃星辰普通 API Key（无 Step Plan 订阅时用这个）",
    roles: ["main"],
  },
  {
    id: "stepfun-plan",
    name: "StepFun Plan（/step_plan/v1）",
    protocol: "stepfun-plan",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    supportsModelsEndpoint: true,
    auth: "bearer",
    defaultModels: ["step-3.5-flash", "step-3.5-flash-2603", "step-3.7-flash", "step-5-preview", "step-router-v1"],
    defaultModel: "step-3.5-flash",
    description: "阶跃星辰 Coding Plan（需有效订阅，否则 400 no active step plan subscription）",
    roles: ["main"],
  },
  {
    id: "deepseek",
    name: "DeepSeek 官方",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    supportsModelsEndpoint: true,
    auth: "bearer",
    defaultModels: ["deepseek-flash", "deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-flash",
    roles: ["main"],
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    supportsModelsEndpoint: true,
    auth: "bearer",
    defaultModels: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o4-mini"],
    defaultModel: "gpt-4o-mini",
    roles: ["main"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    supportsModelsEndpoint: true,
    auth: "bearer",
    defaultModels: [],
    roles: ["main"],
  },
  {
    id: "moonshot",
    name: "Moonshot（Kimi）",
    protocol: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    supportsModelsEndpoint: true,
    auth: "bearer",
    defaultModels: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    defaultModel: "moonshot-v1-8k",
    roles: ["main"],
  },
  {
    id: "zhipu",
    name: "智谱 AI（GLM）",
    protocol: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    supportsModelsEndpoint: false,
    auth: "bearer",
    defaultModels: ["glm-4-plus", "glm-4-0520", "glm-4-air", "glm-4-flash"],
    defaultModel: "glm-4-flash",
    roles: ["main"],
  },
  {
    id: "dashscope",
    name: "通义 / DashScope",
    protocol: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    supportsModelsEndpoint: false,
    auth: "bearer",
    defaultModels: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen3-max"],
    defaultModel: "qwen-plus",
    roles: ["main"],
  },
  {
    id: "siliconflow",
    name: "硅基流动 SiliconFlow",
    protocol: "openai-compatible",
    baseUrl: "https://api.siliconflow.cn/v1",
    supportsModelsEndpoint: true,
    auth: "bearer",
    defaultModels: [],
    roles: ["main"],
  },
  {
    id: "ollama",
    name: "Ollama（本地）",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    supportsModelsEndpoint: true,
    auth: "none",
    defaultModels: [],
    description: "本机 Ollama，通常无需 Key",
    roles: ["main", "decision"],
  },
  {
    id: "lmstudio",
    name: "LM Studio（本地）",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    supportsModelsEndpoint: true,
    auth: "none",
    defaultModels: [],
    description: "本机 LM Studio，通常无需 Key",
    roles: ["main"],
  },
  {
    id: "vllm",
    name: "vLLM（本地）",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:8000/v1",
    supportsModelsEndpoint: true,
    auth: "none",
    defaultModels: [],
    description: "本机 vLLM OpenAI 兼容服务",
    roles: ["main"],
  },
  {
    id: "llamacpp",
    name: "llama.cpp server（本地）",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:8080/v1",
    supportsModelsEndpoint: true,
    auth: "none",
    defaultModels: [],
    description: "llama-server 的 OpenAI 兼容端点",
    roles: ["main"],
  },
  {
    id: "startlux-gateway",
    name: "本地决策网关（StartLux 4B / 2B）",
    protocol: "startlux-native",
    baseUrl: "https://edsionc.top/api/v1",
    supportsModelsEndpoint: true,
    auth: "bearer",
    defaultModels: ["startlux-decision-4b", "startlux-decision-2b", "gliner2.5-multi-decide", "laya-multilingual"],
    defaultModel: "startlux-decision-4b",
    description: "Vivic 模型网关；4B 必须走原生协议 {state, questions}",
    roles: ["decision"],
  },
  {
    id: "custom",
    name: "自定义（OpenAI 兼容）",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:8080/v1",
    supportsModelsEndpoint: true,
    auth: "bearer",
    defaultModels: [],
    description: "任意 OpenAI 兼容端点（vLLM / 自建网关 / 代理）",
    roles: ["main"],
  },
] as const;

export const findPreset = (id: string | undefined): ProviderPreset | undefined =>
  id ? PROVIDER_PRESETS.find((preset) => preset.id === id) : undefined;

const NON_CHAT = /(^|[-_/])(embed|embedding|rerank|bge|gte|m3e)([-_/]|$)/i;
const AUDIO = /(tts|asr|whisper|audio|speech|voice|sensevoice|cosyvoice|paraformer|vad|ocr)/i;

/**
 * Classify a model id so the UI can default to a chat model. Anything that is
 * neither an embedding nor an audio model is treated as chat: on an
 * OpenAI-compatible endpoint that is the overwhelmingly common case, and a
 * mis-typed "unknown" would leave the user without a default selection.
 */
export const classifyModel = (id: string): ModelKind => {
  if (AUDIO.test(id)) return "audio";
  if (NON_CHAT.test(id)) return "embedding";
  return "chat";
};

export const toModelInfo = (id: string): ModelInfo => ({ id, kind: classifyModel(id) });

/** Prefer a chat model, then the preset default, then the first id. */
export const pickDefaultModel = (models: readonly ModelInfo[], preferred?: readonly string[]): string | undefined => {
  for (const want of preferred ?? []) if (models.some((m) => m.id === want)) return want;
  const chat = models.find((m) => m.kind === "chat");
  return chat?.id ?? models[0]?.id;
};

/**
 * 4B and 2B speak different request shapes on the same endpoint. Mixing them
 * is the documented root cause of "本地模型连不上" (422 / 400), so refuse the
 * known-bad combination at configuration time instead of at request time.
 */
export const validateProtocolModel = (
  protocol: ProviderProtocol,
  model: string | undefined,
): { ok: true } | { ok: false; error: string } => {
  if (!model) return { ok: true };
  const is4b = /(^|[-_/])4b([-_/]|$)/i.test(model) || /startlux/i.test(model) && /4b/i.test(model);
  const is2b = /(^|[-_/])2b([-_/]|$)/i.test(model);
  if (is4b && protocol !== "startlux-native") {
    return { ok: false, error: "4B 模型只接受 StartLux 原生协议（{state, questions}）；旧版 {input, labels} 会返回 422。请把协议改为 startlux-native。" };
  }
  if (is2b && protocol === "startlux-native") {
    return { ok: false, error: "2B 模型不接受 StartLux 原生协议（会返回 400 Use 1–2000 characters of input）；请改用 legacy-2b 或 openai-compatible。" };
  }
  return { ok: true };
};

/** Mask a key for display: never return more than a short prefix/suffix hint. */
export const maskApiKey = (key: string): string => {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "••••";
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
};
