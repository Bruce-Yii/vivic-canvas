import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardRecord } from "@/contracts";
import { presentCards } from "@/canvas/reminderPresentation";
import { createMemoryDB } from "@/persistence/db";
import { fromCanvasRecord } from "@/persistence/canvasRecord";
import { createCanvasStore } from "@/state/canvasStore";
import { createMemoryHub, flushChannel } from "../channel";
import { createControlHost } from "../controlHost";
import { createDisplayClient } from "../displayClient";
import { DisplayInteractionSchema, type SyncMessage } from "../protocol";
import { createMemoryLockProvider } from "../testing";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(stop => stop()); vi.useRealTimers(); });
const stamp = "2026-10-17T00:00:00.000Z";
const quote = (id: string, x = 0): CardRecord => ({ id, type: "QuoteCard", variant: "standard", displayProps: { text: `TEST ${id}` }, sourceData: {}, sources: [],
  layout: { x, y: 0, width: 320, height: 220, pinned: false }, metadata: { createdAt: stamp, updatedAt: stamp } });

const setup = async (surface?: "user") => {
  const hub = createMemoryHub(), db = createMemoryDB();
  const store = createCanvasStore();
  const host = createControlHost({ db, store, channel: hub.createChannel(), lockProvider: createMemoryLockProvider(), reminderPollMs: 1000000 });
  cleanup.push(host.stop); await host.start();
  const canvasId = host.getSnapshot().activeCanvasId!;
  const seedCards = [quote("a"), quote("b")].map(card => surface ? { ...card, layout: { ...card.layout, surface } } : card);
  host.dispatch({ schemaVersion: "0.6", canvasId, requestId: "seed", actions: seedCards.map(card => ({ type: "card.create", card })) });
  await flushChannel();
  const displayStore = createCanvasStore();
  const client = createDisplayClient({ db, store: displayStore, channel: hub.createChannel(), pinnedCanvasId: canvasId });
  cleanup.push(client.stop); await client.start(); await flushChannel();
  const find = (s: ReturnType<typeof createCanvasStore>, id: string) => s.getState().cards.find(entry => entry.record.id === id)!.record;
  return { hub, db, host, store, displayStore, client, canvasId, find };
};

