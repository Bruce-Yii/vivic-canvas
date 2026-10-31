/**
 * Model platform settings UI types.
 * Independent component for configuring user's own model API provider.
 */

export interface ModelPlatformPreset {
  id: string;
  name: string;
  baseUrl: string;
  description?: string;
}

export interface ModelPlatformConfig {
  preset?: string;
  customName?: string;
  baseUrl: string;
  apiKey: string;
}

export interface ModelInfo {
  id: string;
}

export interface PlatformStatus {
  connected: boolean;
  lastError?: string;
  models?: ModelInfo[];
  baseUrl?: string;
}

export const MODEL_PLATFORM_PRESETS: readonly ModelPlatformPreset[] = [
  {
    id: "custom",
    name: "自定义平台",
    baseUrl: "",
    description: "配置你自己的模型 API 平台地址",
  },
  {
    id: "local",
    name: "本地 API",
    baseUrl: "http://127.0.0.1:8080/v1",
    description: "本机运行的模型服务",
  },
] as const;
