/**
 * Model-platform settings API client.
 *
 * All calls are same-origin through the Vite dev proxy, which injects the
 * session bearer server-side. API keys travel browser → loopback API only and
 * are never persisted client-side.
 */

import type {
  DraftProvider, ModelsResult, ProviderPreset, ProviderStatus, TestResult,
} from "./types";

const post = async <T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (!response.ok && (!parsed || typeof parsed !== "object")) {
    throw new Error(`请求失败（HTTP ${response.status}）`);
  }
  return parsed as T;
};

const del = async (url: string, signal?: AbortSignal): Promise<void> => {
  const response = await fetch(url, { method: "DELETE", signal });
  if (!response.ok) throw new Error(`删除失败（HTTP ${response.status}）`);
};

export const fetchPresets = async (signal?: AbortSignal): Promise<ProviderPreset[]> => {
  const response = await fetch("/api/providers/presets", { signal });
  if (!response.ok) throw new Error(`无法读取预设（HTTP ${response.status}）`);
  const body = await response.json() as { presets?: ProviderPreset[] };
  return body.presets ?? [];
};

export const fetchProviders = async (signal?: AbortSignal): Promise<ProviderStatus[]> => {
  const response = await fetch("/api/providers", { signal });
  if (!response.ok) throw new Error(`无法读取模型平台（HTTP ${response.status}）`);
  const body = await response.json() as { providers?: ProviderStatus[] };
  return body.providers ?? [];
};

export const createProvider = async (
  draft: DraftProvider,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string; provider?: ProviderStatus }> =>
  post("/api/providers", draft, signal);

export const updateProvider = async (
  id: string,
  updates: Partial<DraftProvider> & { clearApiKey?: boolean },
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string; provider?: ProviderStatus }> => {
  const response = await fetch(`/api/providers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updates),
    signal,
  });
  return (await response.json()) as { ok: boolean; error?: string; provider?: ProviderStatus };
};

export const deleteProvider = (id: string, signal?: AbortSignal): Promise<void> =>
  del(`/api/providers/${encodeURIComponent(id)}`, signal);

/** Live model discovery for an unsaved configuration. */
export const previewModels = (draft: DraftProvider, signal?: AbortSignal): Promise<ModelsResult> =>
  post("/api/providers/preview/models", draft, signal);

/** Real inference probe for an unsaved configuration. */
export const previewTest = (draft: DraftProvider, signal?: AbortSignal): Promise<TestResult> =>
  post("/api/providers/preview/test", draft, signal);

/** Live model discovery for a saved provider. */
export const fetchProviderModels = (id: string, signal?: AbortSignal): Promise<ModelsResult> =>
  post(`/api/providers/${encodeURIComponent(id)}/models`, {}, signal);

/** Real inference probe for a saved provider. */
export const testProvider = (id: string, signal?: AbortSignal): Promise<TestResult> =>
  post(`/api/providers/${encodeURIComponent(id)}/test`, {}, signal);
