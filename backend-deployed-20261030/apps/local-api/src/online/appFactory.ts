import { createApp, type AppDeps } from "../app.js";
import {
  STEPFUN_PLAN_BASE_URL, INFERENCE_TIMEOUT_MS, CONNECTION_TIMEOUT_MS, SPEECH_TIMEOUT_MS,
} from "../config.js";
import type { LocalApiConfig } from "../config.js";
import type { PipelineDeps } from "../intent/pipeline.js";

/** Each cookie session owns only memory; no loadConfig, preferences or local OAuth. */
export function createOnlineSessionApp(
  session: { token: string; origin: string },
  overrides: { fetchImpl?: typeof fetch; router?: PipelineDeps["router"]; onDecisionTrace?: PipelineDeps["onDecisionTrace"]; onDecisionReceipt?: AppDeps["onDecisionReceipt"]; getEnabledDefinitions?: AppDeps["getEnabledDefinitions"] } = {},
) {
  const config: LocalApiConfig = {
    host: "127.0.0.1", port: 0, token: session.token,
    tokenPath: "", tokenGenerated: false, allowedOrigins: [session.origin],
    stepfunBaseUrl: STEPFUN_PLAN_BASE_URL,
    modelApiBaseUrl: (process.env.VIVIC_MODEL_API_BASE_URL ?? "https://edsionc.top/api/v1").replace(/\/+$/, ""),
    requestTimeoutMs: INFERENCE_TIMEOUT_MS, connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
    speechTimeoutMs: SPEECH_TIMEOUT_MS, asrTimeoutMs: 30_000,
    bodyLimitBytes: 64 * 1024, searchEnabled: true, publicDnsFallback: false,
    managedDecisionEnabled: false, decisionProviderEnabled: false,
    // Deployment-owned remote service only; no launcher/runtime or local config file.
    decisionV2Url: process.env.VIVIC_DECISION_V2_URL?.trim() || undefined,
    decisionV2Token: process.env.VIVIC_DECISION_V2_TOKEN || undefined,
    // Hosted classification wiring never opts the frozen native-v2 executor into production.
    decisionV2ExecutionEnabled: false,
  };
  const lifetime = new AbortController();
  const app = createApp({ config, mode: "online", fetchImpl: overrides.fetchImpl,
    router: overrides.router, onDecisionTrace: overrides.onDecisionTrace, onDecisionReceipt: overrides.onDecisionReceipt, getEnabledDefinitions: overrides.getEnabledDefinitions });
  return {
    fetch(request: Request) {
      if (lifetime.signal.aborted) return Response.json({ ok: false, error: "会话已结束。" }, { status: 410 });
      return app.fetch(new Request(request, { signal: AbortSignal.any([request.signal, lifetime.signal]) }));
    },
    dispose() { lifetime.abort(); app.dispose(); },
  };
}
