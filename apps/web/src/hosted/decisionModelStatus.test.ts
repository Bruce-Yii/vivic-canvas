import { describe, expect, it } from "vitest";
import { decisionConnectionLabel, isDecisionModelConnected, type DecisionModelId, type DecisionConnectionStatus } from "./decisionModelStatus";

const connection = (model: DecisionModelId, configured = true): DecisionConnectionStatus => ({
  configured, model, executionEnabled: false, protocol: "classification-only", quality: "not-tested",
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
});
