/** Metadata only: never accept prompt text, URLs, headers, credentials or exceptions. */
export interface DiagnosticEvent {
  event: "request.complete" | "request.error" | "intent.stage" | "decision.configuration_invalid";
  requestId?: string;
  route?: string;
  method?: string;
  status?: number;
  stage?: string;
  state?: "started" | "completed" | "failed";
  elapsedMs?: number;
}
export type DiagnosticSink = (event: DiagnosticEvent) => void;
export const writeDiagnostic: DiagnosticSink = event => {
  console.info(JSON.stringify({ timestamp: new Date().toISOString(), ...event }));
};
export const safeDiagnostic = (sink: DiagnosticSink | undefined, event: DiagnosticEvent): void => {
  try { sink?.(event); } catch { /* Observability cannot interrupt user requests. */ }
};
