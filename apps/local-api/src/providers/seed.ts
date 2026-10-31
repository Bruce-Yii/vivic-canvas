import type { ProviderStore } from "./store.js";
import type { ProviderConfig } from "./types.js";

/**
 * Deployment-level StepFun seed.
 *
 * The online product must work without anyone opening the provider settings:
 * the operator injects a plaintext key through the process environment and the
 * app turns it into a normal "main" provider on boot. The key is only read from
 * env (never from a file, CLI argument or response), handed straight to the
 * store for AES-GCM encryption, and never logged. Settings stay authoritative
 * afterwards: an existing main provider is never overwritten, so deleting the
 * seed row or the env var rolls this back.
 */

export const STEPFUN_SEED_NAME = "StepFun (seed)";
export const STEPFUN_SEED_DEFAULT_BASE_URL = "https://api.stepfun.com/v1";
export const STEPFUN_SEED_DEFAULT_MODEL = "step-3.5-flash";

export interface StepFunSeedEnv {
  VIVIC_STEPFUN_API_KEY?: string;
  VIVIC_STEPFUN_BASE_URL?: string;
  VIVIC_STEPFUN_MODEL?: string;
}

export interface StepFunSeedValues {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Read the seed values; absent/blank key means "do not seed". */
export const stepFunSeedFromEnv = (env: StepFunSeedEnv): StepFunSeedValues | undefined => {
  const apiKey = env.VIVIC_STEPFUN_API_KEY?.trim();
  if (!apiKey) return undefined;
  return {
    apiKey,
    baseUrl: env.VIVIC_STEPFUN_BASE_URL?.trim() || STEPFUN_SEED_DEFAULT_BASE_URL,
    model: env.VIVIC_STEPFUN_MODEL?.trim() || STEPFUN_SEED_DEFAULT_MODEL,
  };
};

/**
 * Create the seed provider exactly once. Any existing main-role provider
 * (enabled or disabled) wins, and a invalid env value must not take the
 * server down: it is reported by code only, without echoing the key.
 */
export const seedStepFunProvider = (
  store: ProviderStore,
  env: StepFunSeedEnv = process.env,
): ProviderConfig | undefined => {
  const seed = stepFunSeedFromEnv(env);
  if (!seed) return undefined;
  if (store.list().some((provider) => provider.roles.includes("main"))) return undefined;
  try {
    return store.create({
      name: STEPFUN_SEED_NAME,
      protocol: "stepfun-v1",
      baseUrl: seed.baseUrl,
      apiKey: seed.apiKey,
      model: seed.model,
      roles: ["main"],
    });
  } catch (error) {
    console.warn(JSON.stringify({
      event: "provider.seed_invalid",
      reason: error instanceof Error ? error.message : "unknown",
    }));
    return undefined;
  }
};
