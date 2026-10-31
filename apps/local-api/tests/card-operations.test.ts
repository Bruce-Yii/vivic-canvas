import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ActionSchema, HostOperationSchema, type Action } from "@vivic/contracts";
import { operationContracts } from "../src/cards/operations.js";
import type { CardBuildContext } from "../src/cards/types.js";
import { actionExecutionIssue } from "../src/intent/validation.js";
import { sceneUpdateIssue } from "../src/scenes/index.js";

type Card = CardBuildContext["cards"][number];
const now = new Date("2026-10-30T00:00:00Z");
const todo = (): Card => ({ id: "trusted-todo", type: "TodoCard", displayProps: { title: "原标题", items: [
  { id: "stable-first", text: "保留第一项", done: false }, { id: "stable-second", text: "保留第二项", done: true },
] }, sourceDataSummary: {}, layout: { x: 0, y: 0, pinned: false } });
const note = (): Card => ({ id: "trusted-note", type: "NoteCard", displayProps: { text: "原文" }, sourceDataSummary: {}, layout: { x: 200, y: 0 } });
const timer = (source: Record<string, unknown> = {}): Card => ({ id: "trusted-timer", type: "CountdownCard", displayProps: {},
  sourceDataSummary: { targetAt: "2099-01-01T00:00:00Z", ...source }, layout: { x: 400, y: 0 } });
const context = (card: Card = todo(), extra: Partial<CardBuildContext> = {}): CardBuildContext => ({
  canvasId: "test-canvas", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [],
  cards: [card], targetId: card.id, ...extra,
});
const build = async (name: string, slots: unknown, ctx = context()) => operationContracts[name]!.build(slots, ctx, now);
async function actions(slots: unknown, ctx = context()): Promise<Action[]> {
  const result = await build("edit", slots, ctx);
  if (!Array.isArray(result)) throw new Error("Expected actions");
  expect(result.every(action => ActionSchema.safeParse(action).success)).toBe(true);
  return result;
}
async function edited(slots: unknown, ctx = context()) {
  const result = await actions(slots, ctx);
  const update = result.find(action => action.type === "card.update");
  if (!update) throw new Error("Expected an update");
  return update;
}

describe("operation slot authority boundaries", () => {
  it("exports exactly three contracts with JSON schemas for the planner", () => {
    expect(Object.keys(operationContracts).sort()).toEqual(["arrange", "delete", "edit"]);
    for (const [id, contract] of Object.entries(operationContracts)) {
      expect(contract.id).toBe(id);
      expect(() => z.toJSONSchema(contract.slots)).not.toThrow();
    }
  });

  it.each(["targetId", "id", "itemId", "layout", "metadata", "createdAt", "updatedAt", "targetAt"])(
    "rejects model authority field %s both in parsing and build", async key => {
      for (const [name, slots] of [["edit", { mode: "note", text: "修改" }], ["arrange", { mode: "move", direction: "left" }], ["delete", {}]] as const) {
        const injected = { ...slots, [key]: "model-controlled" };
        expect(operationContracts[name]!.slots.safeParse(injected).success).toBe(false);
        await expect(build(name, injected)).rejects.toThrow();
      }
    },
  );

  it.each(["targetId", "id", "layout", "metadata", "createdAt", "updatedAt", "fetchedAt", "__proto__", "constructor"])(
    "rejects authority field %s inside a display patch", async key => {
      const displayProps = JSON.parse(`{"${key}":"injected"}`);
      await expect(build("edit", { mode: "display", displayProps })).rejects.toThrow();
    },
  );

  it.each([
    { mode: "display", displayProps: {} },
    { mode: "display", displayProps: { items: [{ id: "invented" }] } },
    { mode: "todo", operation: "append", text: "新项", itemIndex: 0 },
    { mode: "todo", operation: "update", itemIndex: -1, done: true },
    { mode: "todo", operation: "update", itemIndex: 0.5, done: true },
    { mode: "todo", operation: "update", itemIndex: 30, done: true },
    { mode: "todo", operation: "update", itemIndex: 0 },
    { mode: "note", text: "修改", variant: "expanded" },
    { mode: "note", text: "修改", bullets: ["混合"] },
    { mode: "note", bullets: [] },
    { mode: "note", text: " " },
  ])("rejects invalid or mixed edit slots %j", async slots => {
    await expect(build("edit", slots)).rejects.toThrow();
  });

  it("never infers a target from focus, card count, or selected IDs", async () => {
    const ctx = context(todo(), { targetId: undefined, focusHistory: ["trusted-todo"], selectedCardIds: ["trusted-todo"] });
    for (const [name, slots] of [["edit", { mode: "todo", operation: "title", title: "新标题" }], ["delete", {}], ["arrange", { mode: "pin", pinned: true }]] as const) {
      await expect(build(name, slots, ctx)).rejects.toThrow(/宿主/);
    }
    await expect(build("delete", {}, context(todo(), { targetId: "stale" }))).rejects.toThrow();
    await expect(build("delete", {}, context(todo(), { cards: [todo(), todo()] }))).rejects.toThrow();
  });
});

