import { describe, expect, it } from "vitest";
import type { CardRecord } from "@/contracts";
import { emptyVivicState } from "@/persistence/canvasRecord";
import type { VivicState } from "@/state/canvasStore";
import { parseCommand, zhToNumber, type CommandContext } from "../parse";

const fixedNow = "2026-10-14T10:00:00.000Z";
const NOW = Date.parse(fixedNow);

const card = (
  id: string,
  type: CardRecord["type"],
  x: number,
  overrides: Partial<CardRecord> = {},
): CardRecord => {
  const base = {
    id,
    variant: "minimal" as const,
    sources: [],
    layout: { x, y: 0, width: 264, height: 120, pinned: false },
    metadata: { createdAt: fixedNow, updatedAt: fixedNow },
  };
  if (type === "TodoCard") {
    return {
      ...base,
      ...overrides,
      type,
      displayProps: { items: [{ id: `${id}-i1`, text: "任务", done: false }] },
      sourceData: {},
    } as CardRecord;
  }
  return {
    ...base,
    ...overrides,
    type,
    displayProps: {},
    sourceData: {
      targetAt: new Date(NOW + 600_000).toISOString(),
      startedAt: fixedNow,
    },
  } as CardRecord;
};

const ctxOf = (cards: CardRecord[], focusHistory: string[] = []): CommandContext => {
  const state: VivicState = {
    ...emptyVivicState(),
    stage: "WORKSPACE",
    cards: cards.map((record) => ({ record })),
    focusHistory,
  };
  return { state, canvasId: "c1", now: () => NOW };
};

describe("zh numerals", () => {
  it.each([
    ["十", 10],
    ["五", 5],
    ["二十", 20],
    ["二十五", 25],
    ["半", 0.5],
    ["10", 10],
    ["0.5", 0.5],
  ])("%s -> %s", (text, expected) => {
    expect(zhToNumber(text)).toBe(expected);
  });
  it("rejects garbage", () => {
    expect(zhToNumber("abc")).toBeNull();
    expect(zhToNumber("一二三")).toBeNull();
  });
});

describe("countdown command", () => {
  it.each([
    "十分钟倒计时",
    "10分钟倒计时",
    "创建一个十分钟倒计时",
    "倒计时 10 分钟",
  ])("%s builds a 600s CountdownCard", (input) => {
    const result = parseCommand(input, ctxOf([]));
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    const create = result.actions.find((a) => a.type === "card.create");
    expect(create).toBeDefined();
    if (create?.type !== "card.create" || create.card.type !== "CountdownCard") {
      throw new Error("expected countdown card");
    }
    const target = Date.parse(create.card.sourceData.targetAt);
    expect(target - NOW).toBe(600_000);
    expect(create.card.displayProps).toEqual({});
  });

  it("倒计时 5 分 30 秒 -> 330s", () => {
    const result = parseCommand("倒计时 5 分 30 秒", ctxOf([]));
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    const create = result.actions[0];
    if (create?.type !== "card.create" || create.card.type !== "CountdownCard") {
      throw new Error("expected countdown card");
    }
    expect(Date.parse(create.card.sourceData.targetAt) - NOW).toBe(330_000);
  });

  it("prepends stage.awaken when the stage is standby", () => {
    const ctx = ctxOf([]);
    ctx.state.stage = "STANDBY";
    const result = parseCommand("十分钟倒计时", ctx);
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions[0]?.type).toBe("stage.awaken");
    expect(result.actions[1]?.type).toBe("card.create");
  });
});

describe("todo command", () => {
  it("加待办：a；b；c -> one TodoCard with 3 items", () => {
    const result = parseCommand("加待办：写报告；回邮件；买药", ctxOf([]));
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    const create = result.actions.find((a) => a.type === "card.create");
    if (create?.type !== "card.create" || create.card.type !== "TodoCard") {
      throw new Error("expected todo card");
    }
    expect(create.card.displayProps.items.map((i) => i.text)).toEqual([
      "写报告",
      "回邮件",
      "买药",
    ]);
  });

  it("待办：a，b -> comma separated items", () => {
    const result = parseCommand("待办：a，b", ctxOf([]));
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    const create = result.actions[0];
    if (create?.type !== "card.create" || create.card.type !== "TodoCard") {
      throw new Error("expected todo card");
    }
    expect(create.card.displayProps.items).toHaveLength(2);
  });
});

describe("reference resolution", () => {
  const todoL = card("todo-l", "TodoCard", 0);
  const todoR = card("todo-r", "TodoCard", 600);

  it("放大左边的待办 -> unique focus on the left card", () => {
    const result = parseCommand("放大左边的待办", ctxOf([todoL, todoR]));
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions).toContainEqual({
      type: "card.focus",
      targetId: "todo-l",
    });
  });

  it("focus 第二个 -> ordinal pick", () => {
    const result = parseCommand("focus 第二个", ctxOf([todoL, todoR]));
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions).toContainEqual({
      type: "card.focus",
      targetId: "todo-r",
    });
  });

  it("删除那个卡片 with multiple candidates -> clarify, never delete", () => {
    const result = parseCommand("删除那个卡片", ctxOf([todoL, todoR]));
    expect(result.kind).toBe("clarify");
    if (result.kind !== "clarify") return;
    expect(result.action).toBe("delete");
    expect(result.candidates.map((c) => c.card.id).sort()).toEqual([
      "todo-l",
      "todo-r",
    ]);
  });

  it("删除待办 with two todos -> clarify", () => {
    const result = parseCommand("删除待办", ctxOf([todoL, todoR]));
    expect(result.kind).toBe("clarify");
  });

  it("删除倒计时 with exactly one countdown -> deletes directly", () => {
    const cd = card("cd1", "CountdownCard", 0);
    const result = parseCommand("删除倒计时", ctxOf([todoL, cd]));
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions).toContainEqual({
      type: "card.delete",
      targetId: "cd1",
    });
  });

  it("删除刚才那个 uses focus history", () => {
    const result = parseCommand(
      "删除刚才那个",
      ctxOf([todoL, todoR], ["todo-r"]),
    );
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions).toContainEqual({
      type: "card.delete",
      targetId: "todo-r",
    });
  });
});

describe("view + meta commands", () => {
  it("显示全部 -> canvas.fit", () => {
    const result = parseCommand("显示全部", ctxOf([card("a", "TodoCard", 0)]));
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions).toContainEqual({ type: "canvas.fit" });
  });

  it("恢复原视图 -> canvas.restore", () => {
    const result = parseCommand("恢复原视图", ctxOf([]));
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") return;
    expect(result.actions).toContainEqual({ type: "canvas.restore" });
  });

  it("撤销 -> undo intent", () => {
    expect(parseCommand("撤销", ctxOf([])).kind).toBe("undo");
  });

  it("unrecognized input says so honestly", () => {
    const result = parseCommand("帮我写一首诗", ctxOf([]));
    expect(result.kind).toBe("unknown");
  });

  it("delete with no matching card reports instead of guessing", () => {
    const result = parseCommand("删除天气", ctxOf([]));
    expect(result.kind).toBe("unknown");
  });
});
