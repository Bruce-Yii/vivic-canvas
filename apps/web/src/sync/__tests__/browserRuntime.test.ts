import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryDB } from "@/persistence/db";
import { canvasStore } from "@/state/canvasStore";
import type { SyncMessage } from "../protocol";
import type { DisplayRuntime } from "../browserRuntime";

vi.mock("@/persistence/db", async importOriginal => {
  const actual = await importOriginal<typeof import("@/persistence/db")>();
  return { ...actual, openVivicDB: vi.fn(async () => actual.createMemoryDB()) };
});
vi.mock("../channel", async importOriginal => {
  const actual = await importOriginal<typeof import("../channel")>();
  const hub = actual.createMemoryHub();
  return { ...actual, createBroadcastSyncChannel: vi.fn(() => hub.createChannel()) };
});
const runtimes: DisplayRuntime[] = [];
afterEach(() => { runtimes.splice(0).forEach(runtime => runtime.stop()); });

describe("browser display runtime", () => {
  it("notifies pre-start subscribers on assignment, owner loss, replacement and stop, then unsubscribes", async () => {
    const { createBroadcastSyncChannel, flushChannel } = await import("../channel");
    const { emptyVivicState } = await import("@/persistence/canvasRecord");
    const { getDisplayRuntime, getDisplayStatus, subscribeDisplayStatus } = await import("../browserRuntime");
    const statuses: Array<boolean | null> = [];
    const unsubscribe = subscribeDisplayStatus(() => statuses.push(getDisplayStatus()?.canInteract ?? null));
    const first = await getDisplayRuntime("status-one"); runtimes.push(first);
    expect(statuses).toContain(null); expect(statuses.at(-1)).toBe(false);
    const owner = createBroadcastSyncChannel();
    const snapshot: SyncMessage = { type: "snapshot", canvasId: "status-one", epoch: "status-owner", version: 0, seq: 1,
      requestId: "status-one", payload: { title: "one", version: 0, vivicState: emptyVivicState() } };
    owner.post(snapshot); await flushChannel(); expect(statuses.at(-1)).toBe(true);
    owner.post({ type: "owner", canvasId: "status-one", epoch: "status-owner", version: 0, seq: 0, requestId: "status-off",
      payload: { status: "off", ownerId: "status-owner" } });
    await flushChannel(); expect(statuses.at(-1)).toBe(false);
    const beforeReplacement = statuses.length;
    const second = await getDisplayRuntime("status-two"); runtimes.push(second);
    expect(statuses.slice(beforeReplacement)).toContain(null);
    owner.post({ ...snapshot, canvasId: "status-two", requestId: "status-two" });
    await flushChannel(); expect(statuses.at(-1)).toBe(true);
    first.stop(); expect(statuses.at(-1)).toBe(true); // a stale runtime cannot report the current one stopped
    second.stop(); expect(statuses.at(-1)).toBeNull();
    const count = statuses.length; unsubscribe();
    const third = await getDisplayRuntime("status-three"); runtimes.push(third);
    expect(statuses).toHaveLength(count); owner.close();
  });

  it("uses no controller writer, reuses a canvas, and stops stale clients when the target changes", async () => {
    const { getDisplayRuntime, beginCanvasDrag, requestCardSurface, requestCardFocus, requestCanvasFit, requestFocusRestore } = await import("../browserRuntime");
    const first = await getDisplayRuntime("one"); runtimes.push(first);
    expect(await getDisplayRuntime("one")).toBe(first);
    expect(beginCanvasDrag("missing")).toBeNull();
    expect(requestCardSurface("missing", "user")).toBe(false);
    expect(requestCardFocus("missing")).toBe(false);
    expect(requestCanvasFit()).toBe(false);
    expect(requestFocusRestore()).toBe(false);
    const second = await getDisplayRuntime("two"); runtimes.push(second);
    expect(second).not.toBe(first);
    expect(first.getStatus().canInteract).toBe(false);
    second.stop();
    const restarted = await getDisplayRuntime("two"); runtimes.push(restarted);
    expect(restarted).not.toBe(second);
  });

  it("forwards portal and view buttons as narrow owner requests without local mutations or database writes", async () => {
    const { openVivicDB } = await import("@/persistence/db");
    const { createBroadcastSyncChannel, flushChannel } = await import("../channel");
    const { getDisplayRuntime, requestCardSurface, requestCardFocus, requestCanvasFit, requestFocusRestore } = await import("../browserRuntime");
    const { emptyVivicState } = await import("@/persistence/canvasRecord");
    const db = createMemoryDB(); vi.mocked(openVivicDB).mockResolvedValueOnce(db);
    const puts = vi.spyOn(db, "putCanvas"), metas = vi.spyOn(db, "setMeta");
    const runtime = await getDisplayRuntime("buttons"); runtimes.push(runtime);
    const owner = createBroadcastSyncChannel(), messages: SyncMessage[] = [];
    owner.subscribe(msg => { if (msg.type === "interaction") messages.push(msg); });
    owner.post({ type: "snapshot", canvasId: "buttons", epoch: "owner-buttons", seq: 1, version: 4,
      requestId: "buttons-snapshot", payload: { title: "buttons", version: 4, vivicState: { ...emptyVivicState(),
        cards: [{ record: { id: "a", type: "QuoteCard", variant: "standard", displayProps: { text: "TEST portal" },
          sourceData: {}, sources: [], layout: { x: 10, y: 20, width: 320, height: 220, pinned: false },
          metadata: { createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z" } } }] } } });
    await flushChannel();
    const before = canvasStore.toJSON();
    expect(requestCardSurface("a", "user")).toBe(true);
    expect(requestCardFocus("a")).toBe(true);
    expect(requestCanvasFit()).toBe(true);
    expect(requestFocusRestore()).toBe(true);
    await flushChannel();
    expect(messages.map(msg => msg.type === "interaction" ? msg.payload.interaction.kind : "")).toEqual([
      "card.surface", "card.focus", "canvas.fit", "canvas.restore",
    ]);
    expect(messages.every(msg => msg.canvasId === "buttons" && msg.version === 4 &&
      msg.type === "interaction" && msg.payload.ownerEpoch === "owner-buttons")).toBe(true);
    expect(canvasStore.toJSON()).toEqual(before);
    expect(puts).not.toHaveBeenCalled(); expect(metas).not.toHaveBeenCalled();
    runtime.stop();
    expect(requestCanvasFit()).toBe(false); owner.close();
  });

  it("does not let a late IndexedDB read replace a newer owner snapshot", async () => {
    const { openVivicDB } = await import("@/persistence/db");
    const { createBroadcastSyncChannel, flushChannel } = await import("../channel");
    const { getDisplayRuntime } = await import("../browserRuntime");
    const { emptyVivicState, toCanvasRecord } = await import("@/persistence/canvasRecord");
    const db = createMemoryDB(), stale = toCanvasRecord("late", "old", 0, emptyVivicState());
    let release!: () => void;
    db.getCanvas = async () => { await new Promise<void>(resolve => { release = resolve; }); return stale; };
    vi.mocked(openVivicDB).mockResolvedValueOnce(db);
    const puts = vi.spyOn(db, "putCanvas"), metas = vi.spyOn(db, "setMeta");
    const starting = getDisplayRuntime("late"); await Promise.resolve(); await Promise.resolve();
    const owner = createBroadcastSyncChannel();
    const snapshot: SyncMessage = { type: "snapshot", canvasId: "late", epoch: "new-owner", version: 3, seq: 1, requestId: "new-snapshot",
      payload: { title: "current", version: 3, preferences: { theme: "dark", reducedMotion: true, subtitles: false },
        vivicState: { ...emptyVivicState(), viewport: { x: 32, y: 44, zoom: 0.7 } } } };
    owner.post(snapshot); await flushChannel(); release();
    const runtime = await starting; runtimes.push(runtime);
    expect(runtime.getStatus().version).toBe(3);
    expect(canvasStore.getState().viewport).toEqual({ x: 32, y: 44, zoom: 0.7 });
    expect(canvasStore.getPreferences().reducedMotion).toBe(true);
    expect(puts).not.toHaveBeenCalled(); expect(metas).not.toHaveBeenCalled(); owner.close();
  });
});
