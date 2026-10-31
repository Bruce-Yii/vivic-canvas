/**
 * Model platform settings API client.
 * Calls existing backend endpoints for platform validation and model discovery.
 */

import type { ModelInfo, PlatformStatus } from "./types";

export interface ValidatePlatformResult {
  ok: boolean;
  connected: boolean;
  error?: string;
}

export interface GetModelsResult {
  ok: boolean;
  models?: ModelInfo[];
  error?: string;
}

/**
 * Validate platform API key and test connectivity.
 * Uses existing POST /api/credentials/platform/validate endpoint.
 */
export const validatePlatformConnection = async (
  apiKey: string,
  signal?: AbortSignal,
): Promise<ValidatePlatformResult> => {
  try {
    const res = await fetch("/api/credentials/platform/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
      signal,
    });
    const data = await res.json();
    return data as ValidatePlatformResult;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, connected: false, error: "请求已取消" };
    }
    return {
      ok: false,
      connected: false,
      error: "连接失败：无法访问本地服务",
    };
  }
};

/**
 * Disconnect platform API key.
 * Uses existing POST /api/credentials/platform/disconnect endpoint.
 */
export const disconnectPlatform = async (
  signal?: AbortSignal,
): Promise<{ ok: boolean; connected: boolean }> => {
  try {
    const res = await fetch("/api/credentials/platform/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal,
    });
    return (await res.json()) as { ok: boolean; connected: boolean };
  } catch {
    return { ok: false, connected: false };
  }
};

/**
 * Get current platform status including connection state and available models.
 * Reads from existing GET /api/providers/status endpoint.
 */
export const getPlatformStatus = async (
  signal?: AbortSignal,
): Promise<PlatformStatus> => {
  try {
    const res = await fetch("/api/providers/status", { signal });
    if (!res.ok) {
      return { connected: false, lastError: "服务不可用" };
    }
    const data = await res.json();
    return {
      connected: data.platform?.connected ?? false,
      lastError: data.platform?.lastError,
    };
  } catch {
    return { connected: false, lastError: "无法连接到本地服务" };
  }
};

/**
 * Fetch available models from the configured platform.
 * This would typically call GET /models on the user's platform,
 * but the current backend validates connectivity through /api/credentials/platform/validate.
 * 
 * For now, returns empty list. Future enhancement: expose platform's /models through local-api proxy.
 */
export const getAvailableModels = async (
  signal?: AbortSignal,
): Promise<GetModelsResult> => {
  // TODO: Backend needs to expose platform's GET /models through a proxy endpoint
  // Current implementation: platform validation happens at connection time
  return {
    ok: true,
    models: [],
  };
};
