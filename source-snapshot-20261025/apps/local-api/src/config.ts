import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const STEPFUN_PLAN_BASE_URL = "https://api.stepfun.com/step_plan/v1";
export const INFERENCE_TIMEOUT_MS = 60_000;
export const CONNECTION_TIMEOUT_MS = 30_000;
export const SPEECH_TIMEOUT_MS = 15_000;
export const INTENT_BUDGET_MS = 90_000;

/** Invalid overrides fall back; no individual request may exceed a turn. */
export const boundedTimeout = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.min(Math.floor(parsed), INTENT_BUDGET_MS) : fallback;
};

/**
 * Local session auth: a random bearer token lives ONLY in
 * apps/local-api/.env.local (gitignored, mode 0600). The Vite dev proxy reads
 * the same file and injects the header server-side, so the browser bundle
 * never sees it. Regenerate by deleting the file.
 */

export interface LocalApiConfig {
  port: number;
  host: "127.0.0.1";
  token: string;
  tokenPath: string;
  tokenGenerated: boolean;
  allowedOrigins: string[];
  stepfunBaseUrl: string;
  requestTimeoutMs: number;
  connectionTimeoutMs?: number;
  speechTimeoutMs?: number;
  asrTimeoutMs?: number;
  searchEnabled?: boolean;
  publicDnsFallback?: boolean;
  /** Keyless search egress: `auto` (env > OS proxy), `direct`, or a proxy URL. Unset = direct. */
  searchProxy?: string;
  /** Optional independent DEC-01 provider; unset preserves Kev-only behavior. */
  decisionProviderUrl?: string;
  decisionProviderFallbackUrl?: string;
  decisionProviderKind?: "api" | "local";
  decisionProviderEnabled?: boolean;
  decisionProviderTimeoutMs?: number;
  decisionProviderProtocol?: "adapter" | "local-chat" | "startlux";
  decisionProviderModel?: string;
  decisionProviderToken?: string;
  /** Independent native multi-stage protocol. Never fed through the seven-label adapter. */
  decisionV2Url?: string;
  decisionV2Token?: string;
  decisionV2ExecutionEnabled?: boolean;
  decisionV2TimeoutMs?: number;
  bodyLimitBytes: number;
  managedDecisionEnabled?: boolean;
  managedDecisionRoot?: string;
}

const ENV_FILE = ".env.local";

const readEnvFile = (dir: string): Record<string, string> => {
  const file = path.join(dir, ENV_FILE);
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
};

export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  dir: string = path.resolve(import.meta.dirname, ".."),
): LocalApiConfig => {
  const fileVars = readEnvFile(dir);
  let token = env.VIVIC_LOCAL_TOKEN ?? fileVars.VIVIC_LOCAL_TOKEN;
  let generated = false;
  if (!token) {
    token = `vivic_${randomBytes(24).toString("hex")}`;
    generated = true;
    const target = path.join(dir, ENV_FILE);
    const line = `VIVIC_LOCAL_TOKEN=${token}\n`;
    const existing = fs.existsSync(target)
      ? fs.readFileSync(target, "utf8")
      : "# Vivic local-api session token (gitignored; delete to rotate)\n";
    fs.writeFileSync(target, existing + line, { mode: 0o600 });
  }
  return {
    publicDnsFallback: env.VIVIC_PUBLIC_DNS_FALLBACK !== "0",
    port: Number(env.PORT ?? 8787),
    managedDecisionEnabled: env.VIVIC_MANAGED_DECISION !== "off" && (process.platform === "win32" && process.arch === "x64" || process.platform === "darwin" && ["arm64", "x64"].includes(process.arch)),
    managedDecisionRoot: env.VIVIC_RUNTIME_ROOT?.trim() || undefined,
    host: "127.0.0.1",
    token,
    tokenPath: path.join(dir, ENV_FILE),
    tokenGenerated: generated,
    allowedOrigins: (env.VIVIC_ALLOWED_ORIGINS ??
      `http://localhost:5175,http://127.0.0.1:5175,http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174,http://localhost:${Number(env.PORT ?? 8787)},http://127.0.0.1:${Number(env.PORT ?? 8787)}`)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    stepfunBaseUrl: (env.STEPFUN_BASE_URL ?? STEPFUN_PLAN_BASE_URL).replace(/\/+$/, ""),
    requestTimeoutMs: boundedTimeout(env.VIVIC_REQUEST_TIMEOUT_MS, INFERENCE_TIMEOUT_MS),
    connectionTimeoutMs: boundedTimeout(env.VIVIC_CONNECTION_TIMEOUT_MS, CONNECTION_TIMEOUT_MS),
    speechTimeoutMs: boundedTimeout(env.VIVIC_SPEECH_TIMEOUT_MS, SPEECH_TIMEOUT_MS),
    asrTimeoutMs: boundedTimeout(env.VIVIC_ASR_TIMEOUT_MS, 30000),
    searchEnabled: env.VIVIC_SEARCH_ENABLED !== "false",
    searchProxy: env.VIVIC_SEARCH_PROXY?.trim() || "auto",
    decisionProviderUrl: env.VIVIC_DECISION_PROVIDER_URL?.trim() || undefined,
    decisionProviderFallbackUrl: env.VIVIC_DECISION_PROVIDER_FALLBACK_URL?.trim() || undefined,
    decisionProviderKind: env.VIVIC_DECISION_PROVIDER_KIND === "local" ? "local" : "api",
    decisionProviderEnabled: env.VIVIC_DECISION_PROVIDER_ENABLED !== "false",
    decisionProviderTimeoutMs: boundedTimeout(env.VIVIC_DECISION_PROVIDER_TIMEOUT_MS, 2000),
    decisionProviderProtocol: env.VIVIC_DECISION_PROVIDER_PROTOCOL === "startlux" ? "startlux" : env.VIVIC_DECISION_PROVIDER_PROTOCOL === "local-chat" ? "local-chat" : "adapter",
    decisionProviderModel: env.VIVIC_DECISION_PROVIDER_MODEL?.trim() || undefined,
    decisionProviderToken: env.VIVIC_DECISION_PROVIDER_TOKEN || undefined,
    decisionV2Url: env.VIVIC_DECISION_V2_URL?.trim() || undefined,
    decisionV2Token: env.VIVIC_DECISION_V2_TOKEN || undefined,
    decisionV2ExecutionEnabled: env.VIVIC_DECISION_V2_EXECUTION_ENABLED === "true",
    decisionV2TimeoutMs: boundedTimeout(env.VIVIC_DECISION_V2_TIMEOUT_MS, 10_000),
    bodyLimitBytes: 64 * 1024,
  };
};
