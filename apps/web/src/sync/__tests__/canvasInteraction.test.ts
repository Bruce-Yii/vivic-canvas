import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardRecord } from "@/contracts";
import { createMemoryDB } from "@/persistence/db";
import { createCanvasStore } from "@/state/canvasStore";
import { createMemoryHub, flushChannel } from "../channel";
import { createControlHost } from "../controlHost";
import { createDisplayClient } from "../displayClient";
import { parseSyncMessage, type SyncMessage } from "../protocol";
import { createMemoryLockProvider } from "../testing";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(stop => stop()); vi.useRealTimers(); });
const card = (id: string): CardRecord => ({ id, type: "TodoCard", variant: "minimal",
  displayProps: { items: [{ id: `${id}-task`, text: id, done: false }] }, sourceData: {}, sources: [],
  layout: { x: 0, y: 0, width: 260, height: 120, pinned: false },
  metadata: { createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" },
});
const setup = async () => {
  const hub = createMemoryHub(), db = createMemoryDB(), locks = createMemoryLockProvider();
  const store = createCanvasStore();
  const host = createControlHost({ db, store, channel: hub.createChannel(), lockProvider: locks, reminderPollMs: 1000000 });
  cleanup.push(host.stop); await host.start();
  const canvasId = host.getSnapshot().activeCanvasId!;
  let request = 0;
  const send = (actions: object[]) => host.dispatch({ schemaVersion: "0.6", canvasId,
    requestId: `action-${++request}`, actions });
  send([{ type: "card.create", card: card("a") }]); await flushChannel();
  const displays = async (pinned = canvasId) => {
    const displayStore = createCanvasStore();
    const client = createDisplayClient({ db, store: displayStore, channel: hub.createChannel(), pinnedCanvasId: pinned });
    cleanup.push(client.stop); await client.start(); await flushChannel();
    return { client, displayStore };
  };
  const { client, displayStore } = await displays();
  return { hub, db, locks, host, store, canvasId, send, client, displayStore, displays };
};
const layout = (store: ReturnType<typeof createCanvasStore>) => store.getState().cards[0]!.record.layout;

describe("owner-confirmed canvas interactions", () => {
  it("moves through the owner, persists before broadcasting, and survives display reload", async () => {
    const { db, host, store, client, displayStore, canvasId, displays } = await setup();
    const put = db.putCanvas;
    let release!: () => void;
    db.putCanvas = async record => { await new Promise<void>(r => { release = r; }); await put(record); };
    const drag = client.beginCardDrag("a")!;
    expect(client.requestCardMove(drag, 135, -45)).toBe(true);
    expect(layout(displayStore).x).toBe(0); // preview never enters persisted state
    await flushChannel();
    expect(layout(store).x).toBe(135);
    expect(layout(displayStore).x).toBe(0);
    expect((await db.getCanvas(canvasId))!.cardsById.a!.layout.x).toBe(0);
    db.putCanvas = put; release(); await flushChannel();
    expect(layout(displayStore)).toMatchObject({ x: 135, y: -45, pinned: false });
    expect((await db.getCanvas(canvasId))!.cardsById.a!.layout.x).toBe(135);
    const revived = await displays();
    expect(layout(revived.displayStore)).toEqual(layout(store));
    expect(host.getSnapshot().ownerMode).toBe("owner");
  });

  it("rejects concurrent drags from the same baseline and stale moves after pin", async () => {
    const { host, store, client, displays } = await setup();
    const other = await displays();
    const first = client.beginCardDrag("a")!, second = other.client.beginCardDrag("a")!;
    client.requestCardMove(first, 90, 80); other.client.requestCardMove(second, 900, 800);
    await flushChannel();
    expect(layout(store)).toMatchObject({ x: 90, y: 80 });
    expect(layout(other.displayStore)).toEqual(layout(store));
    const stale = client.beginCardDrag("a")!;
    expect(host.setCardPinned("a", true).ok).toBe(true);
    client.requestCardMove(stale, 500, 500); await flushChannel();
    expect(layout(store)).toMatchObject({ x: 90, y: 80, pinned: true });
    expect(client.beginCardDrag("a")).toBeNull();
    expect(host.moveCard("a", 1, 2)).toEqual({ ok: false, error: "card-pinned" });
    host.setCardPinned("a", false); await flushChannel();
    expect(client.beginCardDrag("a")).not.toBeNull();
  });

  it("keeps pin through create/delete/undo/fit and preserves exact moved layout on undo", async () => {
    const { host, store, send, displayStore, db, canvasId } = await setup();
    host.moveCard("a", 415, -170); host.setCardPinned("a", true);
    send([{ type: "card.create", card: card("b") }, { type: "canvas.fit" }]);
    send([{ type: "card.create", card: card("a") }]); // upsert cannot silently unpin
    await flushChannel();
    expect(layout(store)).toMatchObject({ x: 415, y: -170, pinned: true });
    send([{ type: "card.delete", targetId: "a" }]);
    expect(host.undo()).toBe(true); await flushChannel();
    expect(layout(store)).toMatchObject({ x: 415, y: -170, pinned: true });
    expect(layout(displayStore)).toEqual(layout(store));
    expect((await db.getCanvas(canvasId))!.cardsById.a!.layout).toEqual(layout(store));
    host.setCardPinned("a", false); host.moveCard("a", 11, 22);
    send([{ type: "card.delete", targetId: "a" }]); host.undo(); await flushChannel();
    expect(layout(displayStore)).toMatchObject({ x: 11, y: 22, pinned: false });
  });

  it("routes pinned inactive-canvas moves without changing the owner's canvas or following display", async () => {
    const { host, store, client, canvasId, db, displays } = await setup();
    const following = await displays("");
    const other = host.createCanvas("Other"); host.switchCanvas(other); await flushChannel();
    expect(following.client.getStatus().canvasId).toBe(other);
    const drag = client.beginCardDrag("a")!;
    expect(drag.canvasId).toBe(canvasId);
    expect(client.requestCardMove(drag, 80, 70)).toBe(true); await flushChannel();
    expect(host.getSnapshot().activeCanvasId).toBe(other);
    expect(store.getState().cards).toHaveLength(0);
    expect((await db.getCanvas(canvasId))!.cardsById.a!.layout.x).toBe(80);
    expect(following.client.getStatus().canvasId).toBe(other);
    host.switchCanvas(canvasId); await flushChannel();
    expect(layout(store)).toMatchObject({ x: 80, y: 70 });
  });

  it("rejects wrong canvas/owner, nonfinite coordinates, unknown fields and replayed interactions", async () => {
    const { hub, client, store, canvasId, host, db } = await setup();
    const channel = hub.createChannel(), drag = client.beginCardDrag("a")!;
    const msg: SyncMessage = { type: "interaction", canvasId, epoch: "reader", version: drag.version,
      seq: 0, requestId: drag.requestId, payload: { ownerEpoch: drag.ownerEpoch,
        interaction: { kind: "card.move", cardId: "a", from: drag.from, x: 10, y: 20 } } };
    const puts = vi.spyOn(db, "putCanvas");
    channel.post({ ...msg, canvasId: "missing" });
    channel.post({ ...msg, payload: { ...msg.payload, ownerEpoch: "old-owner" } });
    for (const x of [Infinity, NaN, 100001]) {
      const invalid = { ...msg, payload: { ...msg.payload, interaction: { ...msg.payload.interaction, x } } };
      expect(parseSyncMessage(invalid)).toBeNull(); channel.post(invalid);
    }
    expect(parseSyncMessage({ ...msg, payload: { ...msg.payload, extra: "secret" } })).toBeNull();
    expect(parseSyncMessage({ ...msg, payload: { ...msg.payload, interaction: { kind: "card.pin", cardId: "a", from: drag.from, pinned: true } } })).toBeNull();
    await flushChannel(); expect(puts).not.toHaveBeenCalled();
    channel.post(msg); channel.post(msg); await flushChannel();
    expect(layout(store)).toMatchObject({ x: 10, y: 20 });
    expect(host.getSnapshot().canvases.find(c => c.id === canvasId)!.version).toBe(drag.version + 1);
    expect(puts).toHaveBeenCalledTimes(1);
  });

  it("bounds interaction volume globally even when senders rotate IDs", async () => {
    const { hub, client, host, canvasId } = await setup();
    const channel = hub.createChannel(), drag = client.beginCardDrag("a")!;
    const before = host.getSnapshot().canvases.find(c => c.id === canvasId)!.version;
    for (let i = 0; i < 40; i++) channel.post({ type: "interaction", canvasId, epoch: `reader-${i}`,
      seq: 0, version: drag.version, requestId: `flood-${i}`,
      payload: { ownerEpoch: drag.ownerEpoch, interaction: { kind: "card.move", cardId: "a", from: drag.from, x: drag.from.x, y: drag.from.y } } });
    await flushChannel();
    expect(host.getSnapshot().canvases.find(c => c.id === canvasId)!.version - before).toBe(24);
  });

  it("never writes from a readonly controller or display; takeover resyncs and invalidates old drags", async () => {
    const { hub, locks, host, client, db, canvasId, displayStore } = await setup();
    const reader = createControlHost({ db, store: createCanvasStore(), channel: hub.createChannel(), lockProvider: locks });
    cleanup.push(reader.stop); const puts = vi.spyOn(db, "putCanvas"), metas = vi.spyOn(db, "setMeta");
    await reader.start(); expect(puts).not.toHaveBeenCalled(); expect(metas).not.toHaveBeenCalled();
    expect(reader.setCardPinned("a", true).ok).toBe(false);
    expect(reader.setPreferences({ theme: "dark" }).ok).toBe(false);
    expect(reader.moveCard("a", 1, 2).ok).toBe(false);
    reader.renameCanvas(canvasId, "bad"); reader.deleteCanvas(canvasId); reader.clearActiveCanvas(); reader.importCanvas(host.exportActiveCanvas());
    expect(puts).not.toHaveBeenCalled(); expect(metas).not.toHaveBeenCalled();
    const old = client.beginCardDrag("a")!;
    reader.takeover(); await flushChannel(); await flushChannel();
    expect(reader.getSnapshot().ready).toBe(true);
    expect(client.requestCardMove(old, 99, 99)).toBe(false);
    const fresh = client.beginCardDrag("a")!;
    expect(client.requestCardMove(fresh, 33, 44)).toBe(true); await flushChannel();
    expect(layout(displayStore)).toMatchObject({ x: 33, y: 44 });
    host.stop(); await flushChannel(); // old owner's off cannot disconnect new owner
    expect(client.getStatus().canInteract).toBe(true);
    reader.stop(); await flushChannel();
    puts.mockClear(); metas.mockClear();
    expect(client.beginCardDrag("a")).toBeNull();
    expect(client.requestCardMove(fresh, 0, 0)).toBe(false);
    expect(puts).not.toHaveBeenCalled(); expect(metas).not.toHaveBeenCalled();
  });

  it("syncs and restores validated nonsecret preferences across restart and takeover", async () => {
    const { hub, locks, host, db, client, displayStore } = await setup();
    expect(host.setPreferences({ theme: "dark", reducedMotion: true, subtitles: false }).ok).toBe(true);
    await flushChannel();
    expect(displayStore.getPreferences()).toEqual({ theme: "dark", reducedMotion: true, subtitles: false });
    expect(displayStore.getState().ambient.theme).toBe("dark");
    expect(host.setPreferences({ secret: "no" } as never).ok).toBe(false);
    expect(host.setPreferences({ subtitles: "false" } as never).ok).toBe(false);
    const version = client.getStatus().version;
    host.stop(); await flushChannel();
    const revivedStore = createCanvasStore();
    const revived = createControlHost({ db, store: revivedStore, channel: hub.createChannel(), lockProvider: locks });
    cleanup.push(revived.stop); await revived.start(); await flushChannel();
    expect(revived.getSnapshot().preferences).toEqual(displayStore.getPreferences());
    expect(client.getStatus().version).toBe(version);
    expect(await db.getMeta("displayPreferences")).not.toContain("secret");
  });
});

describe("display loss and recovery", () => {
  it("notifies status subscribers when owner messages, resync and the existing expiry timer disable controls", async () => {
    vi.useFakeTimers();
    const hub = createMemoryHub(), owner = hub.createChannel();
    const store = createCanvasStore(), client = createDisplayClient({ store, channel: hub.createChannel(), pinnedCanvasId: "c" });
    cleanup.push(client.stop);
    const statuses: boolean[] = [];
    const unsubscribe = client.subscribeStatus(() => statuses.push(client.getStatus().canInteract));
    await client.start();
    expect(vi.getTimerCount()).toBe(1); // the original retry timer; subscribers add no polling
    const snapshot: SyncMessage = { type: "snapshot", canvasId: "c", epoch: "owner", seq: 1, version: 1,
      requestId: "status-snapshot", payload: { title: "c", version: 1, vivicState: { ...store.toJSON(), cards: [{ record: card("a") }] } } };
    owner.post(snapshot); await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe(true);
    owner.post({ type: "patch", canvasId: "c", epoch: "owner", seq: 3, version: 2, requestId: "gap",
      payload: { envelope: { schemaVersion: "0.6", canvasId: "c", requestId: "gap", actions: [{ type: "canvas.fit" }] } } });
    await vi.advanceTimersByTimeAsync(0); expect(statuses.at(-1)).toBe(false);
    owner.post({ ...snapshot, requestId: "resync" }); await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe(true);
    owner.post({ type: "owner", canvasId: "c", epoch: "owner", seq: 0, version: 1, requestId: "off",
      payload: { status: "off", ownerId: "owner" } });
    await vi.advanceTimersByTimeAsync(0); expect(statuses.at(-1)).toBe(false);
    owner.post({ ...snapshot, requestId: "reconnect" }); await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe(true);
    await vi.advanceTimersByTimeAsync(3600); expect(statuses.at(-1)).toBe(false);
    owner.post({ ...snapshot, requestId: "alive-again" }); await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe(true);
    client.stop(); expect(statuses.at(-1)).toBe(false); expect(vi.getTimerCount()).toBe(0);
    const count = statuses.length; unsubscribe(); owner.post(snapshot); await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toHaveLength(count); owner.close();
  });

  it("disables interactions when the owner goes silent and retries until a snapshot is available", async () => {
    vi.useFakeTimers();
    const hub = createMemoryHub(), owner = hub.createChannel(), store = createCanvasStore();
    const requests: SyncMessage[] = []; owner.subscribe(msg => requests.push(msg));
    const client = createDisplayClient({ store, channel: hub.createChannel(), pinnedCanvasId: "c" });
    cleanup.push(client.stop); await client.start(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2400);
    expect(requests.filter(msg => msg.type === "snapshot-request").length).toBeGreaterThan(1);
    const snapshot: SyncMessage = { type: "snapshot", canvasId: "c", epoch: "first", seq: 1, version: 1,
      requestId: "snapshot", payload: { title: "c", version: 1, vivicState: {
        ...store.toJSON(), cards: [{ record: card("a") }],
      } } };
    owner.post(snapshot); await vi.advanceTimersByTimeAsync(0);
    expect(client.getStatus().canInteract).toBe(true);
    const drag = client.beginCardDrag("a")!;
    await vi.advanceTimersByTimeAsync(4000);
    expect(client.getStatus().ownerAlive).toBe(false);
    expect(client.requestCardMove(drag, 1, 2)).toBe(false);
    expect(client.requestCardSurface("a", "user")).toBe(false);
    expect(client.requestCardFocus("a")).toBe(false);
    expect(client.requestCanvasFit()).toBe(false);
    expect(client.requestFocusRestore()).toBe(false);
    owner.post({ ...snapshot, epoch: "second", requestId: "reconnect" });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getStatus().canInteract).toBe(true);
    expect(client.requestCardMove(drag, 1, 2)).toBe(false);
    expect(client.beginCardDrag("a")!.ownerEpoch).toBe("second");
  });

  it("does not broadcast or mutate the display when persistence fails", async () => {
    const { host, store, db, client, displayStore } = await setup();
    vi.spyOn(db, "putCanvas").mockRejectedValue(new Error("storage unavailable"));
    const before = { ...layout(displayStore) };
    client.requestCardMove(client.beginCardDrag("a")!, 15, 25); await flushChannel();
    expect(layout(store).x).toBe(15);
    expect(layout(displayStore)).toEqual(before);
    expect(host.getSnapshot().reminderError).toContain("保存失败");
  });
});