describe("cards move between the Display canvas and the user page", () => {
  it("reveals a standby canvas when a user card is deliberately sent to Display", async () => {
    const { db, host, store, displayStore, canvasId } = await setup("user");
    expect(store.getState().stage).toBe("STANDBY");
    expect(host.setCardSurface("a", "user").ok).toBe(true);
    expect(store.getState().stage).toBe("STANDBY");
    expect(host.setCardSurface("a", "display").ok).toBe(true);
    await flushChannel();
    expect(store.getState().stage).toBe("AWAKENING");
    expect(displayStore.getState().stage).toBe("AWAKENING");
    expect(store.getState().awakenedAt).toBeGreaterThan(0);
    expect(fromCanvasRecord((await db.getCanvas(canvasId))!).stage).toBe("WORKSPACE");
  });
  it("sends a card to the user page: off the canvas layout, persisted, synced to Display", async () => {
    const { db, host, store, displayStore, canvasId, find } = await setup();
    const before = find(store, "b").layout;
    expect(host.setCardSurface("a", "user").ok).toBe(true);
    await flushChannel();
    expect(find(store, "a").layout.surface).toBe("user");
    expect(find(displayStore, "a").layout.surface).toBe("user");
    expect(presentCards(displayStore.getState().cards).map(item => item.entry.record.id)).toEqual(["b"]);
    expect(find(store, "b").layout).toEqual(before);
    expect((await db.getCanvas(canvasId))!.cardsById.a!.layout.surface).toBe("user");
  });

  it("puts it back exactly where the Display drop happened, through the owner", async () => {
    const { host, store, displayStore, client, canvasId, find } = await setup();
    host.setCardSurface("a", "user"); await flushChannel();
    expect(client.requestCardToCanvas(canvasId, "a", 640, 320)).toBe(true);
    await flushChannel();
    expect(find(store, "a").layout).toMatchObject({ x: 640, y: 320 });
    expect(find(store, "a").layout.surface).toBeUndefined();
    expect(find(displayStore, "a").layout).toMatchObject({ x: 640, y: 320 });
    expect(presentCards(displayStore.getState().cards)).toHaveLength(2);
  });

  it("auto-places a card sent back without a drop point and leaves other cards alone", async () => {
    const { host, store, find } = await setup();
    host.setCardSurface("a", "user");
    const other = find(store, "b").layout;
    expect(host.setCardSurface("a", "display").ok).toBe(true);
    expect(find(store, "b").layout).toEqual(other);
    const a = find(store, "a").layout;
    const overlaps = a.x < other.x + other.width && a.x + a.width > other.x && a.y < other.y + other.height && a.y + a.height > other.y;
    expect(overlaps).toBe(false);
  });

  it("permits narrow portal and view requests without granting pin or arbitrary action authority", async () => {
    const from = { x: 0, y: 0, width: 320, height: 220, pinned: false };
    expect(DisplayInteractionSchema.safeParse({ kind: "card.surface", cardId: "a", from, surface: "display", x: 1, y: 2 }).success).toBe(true);
    expect(DisplayInteractionSchema.safeParse({ kind: "card.surface", cardId: "a", from, surface: "user" }).success).toBe(true);
    expect(DisplayInteractionSchema.safeParse({ kind: "card.surface", cardId: "a", from, surface: "display" }).success).toBe(true);
    expect(DisplayInteractionSchema.safeParse({ kind: "card.focus", cardId: "a", from }).success).toBe(true);
    expect(DisplayInteractionSchema.safeParse({ kind: "canvas.fit" }).success).toBe(true);
    expect(DisplayInteractionSchema.safeParse({ kind: "canvas.restore" }).success).toBe(true);
    expect(DisplayInteractionSchema.safeParse({ kind: "canvas.fit", actions: [{ type: "card.delete", targetId: "a" }] }).success).toBe(false);
    expect(DisplayInteractionSchema.safeParse({ kind: "card.pin", cardId: "a", from, pinned: true }).success).toBe(false);
    const { client, canvasId } = await setup();
    // A card that is already on the canvas is not "returned".
    expect(client.requestCardToCanvas(canvasId, "a", 10, 10)).toBe(false);
  });

  it("transfers through cross-tab portal buttons, confirms by sync, and keeps pinned neighbours fixed", async () => {
    const { db, host, store, displayStore, client, canvasId, find } = await setup();
    host.setCardPinned("b", true); await flushChannel();
    const pinned = find(store, "b").layout;
    expect(client.requestCardSurface("a", "user")).toBe(true);
    expect(find(displayStore, "a").layout.surface).toBeUndefined();
    await flushChannel();
    expect(find(store, "a").layout.surface).toBe("user");
    expect(find(displayStore, "a").layout.surface).toBe("user");
    expect(client.beginCardDrag("a")).toBeNull();
    expect(client.requestCardSurface("a", "user")).toBe(false);
    expect(client.requestCardFocus("a")).toBe(false);
    expect(client.requestCardSurface("a", "display")).toBe(true);
    await flushChannel();
    expect(find(displayStore, "a").layout.surface).toBeUndefined();
    expect(find(store, "b").layout).toEqual(pinned);
    const returned = find(store, "a").layout;
    expect(returned.x < pinned.x + pinned.width && returned.x + returned.width > pinned.x &&
      returned.y < pinned.y + pinned.height && returned.y + returned.height > pinned.y).toBe(false);
    expect((await db.getCanvas(canvasId))!.cardsById.a!.layout).toEqual(returned);
    expect(client.requestCardSurface("missing", "user")).toBe(false);
  });

  it("rejects stale transfers, same-surface coordinate moves, and drags arriving after a portal transfer", async () => {
    const { hub, db, host, store, client, canvasId, find } = await setup();
    const channel = hub.createChannel(), drag = client.beginCardDrag("a")!;
    const msg: SyncMessage = { type: "interaction", canvasId, epoch: "reader", version: drag.version, seq: 0,
      requestId: "stale-portal", payload: { ownerEpoch: drag.ownerEpoch,
        interaction: { kind: "card.surface", cardId: "a", from: drag.from, surface: "user" } } };
    host.setCardPinned("b", true); await flushChannel();
    const puts = vi.spyOn(db, "putCanvas");
    channel.post(msg); await flushChannel();
    expect(find(store, "a").layout.surface).toBeUndefined();
    expect(puts).not.toHaveBeenCalled();
    channel.post({ ...msg, version: client.getStatus().version!, requestId: "same-surface",
      payload: { ...msg.payload, interaction: { kind: "card.surface", cardId: "a", from: drag.from, surface: "display", x: 999, y: 999 } } });
    await flushChannel(); expect(puts).not.toHaveBeenCalled();
    expect(client.requestCardSurface("a", "user")).toBe(true); await flushChannel(); puts.mockClear();
    channel.post({ ...msg, requestId: "late-drag", payload: { ...msg.payload,
      interaction: { kind: "card.move", cardId: "a", from: drag.from, x: 999, y: 999 } } });
    await flushChannel();
    expect(find(store, "a").layout).toMatchObject({ ...drag.from, surface: "user" });
    expect(puts).not.toHaveBeenCalled();
  });

  it("focuses, restores, fits all cards, and clears focus when the focused card leaves", async () => {
    const { host, store, displayStore, client, find } = await setup();
    expect(client.requestCardFocus("a")).toBe(true);
    expect(displayStore.getState().focus).toBeNull(); await flushChannel();
    expect(store.getState().focus?.cardId).toBe("a");
    expect(displayStore.getState().focus?.cardId).toBe("a");
    expect(client.requestFocusRestore()).toBe(true); await flushChannel();
    expect(displayStore.getState().focus).toBeNull();
    client.requestCardFocus("b"); await flushChannel();
    const before = displayStore.getState().lastFitRequestId;
    expect(client.requestCanvasFit()).toBe(true); await flushChannel();
    expect(displayStore.getState().focus).toBeNull();
    expect(displayStore.getState().lastFitRequestId).not.toBe(before);
    client.requestCardFocus("a"); await flushChannel();
    client.requestCardSurface("a", "user"); await flushChannel();
    expect(displayStore.getState().focus).toBeNull();
    expect(find(store, "a").layout.surface).toBe("user");
    expect(host.getSnapshot().ownerMode).toBe("owner");
  });

  it("keeps pinned inactive-canvas portal/view requests on their target without switching the owner", async () => {
    const { db, host, store, displayStore, client, canvasId } = await setup();
    const other = host.createCanvas("Other"); host.switchCanvas(other); await flushChannel();
    expect(client.requestCardFocus("a")).toBe(true); await flushChannel();
    expect(displayStore.getState().focus?.cardId).toBe("a");
    expect(host.getSnapshot().activeCanvasId).toBe(other);
    expect(store.getState().cards).toHaveLength(0);
    client.requestCanvasFit(); await flushChannel();
    expect(displayStore.getState().focus).toBeNull();
    expect(displayStore.getState().lastFitRequestId).toBeTruthy();
    client.requestCardFocus("b"); await flushChannel();
    client.requestFocusRestore(); await flushChannel();
    expect(displayStore.getState().focus).toBeNull();
    client.requestCardSurface("a", "user"); await flushChannel();
    client.requestCardSurface("a", "display"); await flushChannel();
    expect((await db.getCanvas(canvasId))!.cardsById.a!.layout.surface).toBeUndefined();
    expect(host.getSnapshot().activeCanvasId).toBe(other);
  });

  it("rejects stale view requests, duplicates, missing cards, and foreign owner/canvas messages", async () => {
    const { hub, db, host, store, client, canvasId } = await setup();
    const channel = hub.createChannel(), drag = client.beginCardDrag("a")!;
    const msg: SyncMessage = { type: "interaction", canvasId, epoch: "reader", version: drag.version, seq: 0,
      requestId: "focus-request", payload: { ownerEpoch: drag.ownerEpoch,
        interaction: { kind: "card.focus", cardId: "a", from: drag.from } } };
    const puts = vi.spyOn(db, "putCanvas");
    channel.post({ ...msg, canvasId: "missing" });
    channel.post({ ...msg, payload: { ...msg.payload, ownerEpoch: "old-owner" } });
    channel.post({ ...msg, payload: { ...msg.payload, interaction: { kind: "card.focus", cardId: "missing", from: drag.from } } });
    await flushChannel(); expect(puts).not.toHaveBeenCalled();
    channel.post(msg); channel.post(msg); await flushChannel();
    expect(store.getState().focus?.cardId).toBe("a"); expect(puts).toHaveBeenCalledTimes(1);
    puts.mockClear();
    channel.post({ ...msg, requestId: "stale-fit", payload: { ...msg.payload, interaction: { kind: "canvas.fit" } } });
    await flushChannel(); expect(store.getState().focus?.cardId).toBe("a"); expect(puts).not.toHaveBeenCalled();
    host.stop(); await flushChannel();
    expect(client.requestCardSurface("a", "user")).toBe(false);
    expect(client.requestCardFocus("a")).toBe(false);
    expect(client.requestCanvasFit()).toBe(false);
    expect(client.requestFocusRestore()).toBe(false);
    expect(puts).not.toHaveBeenCalled();
  });

  it("keeps the user-page drop point, moves it there, and forgets it when the card returns", async () => {
    const { host, store, find } = await setup();
    const canvasSpot = { x: find(store, "a").layout.x, y: find(store, "a").layout.y };
    expect(host.setCardSurface("a", "user", { x: 420.4, y: 180 }).ok).toBe(true);
    expect(find(store, "a").layout).toMatchObject({ surface: "user", userPos: { x: 420, y: 180 }, ...canvasSpot });
    expect(host.setCardSurface("a", "user", { x: 60, y: 90 }).ok).toBe(true);
    expect(find(store, "a").layout.userPos).toEqual({ x: 60, y: 90 });
    expect(host.setCardSurface("a", "display", { x: 700, y: 40 }).ok).toBe(true);
    expect(find(store, "a").layout).toMatchObject({ x: 700, y: 40 });
    expect(find(store, "a").layout.userPos).toBeUndefined();
    expect(find(store, "a").layout.surface).toBeUndefined();
  });

  it("never dims the stage for a focus on a user-page card", async () => {
    const { host, store, canvasId } = await setup();
    host.setCardSurface("a", "user");
    host.dispatch({ schemaVersion: "0.6", canvasId, requestId: "focus", actions: [{ type: "card.focus", targetId: "a" }] });
    expect(store.getState().focus).toBeNull();
  });
});
