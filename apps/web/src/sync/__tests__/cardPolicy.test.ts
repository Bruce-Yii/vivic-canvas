import { afterEach, describe, expect, it } from "vitest";
import { TravelOffersCardSchema } from "@/contracts";
import { buildSceneFixtures } from "@/cards/scene/fixtures";
import { testCards } from "@/cards/__tests__/fixtures";
import { createMemoryDB } from "@/persistence/db";
import { createCanvasStore } from "@/state/canvasStore";
import { createMemoryHub } from "../channel";
import { createMemoryLockProvider } from "../testing";
import { createControlHost, type ControlHost } from "../controlHost";
import { envelopeCardPolicyIssue } from "../cardPolicy";

const stops: ControlHost[] = [];
afterEach(() => stops.splice(0).forEach(host => host.stop()));
const travel = () => TravelOffersCardSchema.parse(buildSceneFixtures().travel_offers);
const env = (actions: unknown[]) => ({ schemaVersion: "0.6", requestId: "TEST-policy", canvasId: "TEST-canvas", actions });
const setup = async (travelRefresh?: Parameters<typeof createControlHost>[0]["travelRefresh"], initialRecords?: unknown[]) => {
  const db = createMemoryDB(initialRecords), store = createCanvasStore(), hub = createMemoryHub();
  const host = createControlHost({ db, store, channel: hub.createChannel(), lockProvider: createMemoryLockProvider(), reminderPollMs: 1e6, travelRefresh });
  stops.push(host); await host.start();
  let sequence = 0;
  const send = (actions: unknown[]) => host.dispatch({ ...env(actions), requestId: `TEST-${++sequence}`, canvasId: host.getSnapshot().activeCanvasId });
  return { host, db, store, send };
};

