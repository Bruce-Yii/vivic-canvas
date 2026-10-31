import { describe, expect, it } from "vitest";
import { SCENE_IDS } from "@vivic/contracts";
import { GOLDEN_CASES } from "../evals/golden.js";
import { evaluateIntents } from "../evals/run.js";
describe("Chinese intent golden set", () => {
  it("covers every scene, unique realistic utterances and missing-fact rejection", () => {
    expect(GOLDEN_CASES.length).toBeGreaterThanOrEqual(100);
    expect(new Set(GOLDEN_CASES.map(item => item.id)).size).toBe(GOLDEN_CASES.length);
    expect(new Set(GOLDEN_CASES.map(item => item.input)).size).toBe(GOLDEN_CASES.length);
    expect(new Set(GOLDEN_CASES.map(item => item.scene))).toEqual(new Set(SCENE_IDS));
    expect(GOLDEN_CASES.filter(item => item.expect === "clarify").length).toBeGreaterThanOrEqual(10);
  });
  it("replays expected extraction through the real contracts, grounding and deterministic builders", async () => {
    const report = await evaluateIntents();
    expect(report.failedIds).toEqual([]);
    expect(report.passed).toBe(GOLDEN_CASES.length);
    expect(report.mode).toBe("offline-expected-payload-replay");
    expect(report.systemPromptCharacters).toBeLessThan(10000);
  });
});
