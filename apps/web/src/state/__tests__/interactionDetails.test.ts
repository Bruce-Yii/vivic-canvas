import { describe, expect, it } from "vitest";
import { cardTargets, validCardTarget, CardRecordSchema, ActionEnvelopeSchema, type Action, type CardRecord } from "@/contracts";
import { createCanvasStore } from "../canvasStore";
import { fromCanvasRecord, toCanvasRecord } from "@/persistence/canvasRecord";
import { testCards } from "@/cards/__tests__/fixtures";
import { choiceNumber } from "@/commands/choice";
import { fastLocalCommand } from "@/commands/parse";

const setup = (card: CardRecord) => {
  const store = createCanvasStore(); let seq = 0;
  const dispatch = (...actions: Action[]) => store.dispatch({ schemaVersion: "0.6", canvasId: "TEST", requestId: `TEST-${++seq}`, actions });
  dispatch({ type: "card.create", card });
  return { store, dispatch, current: () => store.getState().cards[0]!.record };
};
describe("row-linked subcards and exact choices", () => {
  it("persists one source of content with its parent and restores it on parent undo, without moving/pinning/resizing", () => {
    const { store, dispatch, current } = setup({ ...testCards.TodoCard, layout: { ...testCards.TodoCard.layout, pinned: true, x: 83, y: 91 } });
    const layout = current().layout;
    dispatch({ type: "card.subcard.set", targetId: current().id, subcard: { id: "child", itemId: "TEST-task", text: "补充 **说明**" } });
    expect(current().layout).toEqual(layout);
    const rec = toCanvasRecord("TEST", "TEST", 2, store.getState());
    expect(fromCanvasRecord(rec).cards[0]!.record.metadata.subcards?.[0]?.text).toBe("补充 **说明**");
    dispatch({ type: "card.delete", targetId: current().id });
    store.internal({ type: "card.delete.commit", requestId: "TEST-3" }); store.internal({ type: "undo" });
    expect(current().metadata.subcards?.[0]?.id).toBe("child"); expect(current().layout).toEqual(layout);
  });
  it("updates a child idempotently, refuses unknown rows and enforces content/collection bounds", () => {
    const { dispatch, current } = setup(testCards.TodoCard);
    dispatch({ type: "card.subcard.set", targetId: current().id, subcard: { id: "child", itemId: "missing", text: "错误行" } });
    expect(current().metadata.subcards).toBeUndefined();
    dispatch({ type: "card.subcard.set", targetId: current().id, subcard: { id: "child", itemId: "TEST-task", text: "初始" } });
    dispatch({ type: "card.subcard.set", targetId: current().id, subcard: { id: "child", itemId: "TEST-task", text: "更新" } });
    expect(current().metadata.subcards).toHaveLength(1);
    expect(current().metadata.subcards![0]!.text).toBe("更新");
    expect(ActionEnvelopeSchema.safeParse({ schemaVersion: "0.6", requestId: "a", canvasId: "TEST", actions: [{ type: "card.subcard.set", targetId: current().id, subcard: { id: "long", text: "字".repeat(2001) } }] }).success).toBe(false);
    expect(CardRecordSchema.safeParse({ ...current(), metadata: { ...current().metadata, subcards: Array.from({ length: 25 }, (_, i) => ({ id: `${i}`, text: "x" })) } }).success).toBe(false);
    dispatch({ type: "card.subcard.delete", targetId: current().id, subcardId: "child" }); expect(current().metadata.subcards).toHaveLength(0);
  });
  it("follows stable Todo IDs through reorder and text updates", () => {
    const card = { ...testCards.TodoCard, displayProps: { items: [{ id: "one", text: "第一项", done: false }, { id: "two", text: "第二项", done: false }] } };
    const target = cardTargets(card)[2]!;
    expect(validCardTarget({ ...card, displayProps: { items: [{ id: "two", text: "改过的第二项", done: true }, card.displayProps.items[0]!] } }, target)).toBe(true);
    expect(validCardTarget({ ...card, displayProps: { items: [card.displayProps.items[0]!] } }, target)).toBe(false);
  });
  it("distinguishes identical table rows and invalidates edits/reorders instead of attaching to a different row", () => {
    const card = { ...testCards.TableCard, displayProps: { columns: ["事项"], rows: [["相同"], ["相同"], ["另一行"]] } };
    const one = cardTargets(card)[1]!, two = cardTargets(card)[2]!;
    expect(one.itemId).not.toBe(two.itemId); expect(one.anchor).toBe(two.anchor);
    expect(validCardTarget(card, two)).toBe(true);
    expect(validCardTarget({ ...card, displayProps: { ...card.displayProps, rows: [["相同"], ["已修改"], ["另一行"]] } }, two)).toBe(false);
    expect(validCardTarget({ ...card, displayProps: { ...card.displayProps, rows: [["相同"], ["另一行"], ["相同"]] } }, two)).toBe(false);
  });
  it("retains orphan content for explicit repair, and Note variant changes preserve all links", () => {
    const { dispatch, current } = setup(testCards.NoteCard);
    const target = cardTargets(current())[2]!;
    dispatch({ type: "card.subcard.set", targetId: current().id, subcard: { id: "child", ...target, label: undefined, text: "hello" } } as unknown as Action);
    // No unrecognized label can pass the strict action boundary.
    expect(current().metadata.subcards).toBeUndefined();
    dispatch({ type: "card.subcard.set", targetId: current().id, subcard: { id: "child", itemId: target.itemId, anchor: target.anchor, text: "hello" } });
    dispatch({ type: "card.update", targetId: current().id, variant: "expanded" });
    expect(validCardTarget(current(), current().metadata.subcards![0]!)).toBe(true);
    dispatch({ type: "card.update", targetId: current().id, displayProps: { text: "new line" } });
    expect(validCardTarget(current(), current().metadata.subcards![0]!)).toBe(false);
    expect(current().metadata.subcards![0]!.text).toBe("hello");
  });
  it.each(["2", "2号", "第二个", "选二号", "第2号卡片"])("accepts the complete numbered reply %s", text => expect(choiceNumber(text)).toBe(2));
  it.each(["不要2号", "2号和3号", "删掉2号然后删全部", "2分钟", "第二个待办"])("never parses a partial/compound reply %s", text => expect(choiceNumber(text)).toBeNull());
  it("resolves named reminders exactly, highlights without changing the group, and leaves duplicates ambiguous", () => {
    const make = (id: string, text: string): CardRecord => ({ ...testCards.CountdownCard, id, metadata: { ...testCards.CountdownCard.metadata, aliases: [] }, sourceData: { targetAt: "2099-01-01T00:00:00.000Z", reminderText: text } });
    const { store, dispatch } = setup(make("water", "喝水")); dispatch({ type: "card.create", card: make("rest", "休息") });
    const run = (text: string) => fastLocalCommand(text, { state: store.getState(), canvasId: "TEST" });
    expect(run("删除喝水提醒")).toMatchObject({ kind: "envelope", actions: expect.arrayContaining([{ type: "card.delete", targetId: "water" }]) });
    expect(run("取消喝水提醒")).toMatchObject({ kind: "envelope" });
    expect(run("高亮休息提醒")).toMatchObject({ kind: "envelope", actions: expect.arrayContaining([{ type: "card.highlight", targetId: "rest", durationMs: 6000 }]) });
    expect(run("删除不存在提醒")).toMatchObject({ kind: "unknown" });
    dispatch({ type: "card.create", card: make("water2", "喝水") });
    expect(run("删除喝水提醒")).toMatchObject({ kind: "clarify", candidates: expect.arrayContaining([expect.objectContaining({ card: expect.objectContaining({ id: "water" }) }), expect.objectContaining({ card: expect.objectContaining({ id: "water2" }) })]) });
  });
});
