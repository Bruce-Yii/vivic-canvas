export type DecisionModelId = "startlux-decision-2b" | "gliner2.5-multi-decide";

export interface DecisionConnectionStatus {
  configured: boolean;
  model: DecisionModelId | null;
  connectedAt?: string | null;
  executionEnabled: false;
  protocol: "classification-only";
  quality: "not-tested";
}

export type DecisionConnectionState = "unknown" | "platform-disconnected" | "disconnected" | "connected" | "different-model";

export function decisionConnectionState(
  platformConfigured: boolean | null | undefined,
  connection: DecisionConnectionStatus | null | undefined,
  selectedModel: DecisionModelId,
): DecisionConnectionState {
  if (platformConfigured === null || platformConfigured === undefined) return "unknown";
  if (!platformConfigured) return "platform-disconnected";
  if (!connection?.configured || !connection.model) return "disconnected";
  return connection.model === selectedModel ? "connected" : "different-model";
}

export function isDecisionModelConnected(
  platformConfigured: boolean | null | undefined,
  connection: DecisionConnectionStatus | null | undefined,
  selectedModel: DecisionModelId,
): boolean {
  return decisionConnectionState(platformConfigured, connection, selectedModel) === "connected";
}

export function decisionConnectionLabel(
  platformConfigured: boolean | null | undefined,
  connection: DecisionConnectionStatus | null | undefined,
  selectedModel: DecisionModelId,
): string {
  const state = decisionConnectionState(platformConfigured, connection, selectedModel);
  if (state === "unknown") return "连接状态待确认";
  if (state === "platform-disconnected") return "请先连接平台 Key";
  if (state === "disconnected") return "未连接";
  if (state === "different-model") return "已连接其他模型";
  return `已连接 · ${selectedModel === "startlux-decision-2b" ? "Startlux Decision 2B" : "GLiNER 2.5 Multi Decide"}`;
}
