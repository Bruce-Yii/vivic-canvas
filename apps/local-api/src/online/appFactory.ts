import { createApp, type AppDeps } from "../app.js";
import {
  STEPFUN_PLAN_BASE_URL, INFERENCE_TIMEOUT_MS, CONNECTION_TIMEOUT_MS, SPEECH_TIMEOUT_MS, streamFeedbackEnabled,
  providerDataDirFromEnv, providerPersistEnabled,
} from "../config.js";
import type { LocalApiConfig } from "../config.js";
import type { PipelineDeps } from "../intent/pipeline.js";

/**
 * Each cookie session owns its in-memory credentials; no loadConfig,
 * preferences, local OAuth or runtime. Provider settings are the one explicit
 * exception: when the deployment supplies a data directory they persist there
 * so a saved/seed provider survives session turnover.
 */
export function createOnlineSessionApp(
  session: { token: string; origin: string },
  overrides: {
    fetchImpl?: typeof fetch; router?: PipelineDeps["router"]; onDecisionTrace?: PipelineDeps["onDecisionTrace"];
    onDecisionReceipt?: AppDeps["onDecisionReceipt"]; getEnabledDefinitions?: AppDeps["getEnabledDefinitions"];
    /** Deployment data dir; the hosted service passes its own persistent root. */
    providerDataDir?: string;
    providerPersist?: boolean;
    providerSeed?: boolean;
  } = {},
) {
  const config: LocalApiConfig = {
    host: "127.0.0.1", port: 0, token: session.token,
    tokenPath: "", tokenGenerated: false, allowedOrigins: [session.origin],
    stepfunBaseUrl: STEPFUN_PLAN_BASE_URL,
    modelApiBaseUrl: (process.env.VIVIC_MODEL_API_BASE_URL ?? "https://edsionc.top/api/v1").replace(/\/+$/, ""),
    requestTimeoutMs: INFERENCE_TIMEOUT_MS, connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
    speechTimeoutMs: SPEECH_TIMEOUT_MS, asrTimeoutMs: 30_000,
    bodyLimitBytes: 64 * 1024, searchEnabled: true, publicDnsFallback: false,
    // Deployment switch: unset keeps today's SSE first sentence; `off` rolls it back.
    streamFeedback: streamFeedbackEnabled(process.env.VIVIC_STREAM_FEEDBACK),
    managedDecisionEnabled: false, decisionProviderEnabled: false,
    // Deployment-owned remote service only; no launcher/runtime or local config file.
    decisionV2Url: process.env.VIVIC_DECISION_V2_URL?.trim() || undefined,
    decisionV2Token: process.env.VIVIC_DECISION_V2_TOKEN || undefined,
    // Hosted classification wiring never opts the frozen native-v2 executor into production.
    decisionV2ExecutionEnabled: false,
  };
  const lifetime = new AbortController();
  // Persist provider settings only when the deployment has a durable data
  // directory. Without one, an online app stays memory-only so a test or a
  // stray caller can never read/write the operator's ~/.vivic. The hosted
  // service always passes its VIVIC_SPACE_DATA_DIR root.
  const providerDataDir = overrides.providerDataDir ?? providerDataDirFromEnv();
  const app = createApp({ config, mode: "online", fetchImpl: overrides.fetchImpl, providerSeed: overrides.providerSeed,
    router: overrides.router, onDecisionTrace: overrides.onDecisionTrace, onDecisionReceipt: overrides.onDecisionReceipt, getEnabledDefinitions: overrides.getEnabledDefinitions,
    ...(providerDataDir ? {
      providerDataDir,
      providerPersist: overrides.providerPersist ?? providerPersistEnabled(process.env.VIVIC_PROVIDER_PERSIST),
    } : {}) });
  return {
    fetch(request: Request) {
      if (lifetime.signal.aborted) return Response.json({ ok: false, error: "会话已结束。" }, { status: 410 });
      return app.fetch(new Request(request, { signal: AbortSignal.any([request.signal, lifetime.signal]) }));
    },
    dispose() { lifetime.abort(); app.dispose(); },
  };
}
