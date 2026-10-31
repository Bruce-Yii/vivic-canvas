import { describe, expect, it } from "vitest";
import { decisionConnectionLabel, decisionModelNames, decisionModelProtocol, isDecisionModelConnected, type DecisionModelId, type DecisionConnectionStatus } from "./decisionModelStatus";

const connection = (model: DecisionModelId, configured = true, wireProtocol?: DecisionConnectionStatus["wireProtocol"]): DecisionConnectionStatus => ({
  configured, model, ...(wireProtocol ? { wireProtocol } : {}), executionEnabled: false, protocol: "classification-only", quality: "not-tested",
});

describe("decision model connection status", () => {
  it("does not mark the classifier connected when the platform key is absent", () => {
    expect(isDecisionModelConnected(false, connection("startlux-decision-2b"), "startlux-decision-2b")).toBe(false);
  });

  it("keeps the classifier disconnected until its own probe connection is established", () => {
    expect(isDecisionModelConnected(true, connection("startlux-decision-2b", false), "startlux-decision-2b")).toBe(false);
  });

  it("reports only the selected, connected model as ready", () => {
    expect(isDecisionModelConnected(true, connection("startlux-decision-2b"), "startlux-decision-2b")).toBe(true);
    expect(isDecisionModelConnected(true, connection("startlux-decision-2b"), "gliner2.5-multi-decide")).toBe(false);
  });

  it("shows a distinct, accurate status for each connection state", () => {
    expect(decisionConnectionLabel(null, null, "startlux-decision-2b")).toBe("连接状态待确认");
    expect(decisionConnectionLabel(false, null, "startlux-decision-2b")).toBe("请先连接平台 Key");
    expect(decisionConnectionLabel(true, connection("startlux-decision-2b", false), "startlux-decision-2b")).toBe("未连接");
    expect(decisionConnectionLabel(true, connection("startlux-decision-2b"), "gliner2.5-multi-decide")).toBe("已连接其他模型");
    expect(decisionConnectionLabel(true, connection("startlux-decision-2b"), "startlux-decision-2b")).toBe("已连接 · Startlux Decision 2B");
  });

  it("marks the 4B native connection by its display name, never the internal id", () => {
    const label = decisionConnectionLabel(true, connection("startlux-decision-4b", true, "native"), "startlux-decision-4b");
    expect(label).toBe("已连接 · StartLux Decision 4B（本地）");
    expect(label).not.toContain("startlux-decision-4b");
    expect(decisionConnectionLabel(true, connection("startlux-decision-4b", true, "native"), "startlux-decision-2b")).toBe("已连接其他模型");
  });

  it("keeps the protocol mapping fixed per model", () => {
    expect(decisionModelProtocol("startlux-decision-4b")).toBe("native");
    expect(decisionModelProtocol("startlux-decision-2b")).toBe("legacy");
    expect(decisionModelProtocol("gliner2.5-multi-decide")).toBe("legacy");
    expect(decisionModelNames["startlux-decision-4b"]).toBe("StartLux Decision 4B（本地）");
  });
});
