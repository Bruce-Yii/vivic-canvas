import { describe, expect, it } from "vitest";
import type { CardRecord } from "@/contracts";
import { emptyVivicState } from "@/persistence/canvasRecord";
import type { VivicState } from "@/state/canvasStore";
import { parseCommand, type CommandContext } from "../parse";

/**
 * Phase 2a.1 (FIX B): approximate duration references.
 *  左右/大约/约/大概 => ±2 min (N<30) / ±3 min (N>=30);
 *  match by remaining minutes (preferred) OR original programmed length.
 */
const fixedNow = "2026-10-15T08:00:00.000Z";
const NOW = Date.parse(fixedNow);

const countdown = (
  id: string,
  originalMin: number,
  elapsedMin: number,
): CardRecord => ({
  id,
  type: "CountdownCard",
  variant: "minimal",
  displayProps: {},
  sourceData: {
    targetAt: new Date(NOW + (originalMin - elapsedMin) * 60_000).toISOString(),
    startedAt: new Date(NOW - elapsedMin * 60_000).toISOString(),
  },
  sources: [],
  layout: { x: 0, y: 0, width: 264, height: 96, pinned: false },
  metadata: { createdAt: fixedNow, updatedAt: fixedNow },
});

const ctxOf = (...cards: CardRecord[]): CommandContext => {
  const state: VivicState = {
    ...emptyVivicState(),
    stage: "WORKSPACE",
    cards: cards.map((record) => ({ record })),
  };
  return { state, canvasId: "c1", now: () => NOW };
};

describe("approximate duration references", () => {
  it("删除8分钟左右的倒计时 hits a 10-min countdown with 2 min elapsed (remaining 8)", () => {
    const result = parseCommand(
      "删除8分钟左右的倒计时",
      ctxOf(countdown("cd-a", 10, 2), countdown("cd-far", 40, 0)),
    );
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions).toContainEqual({
      type: "card.delete",
      targetId: "cd-a",
    });
  });

  it("falls back to original length when remaining finds nothing", () => {
    // cd-b: original 8 min, remaining 4 (4 min elapsed) — remaining is NOT ~8.
    const result = parseCommand(
      "删除8分钟左右的倒计时",
      ctxOf(countdown("cd-b", 8, 4), countdown("cd-far", 60, 1)),
    );
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions).toContainEqual({
      type: "card.delete",
      targetId: "cd-b",
    });
  });

  it("~8 remaining AND ~8 original within ±2 => clarification, not a blind delete", () => {
    const result = parseCommand(
      "删除8分钟左右的倒计时",
      ctxOf(countdown("cd-rem-8", 10, 2), countdown("cd-orig-8", 8, 1)),
    );
    expect(result.kind).toBe("clarify");
    if (result.kind !== "clarify") return;
    expect(result.candidates.map((c) => c.card.id).sort()).toEqual([
      "cd-orig-8",
      "cd-rem-8",
    ]);
  });

  it("focus works with approximate durations too", () => {
    const result = parseCommand(
      "放大大约8分钟的倒计时",
      ctxOf(countdown("cd-a", 10, 2), countdown("cd-far", 40, 0)),
    );
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions).toContainEqual({
      type: "card.focus",
      targetId: "cd-a",
    });
  });

  it("N>=30 widens tolerance to ±3 for 大概", () => {
    const result = parseCommand(
      "删除大概30分钟的倒计时",
      ctxOf(countdown("cd-33", 33, 0), countdown("cd-8", 8, 0)),
    );
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions).toContainEqual({
      type: "card.delete",
      targetId: "cd-33",
    });
  });

  it("exact phrasing stays strict (±1): 8分钟 does NOT match remaining 10", () => {
    const result = parseCommand(
      "删除8分钟的倒计时",
      ctxOf(countdown("cd-10", 10, 0), countdown("cd-8", 8, 2)),
    );
    // remaining 6 vs 8 (Δ2) fails; original 8 matches exactly → cd-8
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions).toContainEqual({
      type: "card.delete",
      targetId: "cd-8",
    });
  });

  it("no candidate within any tolerance => honest no-match", () => {
    const result = parseCommand(
      "删除8分钟左右的倒计时",
      ctxOf(countdown("cd-30", 30, 0), countdown("cd-60", 60, 1)),
    );
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.message).toContain("没有找到");
    expect(result.message).toContain("8");
  });
});