describe("todo edits preserve host identities and full state", () => {
  it("updates a zero-based item index while retaining all IDs, text, and other rows", async () => {
    const ctx = context();
    const before = structuredClone(ctx);
    const result = await actions({ mode: "todo", operation: "update", itemIndex: 0, done: true }, ctx);
    expect(result).toEqual([{ type: "card.update", targetId: "trusted-todo", displayProps: { items: [
      { id: "stable-first", text: "保留第一项", done: true }, { id: "stable-second", text: "保留第二项", done: true },
    ] } }]);
    expect(actionExecutionIssue(result, ctx)).toBeNull();
    expect(ctx).toEqual(before);
  });

  it("uses a host itemId without an index and can set done to false", async () => {
    const result = await edited({ mode: "todo", operation: "update", text: "新文字", done: false }, context(todo(), { itemId: "stable-second" }));
    expect(result.displayProps?.items).toEqual([
      { id: "stable-first", text: "保留第一项", done: false }, { id: "stable-second", text: "新文字", done: false },
    ]);
  });

  it.each([
    [{ itemIndex: 2 }, {}], [{}, {}], [{ itemIndex: 0 }, { itemId: "stable-second" }], [{ itemIndex: 0 }, { itemId: "missing" }],
  ])("rejects missing, stale, out-of-range or conflicting item selection %j", async (selection, host) => {
    await expect(build("edit", { mode: "todo", operation: "update", done: true, ...selection }, context(todo(), host))).rejects.toThrow();
  });

  it("generates fresh append IDs and preserves all existing rows", async () => {
    const ctx = context();
    const a = await edited({ mode: "todo", operation: "append", text: "  买牛奶  " }, ctx);
    const b = await edited({ mode: "todo", operation: "append", text: "买牛奶" }, ctx);
    const rows = a.displayProps?.items as Array<{ id: string; text: string; done: boolean }>;
    expect(rows.slice(0, 2)).toEqual(ctx.cards[0]!.displayProps.items);
    expect(rows[2]).toEqual({ id: expect.stringMatching(/^item_/), text: "买牛奶", done: false });
    expect(rows[2]!.id).not.toBe((b.displayProps?.items as typeof rows)[2]!.id);
    expect(actionExecutionIssue([a], ctx)).toBeNull();
  });

  it("removes only the selected existing row and changes titles independently", async () => {
    expect((await edited({ mode: "todo", operation: "remove", itemIndex: 0 })).displayProps?.items)
      .toEqual([{ id: "stable-second", text: "保留第二项", done: true }]);
    expect(await edited({ mode: "todo", operation: "title", title: "新标题" }))
      .toEqual({ type: "card.update", targetId: "trusted-todo", displayProps: { title: "新标题" } });
  });

  it("refuses to erase the last item or exceed the card's 30-item limit", async () => {
    const single = todo(); single.displayProps.items = [{ id: "one", text: "仅此项", done: false }];
    await expect(build("edit", { mode: "todo", operation: "remove", itemIndex: 0 }, context(single))).rejects.toThrow(/最后/);
    const full = todo(); full.displayProps.items = Array.from({ length: 30 }, (_, i) => ({ id: `row-${i}`, text: "已有项", done: false }));
    await expect(build("edit", { mode: "todo", operation: "append", text: "第31项" }, context(full))).rejects.toThrow(/30/);
  });

  it("refuses duplicate IDs, incomplete rows and truncated snapshots", async () => {
    const duplicate = todo(); duplicate.displayProps.items = [{ id: "same", text: "甲", done: false }, { id: "same", text: "乙", done: false }];
    const malformed = todo(); malformed.displayProps.items = [{ id: "one", text: "甲" }];
    for (const card of [duplicate, malformed, { ...todo(), contextSummary: { truncatedFields: ["items"] } }]) {
      await expect(build("edit", { mode: "todo", operation: "append", text: "新项" }, context(card))).rejects.toThrow();
    }
  });
});

