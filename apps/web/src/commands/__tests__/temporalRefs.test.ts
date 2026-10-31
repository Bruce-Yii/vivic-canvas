import { describe, expect, it } from "vitest";
import type { CardRecord } from "@/contracts";
import { emptyVivicState } from "@/persistence/canvasRecord";
import type { VivicState } from "@/state/canvasStore";
import { parseCommand, type CommandContext } from "../parse";

/**
 * Phase 1.1 (BUG 2): countdown references by duration -
 * “删除13分钟的倒计时 / 那个倒计时13分钟的 / focus 倒计时十分钟的 / 还有13分钟的那个”.
 */
const fixedNow = "2026-10-15T08:00:00.000Z";
const NOW = Date.parse(fixedNow);

const countdown = (id: string, minutes: number, x = 0): CardRecord => ({
  id,
  type: "CountdownCard",
  variant: "minimal",
  displayProps: {},
  sourceData: {
    targetAt: new Date(NOW + minutes * 60_000).toISOString(),
    startedAt: fixedNow,
  },
  sources: [],
  layout: { x, y: 0, width: 264, height: 96, pinned: false },
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

describe("temporal countdown references", () => {
  const three = () => [
    countdown("cd-5", 5, 0),
    countdown("cd-13", 13, 320),
    countdown("cd-40", 40, 640),
  ];

  it.each([
    "删除13分钟的那个倒计时",
    "删除13分钟的倒计时",
    "删除那个倒计时13分钟的",
    "删掉十三分钟的倒计时",
  ])("%s selects exactly the 13-minute one", (input) => {
    const result = parseCommand(input, ctxOf(...three()));
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions).toContainEqual({
      type: "card.delete",
      targetId: "cd-13",
    });
  });

  it("放大十三分钟的倒计时 focuses that card", () => {
    const result = parseCommand("放大十三分钟的倒计时", ctxOf(...three()));
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions).toContainEqual({
      type: "card.focus",
      targetId: "cd-13",
    });
  });

  it("focus 倒计时5分钟的 resolves the 5-minute card", () => {
    const result = parseCommand("focus 倒计时5分钟的", ctxOf(...three()));
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions).toContainEqual({
      type: "card.focus",
      targetId: "cd-5",
    });
  });

  it("还有13分钟的那个倒计时 also resolves", () => {
    const result = parseCommand("删除还有13分钟的那个倒计时", ctxOf(...three()));
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions).toContainEqual({
      type: "card.delete",
      targetId: "cd-13",
    });
  });

  it("two countdowns within ±1 min => clarification, not deletion", () => {
    const ctx = ctxOf(countdown("cd-a", 13), countdown("cd-b", 14));
    const result = parseCommand("删除13分钟的倒计时", ctx);
    expect(result.kind).toBe("clarify");
    if (result.kind !== "clarify") return;
    expect(result.action).toBe("delete");
    expect(result.candidates.map((c) => c.card.id).sort()).toEqual([
      "cd-a",
      "cd-b",
    ]);
  });

  it("non-existent duration => honest no-match, no guessing", () => {
    const result = parseCommand("删除20分钟的倒计时", ctxOf(...three()));
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.message).toContain("20");
    expect(result.message).toContain("没有找到");
    // And nothing was deleted.
    expect(
      (result as { actions?: unknown[] }).actions,
    ).toBeUndefined();
  });

  it("duration with a todo card present stays a countdown match", () => {
    const todo: CardRecord = {
      id: "td",
      type: "TodoCard",
      variant: "minimal",
      displayProps: { items: [{ id: "td-1", text: "13 分钟买菜", done: false }] },
      sourceData: {},
      sources: [],
      layout: { x: 0, y: 0, width: 288, height: 160, pinned: false },
      metadata: { createdAt: fixedNow, updatedAt: fixedNow },
    };
    const result = parseCommand("放大13分钟的倒计时", ctxOf(todo, ...three()));
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions).toContainEqual({
      type: "card.focus",
      targetId: "cd-13",
    });
  });
});
