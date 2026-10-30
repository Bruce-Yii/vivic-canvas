import type { IntentResult } from "../intent/pipeline.js";

export function redactDecisionText(value: string): string {
  return value.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|vvc_[A-Za-z0-9_-]{12,})\b/g, "[redacted]")
    .replace(/((?:password|passwd|secret|api.?key|token|密码|密钥)\s*[:=：]\s*)[^\s，,；;]+/gi, "$1[redacted]")
    .slice(0, 500);
}

export function decisionOutcome(result: IntentResult): string {
  if (result.kind === "clarify" || result.task?.status === "awaiting_clarification") return "clarify";
  if (result.kind === "error" || result.kind === "unknown" || result.task?.status === "failed") return "error";
  // Browser execution/commit is a later operation, not a confirmed server mutation.
  return result.envelope || result.hostOperation ? "proposed" : "succeeded";
}