describe("note and scene edit boundaries", () => {
  it.each([{ text: "新原文" }, { bullets: ["甲", "乙"] }, { variant: "expanded" }])("supports isolated note edits %j", async patch => {
    const ctx = context(note());
    const result = await actions({ mode: "note", ...patch }, ctx);
    expect(result).toEqual([{ type: "card.update", targetId: "trusted-note", ...("variant" in patch ? patch : { displayProps: patch }) }]);
    expect(actionExecutionIssue(result, ctx)).toBeNull();
  });

  it("refuses specialized modes on the wrong card type or summarized note fields", async () => {
    await expect(build("edit", { mode: "note", text: "文本" })).rejects.toThrow(/便笺/);
    await expect(build("edit", { mode: "todo", operation: "append", text: "新项" }, context(note()))).rejects.toThrow(/待办/);
    await expect(build("edit", { mode: "note", text: "文本" }, context({ ...note(), contextSummary: { truncatedFields: ["text"] } }))).rejects.toThrow(/摘要/);
    for (const card of [todo(), note(), timer()]) {
      await expect(build("edit", { mode: "display", displayProps: { text: "绕过专用操作" } }, context(card))).rejects.toThrow();
    }
  });

  it("passes scene patches to the existing shape and grounding validators", async () => {
    const card: Card = { ...note(), type: "ProgressRingCard", displayProps: { title: "读书", current: 1, target: 10 } };
    const ctx = context(card);
    const result = await actions({ mode: "display", displayProps: { current: 3 } }, ctx);
    expect(actionExecutionIssue(result, ctx)).toBeNull();
    expect(sceneUpdateIssue(result, { text: "把已读改为3", ctx })).toBeNull();
    expect(sceneUpdateIssue(result, { text: "更新进度", ctx })).toMatch(/数值/);
    const invalid = await actions({ mode: "display", displayProps: { current: "不是数字" } }, ctx);
    expect(actionExecutionIssue(invalid, ctx)).toBeTruthy();
  });
});

describe("exclusive host operations and single-target deletion", () => {
  it.each([
    [{ mode: "move", direction: "left" }, { kind: "card.move", targetId: "trusted-todo", direction: "left" }],
    [{ mode: "pin", pinned: false }, { kind: "card.pin", targetId: "trusted-todo", pinned: false }],
    [{ mode: "surface", surface: "user" }, { kind: "card.surface", targetId: "trusted-todo", surface: "user" }],
    [{ mode: "arrange" }, { kind: "canvas.arrange" }],
    [{ mode: "organize", sort: "due", direction: "asc", group: "keep" }, { kind: "canvas.organize.preview", sort: "due", direction: "asc", group: "keep" }],
  ])("emits exactly one HostOperation for %j even in standby", async (slots, operation) => {
    const result = await build("arrange", slots, context(todo(), { stage: "STANDBY" }));
    expect(result).toEqual({ hostOperation: operation });
    expect(HostOperationSchema.safeParse(operation).success).toBe(true);
    expect(result).not.toHaveProperty("envelope");
    expect(result).not.toHaveProperty("actions");
  });

  it("permits global arrange/preview without inventing a selected target", async () => {
    expect(await build("arrange", { mode: "arrange" }, context(todo(), { cards: [], targetId: undefined })))
      .toEqual({ hostOperation: { kind: "canvas.arrange" } });
  });

  it.each([{ relativeTo: "other" }, { x: 30 }, { y: 20 }, { coordinates: [1, 2] }])("rejects model movement authority %j", async extra => {
    await expect(build("arrange", { mode: "move", direction: "left", ...extra })).rejects.toThrow();
  });

  it.each([true, undefined])("refuses movement when pinned is %j without unlocking the card", async pinned => {
    const card = todo(); card.layout.pinned = pinned;
    await expect(build("arrange", { mode: "move", direction: "left" }, context(card))).rejects.toThrow(/固定/);
    expect(card.layout.pinned).toBe(pinned);
  });

  it("pauses and resumes ordinary timers without producing model timestamps or envelopes", async () => {
    expect(await build("edit", { mode: "countdown", operation: "pause" }, context(timer(), { stage: "STANDBY" })))
      .toEqual({ hostOperation: { kind: "countdown.pause", targetId: "trusted-timer" } });
    expect(await build("edit", { mode: "countdown", operation: "resume" }, context(timer({ pausedAt: "2026-10-29T00:00:00Z" }))))
      .toEqual({ hostOperation: { kind: "countdown.resume", targetId: "trusted-timer" } });
  });

  it.each([{ event: {} }, { schedule: {} }, { condition: {} }, { targetAt: "bad-date" }, { pausedAt: "2026-10-29T00:00:00Z" }])(
    "refuses an unsafe countdown pause state %j", async source => {
      await expect(build("edit", { mode: "countdown", operation: "pause" }, context(timer(source)))).rejects.toThrow();
    },
  );

  it("refuses resume when running and countdown operations on another card type", async () => {
    await expect(build("edit", { mode: "countdown", operation: "resume" }, context(timer()))).rejects.toThrow();
    await expect(build("edit", { mode: "countdown", operation: "pause" }, context(note()))).rejects.toThrow();
  });

  it("deletes only the exact host target, including when other cards are loaded", async () => {
    const ctx = context(note(), { cards: [todo(), note(), timer()] });
    const result = await build("delete", {}, ctx);
    expect(result).toEqual([{ type: "card.delete", targetId: "trusted-note" }]);
    expect(actionExecutionIssue(result as Action[], ctx)).toBeNull();
    for (const slots of [{ all: true }, { targetIds: ["trusted-todo", "trusted-note"] }]) {
      await expect(build("delete", slots, ctx)).rejects.toThrow();
    }
    expect(ctx.cards).toHaveLength(3);
  });
});
