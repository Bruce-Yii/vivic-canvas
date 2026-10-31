/**
 * Model-platform settings types.
 *
 * The backend owns the preset catalogue (GET /api/providers/presets); these
 * types mirror its wire shapes and keep a small offline fallback so the panel
 * still renders when the local API is unreachable.
 */

export type ProviderProtocol =
  | "openai-compatible"
  | "stepfun-v1"
  | "stepfun-plan"
  | "startlux-native"
  | "legacy-2b";

export type ProviderRole = "main" | "decision" | "asr" | "tts" | "embedding";

export type ProviderErrorType =
  | "timeout" | "network" | "auth" | "not-found"
  | "protocol" | "unsupported" | "invalid-response" | "unknown";

export type ModelKind = "chat" | "embedding" | "audio" | "unknown";

export interface ModelInfo {
  id: string;
  kind: ModelKind;
}

export interface ProviderPreset {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  supportsModelsEndpoint: boolean;
  defaultModels: string[];
  defaultModel?: string;
  auth: "bearer" | "api-key-header" | "none";
  description?: string;
  roles?: ProviderRole[];
}

export interface ProviderStatus {
  id: string;
  name: string;
  kind: "preset" | "custom";
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
  connected: boolean;
  latencyMs?: number;
  lastCheckedAt?: string;
  lastError?: string;
  errorType?: ProviderErrorType;
}

export interface DraftProvider {
  presetId?: string;
  name?: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  roles?: ProviderRole[];
}

export interface TestResult {
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
  fallback?: boolean;
  note?: string;
  error?: string;
  errorType?: ProviderErrorType;
}

/** Shown only when the preset catalogue cannot be fetched from the backend. */
export const FALLBACK_PRESETS: readonly ProviderPreset[] = [
  { id: "stepfun-v1", name: "StepFun API（普通 /v1）", protocol: "stepfun-v1",
    baseUrl: "https://api.stepfun.com/v1", supportsModelsEndpoint: true, auth: "bearer",
    defaultModels: ["step-3.5-flash", "step-3.7-flash"], defaultModel: "step-3.5-flash" },
  { id: "stepfun-plan", name: "StepFun Plan（/step_plan/v1）", protocol: "stepfun-plan",
    baseUrl: "https://api.stepfun.com/step_plan/v1", supportsModelsEndpoint: true, auth: "bearer",
    defaultModels: ["step-3.5-flash"], defaultModel: "step-3.5-flash" },
  { id: "deepseek", name: "DeepSeek 官方", protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com", supportsModelsEndpoint: true, auth: "bearer",
    defaultModels: ["deepseek-flash", "deepseek-chat"], defaultModel: "deepseek-flash" },
  { id: "openai", name: "OpenAI", protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1", supportsModelsEndpoint: true, auth: "bearer",
    defaultModels: ["gpt-4o-mini"], defaultModel: "gpt-4o-mini" },
  { id: "ollama", name: "Ollama（本地）", protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1", supportsModelsEndpoint: true, auth: "none", defaultModels: [] },
  { id: "custom", name: "自定义（OpenAI 兼容）", protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:8080/v1", supportsModelsEndpoint: true, auth: "bearer", defaultModels: [] },
] as const;

export const ERROR_TYPE_LABEL: Record<ProviderErrorType, string> = {
  timeout: "超时",
  network: "网络不可达",
  auth: "鉴权失败",
  "not-found": "端点不存在",
  protocol: "协议不匹配",
  unsupported: "平台不支持",
  "invalid-response": "响应格式异常",
  unknown: "未知错误",
};

export const ROLE_LABEL: Record<ProviderRole, string> = {
  main: "主模型",
  decision: "决策模型",
  asr: "语音识别",
  tts: "语音合成",
  embedding: "向量模型",
};

/** Filter a model list by a case-insensitive substring of the id. */
export const filterModels = (models: readonly ModelInfo[], query: string): ModelInfo[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...models];
  return models.filter((model) => model.id.toLowerCase().includes(needle));
};

/** A chat model is the only sensible default for generation roles. */
export const pickDefaultChatModel = (models: readonly ModelInfo[]): string | undefined =>
  models.find((model) => model.kind === "chat")?.id ?? models[0]?.id;
