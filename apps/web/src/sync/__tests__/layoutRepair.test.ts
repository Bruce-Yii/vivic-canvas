import { afterEach, describe, expect, it } from "vitest";
import { createMemoryDB } from "@/persistence/db";
import { toCanvasRecord, emptyVivicState } from "@/persistence/canvasRecord";
import { createCanvasStore, hasUnpinnedOverlap, type CardState } from "@/state/canvasStore";
import { createMemoryHub, flushChannel } from "../channel";
import { createMemoryLockProvider } from "../testing";
import { createControlHost } from "../controlHost";
import { createDisplayClient } from "../displayClient";
import { testCards } from "@/cards/__tests__/fixtures";

const stops: Array<() => void> = [];
afterEach(() => stops.splice(0).forEach(stop => stop()));
const legacy = (): CardState[] => [testCards.NoteCard, testCards.ChartCard, testCards.TableCard, testCards.SearchResultCard].map((record, index) => ({
  record: { ...record, layout: { ...record.layout, x: index % 3 * 308, y: Math.floor(index / 3) * 180 } },
}));

describe("owner-only repair of legacy overlapping canvases", () => {
  it("repairs saved overlaps once, persists the new revision and gives replicas the same layout", async () => {
    const db = createMemoryDB(), hub = createMemoryHub(), locks = createMemoryLockProvider();
    const original = toCanvasRecord("legacy", "TEST old overlapping board", 7, { ...emptyVivicState(), cards: legacy() });
    await db.putCanvas(original); await db.setMeta("lastCanvasId", "legacy");
    const store = createCanvasStore();
    const host = createControlHost({ db, store, channel: hub.createChannel(), lockProvider: locks, reminderPollMs: 1000000 });
    stops.push(host.stop); await host.start();
    expect(hasUnpinnedOverlap(store.getState().cards)).toBe(false);
    expect(store.getState().cards.map(entry => entry.record.displayProps)).toEqual(legacy().map(entry => entry.record.displayProps));
    expect((await db.getCanvas("legacy"))!.version).toBe(8);
    expect(store.getState().lastFitRequestId).toBeTruthy();
    const displayStore = createCanvasStore();
    const display = createDisplayClient({ db, store: displayStore, channel: hub.createChannel(), pinnedCanvasId: "legacy" });
    stops.push(display.stop); await display.start(); await flushChannel();
    expect(displayStore.getState().cards).toEqual(store.getState().cards);
    const readonlyStore = createCanvasStore();
    const readonly = createControlHost({ db, store: readonlyStore, channel: hub.createChannel(), lockProvider: locks, reminderPollMs: 1000000 });
    stops.push(readonly.stop); await readonly.start();
    expect(readonly.getSnapshot().ownerMode).toBe("readonly");
    expect(readonly.arrangeCanvas()).toEqual({ ok: false, error: "readonly-not-owner" });
    expect((await db.getCanvas("legacy"))!.version).toBe(8);
  });
  it("explicit arrange preserves pin coordinates and persists before publishing the new layout", async () => {
    const db = createMemoryDB(), hub = createMemoryHub(); const store = createCanvasStore();
    const host = createControlHost({ db, store, channel: hub.createChannel(), lockProvider: createMemoryLockProvider(), reminderPollMs: 1000000 });
    stops.push(host.stop); await host.start(); const id = host.getSnapshot().activeCanvasId!;
    const cards = legacy(); cards[0] = { record: { ...cards[0].record, layout: { ...cards[0].record.layout, pinned: true, x: 0, y: 0 } } };
    store.loadState({ ...emptyVivicState(), stage: "WORKSPACE", cards });
    expect(host.arrangeCanvas().ok).toBe(true); await flushChannel();
    expect(hasUnpinnedOverlap(store.getState().cards)).toBe(false);
    expect(store.getState().cards[0].record.layout).toEqual(cards[0].record.layout);
    expect((await db.getCanvas(id))!.cardsById["TEST-chart"].layout).toEqual(store.getState().cards[1].record.layout);
  });
});
