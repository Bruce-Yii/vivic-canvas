import { describe, expect, it } from "vitest";
import { canPublishTaskFeedback, canPreviewLocalChoice, canReuseLegacyLocalChoice } from "./legacyChoicePolicy";

describe("server clarification ownership", () => {
  it("keeps frozen server candidate questions and deletion confirmation on their task", () => {
    expect(canReuseLegacyLocalChoice({ kind: "clarify", task: { decision: "legacy-fallback", status: "awaiting_clarification" } }, "delete")).toBe(false);
    expect(canReuseLegacyLocalChoice({ kind: "clarify", task: { decision: "legacy-fallback", status: "awaiting_clarification" } }, "focus")).toBe(false);
  });
  it("never turns a rejected deletion into a local deletion picker", () => {
    for (const kind of ["unknown", "error"]) expect(canReuseLegacyLocalChoice({ kind, task: { decision: "legacy-fallback", status: "failed" } }, "delete")).toBe(false);
  });
  it("retains the non-destructive local target chooser for an explicit legacy miss", () => {
    expect(canReuseLegacyLocalChoice({ kind: "unknown", task: { decision: "legacy-fallback", status: "failed" } }, "focus")).toBe(true);
    expect(canReuseLegacyLocalChoice({ kind: "error", task: { decision: "legacy-fallback", status: "failed" } }, "highlight")).toBe(true);
  });
  it("does not reinterpret handled native tasks or already executed results", () => {
    expect(canReuseLegacyLocalChoice({ kind: "unknown", task: { decision: "native-v2", status: "failed" } }, "focus")).toBe(false);
    expect(canReuseLegacyLocalChoice({ kind: "error", executed: true, task: { decision: "legacy-fallback" } }, "focus")).toBe(false);
  });
  it("does not mutate the frozen version just to publish a server question", () => {
    expect(canPublishTaskFeedback({ kind: "clarify", task: { status: "awaiting_clarification" } })).toBe(false);
    expect(canPublishTaskFeedback({ kind: "envelope", task: { status: "completed" } })).toBe(true);
  });
  it("does not preview-highlight a server-owned target before the confirmation reply", () => {
    expect(canPreviewLocalChoice({ taskId: "server-question" })).toBe(false);
    expect(canPreviewLocalChoice({})).toBe(true);
  });
});