describe("owner field policy and provider refresh", () => {
  it("rejects an entire batch changing service facts, including delete/recreate bypasses, while allowing personal notes", async () => {
    const { host, store, send } = await setup(), card = travel();
    expect(send([{ type: "card.create", card }]).ok).toBe(true);
    const before = store.getState();
    const forged = { ...card, displayProps: { ...card.displayProps, mode: "live", items: card.displayProps.items.map(item => ({ ...item, price: { amount: 1, currency: "CNY" } })) } };
    expect(send([{ type: "card.create", card: testCards.NoteCard }, { type: "card.update", targetId: card.id, displayProps: forged.displayProps }]).ok).toBe(false);
    expect(store.getState()).toBe(before);
    expect(send([{ type: "card.delete", targetId: card.id }, { type: "card.create", card: forged }]).ok).toBe(false);
    expect(send([{ type: "card.update", targetId: card.id, displayProps: { notes: "TEST personal note" } }]).ok).toBe(true);
    expect(store.getState().cards[0]!.record.displayProps).toMatchObject({ notes: "TEST personal note", mode: "demo" });
    expect(host.exportActiveCanvas()).toContain("TEST personal note");
  });
  it("accepts only the newest refresh and preserves notes changed while the query was pending", async () => {
    const waits: Array<(value: { ok: true; card: ReturnType<typeof travel> }) => void> = [];
    const { host, store, send } = await setup(() => new Promise(resolve => waits.push(resolve)));
    const card = travel(); send([{ type: "card.create", card }]);
    const first = host.refreshTravelCard(card.id), second = host.refreshTravelCard(card.id);
    send([{ type: "card.update", targetId: card.id, displayProps: { notes: "TEST latest note" } }]);
    const newer = { ...card, sourceData: { ...card.sourceData, requestId: "TEST-newest" } };
    waits[1]!({ ok: true, card: newer }); expect((await second).ok).toBe(true);
    waits[0]!({ ok: true, card: { ...card, sourceData: { ...card.sourceData, requestId: "TEST-stale" } } });
    expect((await first).ok).toBe(false);
    expect(store.getState().cards[0]!.record).toMatchObject({ sourceData: { requestId: "TEST-newest" }, displayProps: { notes: "TEST latest note" } });
  });
  it("drops a refresh after switching canvas and retains the original canvas", async () => {
    let resolve!: (value: { ok: true; card: ReturnType<typeof travel> }) => void;
    const { host, store, send } = await setup(() => new Promise(done => { resolve = done; }));
    const card = travel(); send([{ type: "card.create", card }]);
    const pending = host.refreshTravelCard(card.id), nextId = host.createCanvas("TEST other"); host.switchCanvas(nextId);
    resolve({ ok: true, card }); expect((await pending).ok).toBe(false);
    expect(store.getState().cards).toEqual([]);
  });
  it("rejects a provider response for a different query without changing the original card", async () => {
    const card = travel();
    const { host, store, send } = await setup(async () => ({ ok: true, card: { ...card,
      displayProps: { ...card.displayProps, query: { ...card.displayProps.query, destination: "北京" } } } }));
    send([{ type: "card.create", card }]);
    const before = store.getState();
    expect((await host.refreshTravelCard(card.id)).ok).toBe(false);
    expect(store.getState()).toBe(before);
  });
  it("never applies an old result after switching A to B and back to A", async () => {
    let resolve!: (value: { ok: true; card: ReturnType<typeof travel> }) => void;
    const { host, store, send } = await setup(() => new Promise(done => { resolve = done; }));
    const card = travel(); send([{ type: "card.create", card }]);
    const firstId = host.getSnapshot().activeCanvasId!, pending = host.refreshTravelCard(card.id);
    const otherId = host.createCanvas("TEST B"); host.switchCanvas(otherId); host.switchCanvas(firstId);
    const before = store.getState();
    resolve({ ok: true, card: { ...card, sourceData: { ...card.sourceData, requestId: "TEST-too-late" } } });
    expect((await pending).ok).toBe(false); expect(store.getState()).toBe(before);
  });
  it("does not attach a deleted card's pending result to a new card with the same id and query", async () => {
    let resolve!: (value: { ok: true; card: ReturnType<typeof travel> }) => void;
    const { host, store, send } = await setup(() => new Promise(done => { resolve = done; }));
    const card = travel(); send([{ type: "card.create", card }]);
    const pending = host.refreshTravelCard(card.id);
    send([{ type: "card.delete", targetId: card.id }]);
    send([{ type: "card.create", card }]);
    const before = store.getState();
    resolve({ ok: true, card: { ...card, sourceData: { ...card.sourceData, requestId: "TEST-deleted" } } });
    expect((await pending).ok).toBe(false); expect(store.getState()).toBe(before);
  });
  it("blocks extension creation without an exact enabled definition", () => {
    const envelope = { schemaVersion: "0.6" as const, requestId: "TEST", canvasId: "TEST", actions: [{ type: "card.create" as const, card: testCards.ExtensionCard }] };
    expect(envelopeCardPolicyIssue(envelope, [], () => ({ ok: false, error: "missing definition" }))).toBe("missing definition");
  });
  it("keeps recovery visible through actual owner edits and exports the original incompatible data", async () => {
    const invalid = { id: "TEST-future", type: "FutureCard", displayProps: { payload: "TEST retained" } };
    const record = { id: "TEST-recovered", title: "TEST recovery", version: 0, updatedAt: "2026-10-01T00:00:00.000Z",
      cardsById: { [testCards.NoteCard.id]: testCards.NoteCard, [invalid.id]: invalid }, cardOrder: [testCards.NoteCard.id, invalid.id],
      viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [] };
    const { host, send } = await setup(undefined, [record]);
    expect(host.getSnapshot().recovery?.quarantinedCardCount).toBe(1);
    expect(send([{ type: "card.update", targetId: testCards.NoteCard.id, displayProps: { text: "TEST changed" } }]).ok).toBe(true);
    expect(host.getSnapshot().recovery?.quarantinedCardCount).toBe(1);
    const exported = JSON.parse(host.exportActiveCanvas());
    expect(exported.canvas.recovery.quarantinedCards[invalid.id]).toEqual(invalid);
    expect(exported.canvas.recovery.rawRecord).toEqual(record);
  });
});
