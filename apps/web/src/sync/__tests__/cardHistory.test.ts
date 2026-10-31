import { describe, it, expect } from "vitest";
import { CardHistory } from "../cardHistory";
import type { CardRecord } from "@/contracts";
const card = (id: string, text = id): CardRecord => ({ id, type: "NoteCard", variant: "standard", displayProps: { text }, sourceData: {}, sources: [],
  layout: { x: 0, y: 0, width: 300, height: 180, pinned: false }, metadata: { createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z" } });
describe("owner content history", () => {
  it("undoes and redoes content, layout, metadata and grouped deletion exactly", () => {
    const history = new CardHistory(), a = card("a"), b = card("b");
    const moved = { ...a, layout: { ...a.layout, surface: "user" as const, pinned: true }, metadata: { ...a.metadata, section: "旅行", priority: "high" as const } };
    history.record([a, b], [moved, b], "传送");
    expect(history.undo([moved, b])).toEqual([a, b]);
    expect(history.redo([a, b])).toEqual([moved, b]);
    history.record([moved, b], [], "批量删除");
    expect(history.undo([])).toEqual([moved, b]);
    expect(history.redo([moved, b])).toEqual([]);
  });
  it("does not overwrite a later update on the changed card", () => {
    const history = new CardHistory(), a = card("a"), edited = card("a", "new");
    history.record([a], [edited], "编辑");
    expect(history.undo([card("a", "external change")])).toBeNull();
    expect(history.status.canUndo).toBe(true);
  });
  it("preserves unrelated new data and clears redo when a new edit is made", () => {
    const history = new CardHistory(), a = card("a"), edited = card("a", "new"), extra = card("b");
    history.record([a], [edited], "编辑");
    expect(history.undo([edited, extra])).toEqual([a, extra]);
    expect(history.redo([a, extra])).toEqual([edited, extra]);
    history.undo([edited, extra]); history.record([a, extra], [card("a", "third"), extra], "新编辑");
    expect(history.status.canRedo).toBe(false);
  });
  it("restores sorting and makes view-only no-ops leave redo intact", () => {
    const history = new CardHistory(), a = card("a"), b = card("b");
    history.record([a, b], [b, a], "排序");
    expect(history.undo([b, a])).toEqual([a, b]);
    history.record([a, b], [a, b], "聚焦");
    expect(history.redo([a, b])).toEqual([b, a]);
  });
});
