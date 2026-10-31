import { DEFAULT_DEEPSEEK_MODEL, type MainProvider } from "../config.js";
import type { StepfunCredential } from "../credentials.js";
import type { StepfunDeps } from "../stepfun.js";
import type { ProviderStore } from "./store.js";
import { PROVIDER_PRESETS, type ProviderConfig } from "./types.js";

/**
 * The main planner transport is selected by the provider store, not by the
 * legacy StepFun slot. This module keeps that mapping in one place so the
 * status endpoint, image gate and intent pipeline can never disagree about
 * which endpoint/key/model a request actually uses.
 */

export type MainSlot = "stepfun" | "deepseek";
export type MainProviderSource = "settings" | "env" | "legacy";

export interface ResolvedMainProvider {
  /** Where the selection came from: a saved provider, the env switch, or the legacy StepFun store. */
  source: MainProviderSource;
  /** Legacy status slot name (`/api/providers/status` and old clients). */
  slot: MainSlot;
  /** Planner label carried into the pipeline, trace and `usedProvider`. */
  provider: MainProvider;
  /** Planner-only transport. Speech/ASR/readers keep their own StepFun deps. */
  transport: StepfunDeps;
  /** Exact key/model the pipeline must use when settings selected the provider. */
  credential?: StepfunCredential;
  model?: string;
  /** The saved provider, when settings supplied one. */
  saved?: ProviderConfig;
}

const trimBase = (baseUrl: string): string => baseUrl.replace(/\/+$/, "");

/** A preset id or an official DeepSeek host; a custom name alone is not enough. */
export const isDeepSeekProvider = (provider: Pick<ProviderConfig, "presetId" | "baseUrl">): boolean => {
  if (provider.presetId === "deepseek") return true;
  try {
    const host = new URL(provider.baseUrl).hostname.toLowerCase();
    return host === "deepseek.com" || host.endsWith(".deepseek.com");
  } catch {
    return false;
  }
};

/** Provider row model, preset default, then the official DeepSeek default. */
export const mainModelFor = (provider: Pick<ProviderConfig, "model" | "presetId" | "baseUrl">): string | undefined => {
  if (provider.model) return provider.model;
  const preset = PROVIDER_PRESETS.find(entry => entry.id === provider.presetId);
  if (preset?.defaultModel) return preset.defaultModel;
  return isDeepSeekProvider(provider) ? DEFAULT_DEEPSEEK_MODEL : undefined;
};

/**
 * Resolve the enabled main-role provider from settings. The returned transport
 * always uses that provider's own base URL and key; it never falls back to the
 * StepFun slot. A missing key/model is reported as a missing credential so the
 * caller can answer honestly instead of silently going offline or StepFun.
 */
export const resolveSavedMain = (
  store: ProviderStore,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => string } = {},
): ResolvedMainProvider | undefined => {
  const saved = store.findForRole("main");
  if (!saved) return undefined;
  const model = mainModelFor(saved);
  const apiKey = store.getApiKey(saved.id)?.trim();
  const credential: StepfunCredential | undefined = apiKey && model
    ? { apiKey, models: [model], defaultModel: model, checkedAt: options.now?.() ?? new Date().toISOString() }
    : undefined;
  const deepseek = isDeepSeekProvider(saved);
  return {
    source: "settings",
    slot: deepseek ? "deepseek" : "stepfun",
    provider: deepseek ? "deepseek" : "stepfun",
    transport: {
      baseUrl: trimBase(saved.baseUrl),
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      // Only the official DeepSeek body disables thinking; another
      // OpenAI-compatible endpoint keeps the neutral request body.
      ...(deepseek ? { provider: "deepseek" as const } : {}),
    },
    credential,
    model,
    saved,
  };
};
