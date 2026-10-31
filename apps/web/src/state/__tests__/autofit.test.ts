import { beforeEach, describe, expect, it } from "vitest";
import type { CardRecord } from "@/contracts";
import { createCanvasStore, type CanvasStore } from "@/state/canvasStore";

/**
 * Phase 1.1 (BUG 1): an envelope containing card.create asks the view for a
 * one-shot fit when the relayouted bounds overflow this window's viewport.
 */
const card = (id: string, width = 264): CardRecord => ({
  id,
  type: "TodoCard",
  variant: "minimal",
  displayProps: { items: [{ id: `${id}-t1`, text: "task", done: false }] },
  sourceData: {},
  sources: [],
  layout: { x: 0, y: 0, width, height: 120, pinned: false },
  metadata: {
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
  },
});

let seq = 0;
const env = (actions: object[]) => ({
  schemaVersion: "0.6" as const,
  requestId: `fit-${(seq += 1)}`,
  canvasId: "c",
  actions: actions as never,
});

describe("auto fit after card.create", () => {
  let store: CanvasStore = createCanvasStore();

  const smallScreen = () =>
    store.internal({ type: "canvas.viewportSize", width: 800, height: 600 });

  beforeEach(() => {
    store = createCanvasStore();
  });

  it("3 cards overflowing the viewport request exactly one fit, idempotently", () => {
    smallScreen();
    const envelope = env([
      { type: "card.create", card: card("a") },
      { type: "card.create", card: card("b") },
      { type: "card.create", card: card("c") },
    ]);
    store.dispatch(envelope);
    const requestId = (envelope as { requestId: string }).requestId;
    expect(store.getState().cards).toHaveLength(3);
    expect(store.getState().lastFitRequestId).toBe(requestId);
    // Replays of the same envelope must not stack more fit requests.
    const result = store.dispatch(envelope);
    expect(result).toEqual({ ok: true, deduplicated: true });
    expect(store.getState().lastFitRequestId).toBe(requestId);
  });

  it("cards that already fit leave the camera alone", () => {
    store.internal({ type: "canvas.viewportSize", width: 1440, height: 900 });
    store.dispatch(
      env([
        { type: "card.create", card: card("a") },
        { type: "card.create", card: card("b") },
        { type: "card.create", card: card("c") },
      ]),
    );
    expect(store.getState().lastFitRequestId).toBeNull();
  });

  it("card.focus in the same envelope wins (no fit)", () => {
    smallScreen();
    store.dispatch(env([{ type: "card.create", card: card("a") }]));
    expect(store.getState().lastFitRequestId).toBeNull(); // single card fits 800px
    store.dispatch(
      env([
        { type: "card.create", card: card("b") },
        { type: "card.create", card: card("c") },
        { type: "card.focus", targetId: "c" },
      ]),
    );
    expect(store.getState().lastFitRequestId).toBeNull();
    expect(store.getState().focus?.cardId).toBe("c");
  });

  it("a prior focus suppresses the auto-fit", () => {
    smallScreen();
    store.dispatch(env([{ type: "card.create", card: card("a") }]));
    store.dispatch(env([{ type: "card.focus", targetId: "a" }]));
    store.dispatch(
      env([
        { type: "card.create", card: card("b") },
        { type: "card.create", card: card("c") },
        { type: "card.create", card: card("d") },
      ]),
    );
    expect(store.getState().lastFitRequestId).toBeNull();
    expect(store.getState().focus?.cardId).toBe("a");
  });

  it("without a measured viewportSize the reducer stays hands-off", () => {
    store.dispatch(
      env([
        { type: "card.create", card: card("a") },
        { type: "card.create", card: card("b") },
        { type: "card.create", card: card("c") },
      ]),
    );
    expect(store.getState().lastFitRequestId).toBeNull();
  });
});
