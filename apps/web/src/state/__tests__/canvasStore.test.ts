import { beforeEach, describe, expect, it } from "vitest";
import type { CardRecord } from "@/contracts";
import { createCanvasStore } from "@/state/canvasStore";

const card = (id: string): CardRecord => ({
  id,
  type: "TodoCard",
  variant: "minimal",
  displayProps: { items: [{ id: `${id}-t1`, text: "task", done: false }] },
  sourceData: {},
  sources: [],
  layout: { x: 0, y: 0, width: 260, height: 120, pinned: false },
  metadata: {
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
  },
});

describe("canvasStore", () => {
  let store = createCanvasStore();
  beforeEach(() => {
    store = createCanvasStore();
  });

  it("applies card.create and rejects invalid envelopes", () => {
    expect(
      store.dispatch({
        schemaVersion: "0.6",
        requestId: "r1",
        canvasId: "c",
        actions: [{ type: "card.create", card: card("a") }],
      }).ok,
    ).toBe(true);
    expect(store.getState().cards).toHaveLength(1);
    expect(store.getState().stage).toBe("AWAKENING");
    const bad = store.dispatch({ totally: "wrong" });
    expect(bad.ok).toBe(false);
  });

  it("does not awaken for user-page cards or future hidden reminders", () => {
    const userCard = card("user"); userCard.layout.surface = "user";
    store.dispatch({ schemaVersion: "0.6", requestId: "quiet-user", canvasId: "c", actions: [{ type: "card.create", card: userCard }] });
    expect(store.getState().stage).toBe("STANDBY");
    const reminder = { ...card("future"), type: "CountdownCard", displayProps: {}, sourceData: { targetAt: new Date(Date.now() + 86400000).toISOString(), reminderText: "明天交周报" } };
    store.dispatch({ schemaVersion: "0.6", requestId: "quiet-reminder", canvasId: "c", actions: [{ type: "card.create", card: reminder }, { type: "canvas.fit" }] });
    expect(store.getState().stage).toBe("STANDBY");
    store.dispatch({ schemaVersion: "0.6", requestId: "focus-future", canvasId: "c", actions: [{ type: "card.focus", targetId: "future" }] });
    expect(store.getState().stage).toBe("AWAKENING");
  });

  it("is idempotent by requestId", () => {
    const env = {
      schemaVersion: "0.6",
      requestId: "r1",
      canvasId: "c",
      actions: [{ type: "card.create", card: card("a") }],
    };
    store.dispatch(env);
    const res = store.dispatch(env);
    expect(res).toEqual({ ok: true, deduplicated: true });
    expect(store.getState().cards).toHaveLength(1);
  });

  it("rejects a card.create carrying an unknown displayProps field", () => {
    const res = store.dispatch({
      schemaVersion: "0.6",
      requestId: "r1",
      canvasId: "c",
      actions: [
        {
          type: "card.create",
          card: { ...card("a"), displayProps: { advice: "relax" } },
        },
      ],
    });
    expect(res.ok).toBe(false);
    expect(store.getState().cards).toHaveLength(0);
  });

  it("delete then undo restores the exact prior record and order", () => {
    store.dispatch({
      schemaVersion: "0.6",
      requestId: "create",
      canvasId: "c",
      actions: [
        { type: "card.create", card: { ...card("a"), layout: { x: 10, y: 20, width: 260, height: 120, pinned: true } } },
        { type: "card.create", card: card("b") },
      ],
    });
    const before = store.getState().cards.map((c) => c.record.id);
    store.dispatch({
      schemaVersion: "0.6",
      requestId: "del",
      canvasId: "c",
      actions: [{ type: "card.delete", targetId: "a" }],
    });
    // Exiting flag first; the record is still present for the fade-out.
    expect(store.getState().cards[0]!.exitingRequestId).toBe("del");
    store.internal({ type: "card.delete.commit", requestId: "del" });
    expect(store.getState().cards.map((c) => c.record.id)).toEqual(["b"]);
    store.internal({ type: "undo" });
    const after = store.getState().cards;
    expect(after.map((c) => c.record.id)).toEqual(before);
    expect(after[0]!.record.layout).toEqual({
      x: 10,
      y: 20,
      width: 260,
      height: 120,
      pinned: true,
    });
    expect(after[0]!.exitingRequestId).toBeUndefined();
  });

  it("focus records history and the previous viewport; restore clears it", () => {
    store.internal({
      type: "canvas.viewport",
      viewport: { x: -120, y: 40, zoom: 0.8 },
    });
    store.dispatch({
      schemaVersion: "0.6",
      requestId: "create",
      canvasId: "c",
      actions: [{ type: "card.create", card: card("a") }],
    });
    store.dispatch({
      schemaVersion: "0.6",
      requestId: "foc",
      canvasId: "c",
      actions: [{ type: "card.focus", targetId: "a" }],
    });
    const s = store.getState();
    expect(s.focus).toEqual({
      cardId: "a",
      prevViewport: { x: -120, y: 40, zoom: 0.8 },
    });
    expect(s.focusHistory).toEqual(["a"]);
    store.dispatch({
      schemaVersion: "0.6",
      requestId: "restore",
      canvasId: "c",
      actions: [{ type: "canvas.restore" }],
    });
    expect(store.getState().focus).toBeNull();
    expect(store.getState().focusHistory).toEqual(["a"]);
  });

  it("awaken moves STANDBY → AWAKENING once", () => {
    store.dispatch({
      schemaVersion: "0.6",
      requestId: "wake",
      canvasId: "c",
      actions: [{ type: "stage.awaken" }],
    });
    expect(store.getState().stage).toBe("AWAKENING");
    store.internal({ type: "stage.awakening.complete" });
    expect(store.getState().stage).toBe("WORKSPACE");
    store.dispatch({
      schemaVersion: "0.6",
      requestId: "wake2",
      canvasId: "c",
      actions: [{ type: "stage.awaken" }],
    });
    expect(store.getState().stage).toBe("WORKSPACE");
  });

  it("subtitle.show replaces, dismiss only clears the matching id", () => {
    store.dispatch({
      schemaVersion: "0.6",
      requestId: "s1",
      canvasId: "c",
      actions: [{ type: "subtitle.show", text: "first", durationMs: 1000 }],
    });
    store.dispatch({
      schemaVersion: "0.6",
      requestId: "s2",
      canvasId: "c",
      actions: [{ type: "subtitle.show", text: "second", durationMs: 1000 }],
    });
    expect(store.getState().subtitle?.text).toBe("second");
    store.internal({ type: "subtitle.dismiss", id: "s1" });
    expect(store.getState().subtitle?.text).toBe("second");
    store.internal({ type: "subtitle.dismiss", id: "s2" });
    expect(store.getState().subtitle).toBeNull();
  });
});
