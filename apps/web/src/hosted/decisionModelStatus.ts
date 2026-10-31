export type DecisionModelId = "startlux-decision-2b" | "startlux-decision-4b" | "gliner2.5-multi-decide";
export type DecisionWireProtocol = "legacy" | "native";

/** User-facing names only: the internal provider ids never reach the UI as visible text. */
export const decisionModelNames: Record<DecisionModelId, string> = {
  "startlux-decision-2b": "Startlux Decision 2B",
  "startlux-decision-4b": "StartLux Decision 4B（本地）",
  "gliner2.5-multi-decide": "GLiNER 2.5 Multi Decide",
};

/** 4B speaks the native state/questions protocol; 2B and GLiNER keep legacy input/labels. */
export const decisionModelProtocol = (model: DecisionModelId): DecisionWireProtocol =>
  model === "startlux-decision-4b" ? "native" : "legacy";

export interface DecisionConnectionStatus {
  configured: boolean;
  model: DecisionModelId | null;
  /** Reported by the hosted service; "native" identifies the StartLux 4B wire protocol. */
  wireProtocol?: DecisionWireProtocol | null;
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
  // Trust the reported wire protocol over the selected id when the service says native.
  const connected = connection?.wireProtocol === "native" ? "startlux-decision-4b" : selectedModel;
  return `已连接 · ${decisionModelNames[connected]}`;
}
