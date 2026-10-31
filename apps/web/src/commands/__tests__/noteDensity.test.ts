import { describe, expect, it } from "vitest";
import { ActionEnvelopeSchema, CardRecordSchema, type CardRecord } from "@/contracts";
import { emptyVivicState } from "@/persistence/canvasRecord";
import { clarifiedCardAction, parseCommand, type CommandContext } from "../parse";

const note = (id: string, x = 0): CardRecord => CardRecordSchema.parse({
  id, type: "NoteCard", variant: "minimal", displayProps: { text: "保留的完整便笺正文\n第二行", bullets: ["原有重点"] },
  sourceData: { originalText: "TEST original full text", nested: { private: "TEST original metadata" } }, sources: [],
  layout: { x, y: 0, width: 264, height: 128, pinned: false },
  metadata: { createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" },
});
const context = (cards: CardRecord[], focusedId?: string): CommandContext => ({
  canvasId: "TEST-canvas", state: { ...emptyVivicState(), stage: "WORKSPACE", cards: cards.map(record => ({ record })),
    focus: focusedId ? { cardId: focusedId, prevViewport: { x: 0, y: 0, zoom: 1 } } : null,
    focusHistory: focusedId ? [focusedId] : [],
  },
});
const envelope = (input: string, ctx = context([note("n1")])) => {
  const result = parseCommand(input, ctx);
  expect(result.kind).toBe("envelope");
  if (result.kind !== "envelope") throw new Error("TEST expected a density action");
  expect(ActionEnvelopeSchema.safeParse({ schemaVersion: "0.6", requestId: "TEST", canvasId: ctx.canvasId, actions: result.actions }).success).toBe(true);
  return result;
};

describe("explicit Note expand/collapse commands", () => {
  it.each(["展开这张便笺", "展开便笺", "展开便签", "展开笔记", "展开 note", "请展开这张便笺。", "把这张便笺展开", "请将便笺展开！"])("%s emits density update then fit, preserving original content", input => {
    const ctx = context([note("n1")]), before = structuredClone(ctx.state);
    expect(envelope(input, ctx).actions).toEqual([{ type: "card.update", targetId: "n1", variant: "expanded" }, { type: "canvas.fit" }]);
    expect(ctx.state).toEqual(before);
  });
  it.each(["收起便笺", "收起这张笔记", "折叠便签", "把便笺收起", "请将便签折叠。"])("%s returns to minimal without rewriting data", input => {
    const card = { ...note("n1"), variant: "expanded" as const };
    expect(envelope(input, context([card])).actions).toEqual([{ type: "card.update", targetId: "n1", variant: "minimal" }, { type: "canvas.fit" }]);
    expect(card.variant).toBe("expanded"); expect(card.sourceData).toMatchObject({ originalText: "TEST original full text" });
  });
  it.each(["展开便笺", "展开这张便笺", "收起便笺", "折叠笔记"])("%s clarifies several Notes without current focus, never guesses newest", input => {
    const ctx = context([note("n1", 0), note("n2", 600)]);
    ctx.state.focusHistory = ["n2"]; // Stored history alone is not a current camera focus.
    const result = parseCommand(input, ctx);
    expect(result.kind).toBe("clarify");
    if (result.kind !== "clarify") throw new Error("TEST expected Note clarification");
    expect(result.action).toBe(input.startsWith("展开") ? "expand" : "collapse");
    expect(result.candidates.map(candidate => candidate.card.id)).toEqual(["n1", "n2"]);
  });
  it("uses a current Note focus for a generic reference, with explicit positions/ordinals taking precedence", () => {
    const ctx = context([note("n1", 0), note("n2", 600)], "n2");
    expect(envelope("展开这张便笺", ctx).actions[0]).toEqual({ type: "card.update", targetId: "n2", variant: "expanded" });
    expect(envelope("展开便笺", ctx).actions[0]).toEqual({ type: "card.update", targetId: "n2", variant: "expanded" });
    expect(envelope("收起左边的便笺", ctx).actions[0]).toEqual({ type: "card.update", targetId: "n1", variant: "minimal" });
    expect(envelope("展开第一张便笺", ctx).actions[0]).toEqual({ type: "card.update", targetId: "n1", variant: "expanded" });
  });
  it("does not reinterpret a non-Note focus or exiting card as the current Note target", () => {
    const todo = CardRecordSchema.parse({ ...note("todo"), type: "TodoCard", displayProps: { items: [{ id: "i", text: "TEST", done: false }] }, sourceData: {} });
    const ctx = context([note("n1", 0), note("n2", 600), todo], "todo");
    expect(parseCommand("展开这张便笺", ctx).kind).toBe("clarify");
    ctx.state.cards[0]!.exitingRequestId = "TEST-deleting";
    expect(envelope("展开便笺", ctx).actions[0]).toEqual({ type: "card.update", targetId: "n2", variant: "expanded" });
    expect(clarifiedCardAction("expand", todo)).toBeNull(); expect(clarifiedCardAction("collapse", todo)).toBeNull();
  });
  it("uses the same Note-only action for clarification and never substitutes focus", () => {
    const card = note("n1");
    expect(clarifiedCardAction("expand", card)).toEqual({ type: "card.update", targetId: "n1", variant: "expanded" });
    expect(clarifiedCardAction("collapse", card)).toEqual({ type: "card.update", targetId: "n1", variant: "minimal" });
    expect(clarifiedCardAction("focus", card)).toEqual({ type: "card.focus", targetId: "n1" });
  });
  it("keeps camera focus separate from density", () => {
    const ctx = context([{ ...note("n1"), variant: "expanded" }]);
    const result = envelope("放大便签", ctx);
    expect(result.actions).toEqual([{ type: "card.focus", targetId: "n1" }]);
    expect(ctx.state.cards[0]!.record.variant).toBe("expanded");
  });
  it.each(["展开待办", "收起倒计时", "不要展开便笺", "展开便笺然后删除便笺", "展开便笺，收起便笺", "展开不存在的便笺", "展开第十张便笺"])("does not partially execute or guess %s", input => {
    expect(parseCommand(input, context([note("n1")])).kind).toBe("unknown");
  });
  it("reports a missing Note and awakens standby before explicit density changes", () => {
    expect(parseCommand("展开便笺", context([])).kind).toBe("unknown");
    const ctx = context([note("n1")]); ctx.state.stage = "STANDBY";
    expect(envelope("展开便笺", ctx).actions.map(action => action.type)).toEqual(["stage.awaken", "card.update", "canvas.fit"]);
  });
});
