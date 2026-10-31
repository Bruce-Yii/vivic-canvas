import { describe, expect, it, vi } from "vitest";
import { createMemoryDB } from "@/persistence/db";
import { createCanvasStore } from "@/state/canvasStore";
import { testCards } from "@/cards/__tests__/fixtures";
import { createControlHost } from "../controlHost";
import { createDisplayClient } from "../displayClient";
import { createMemoryHub, flushChannel } from "../channel";
import { createMemoryLockProvider } from "../testing";
import { DEFAULT_DISPLAY_PREFERENCES } from "../protocol";
import { emptyVivicState, toCanvasRecord } from "@/persistence/canvasRecord";

describe("owner-controlled local data reset", () => {
  it("does not hydrate an old canvas if its delayed read finishes after a reset notification", async () => {
    const db = createMemoryDB(), hub = createMemoryHub(), store = createCanvasStore();
    const stale = toCanvasRecord("TEST-old", "TEST old", 1, { ...emptyVivicState(), cards: [{ record: testCards.TodoCard }] });
    let release!: () => void;
    db.getCanvas = async () => { await new Promise<void>(resolve => { release = resolve; }); return stale; };
    const display = createDisplayClient({ db, channel: hub.createChannel(), store, pinnedCanvasId: stale.id });
    const sender = hub.createChannel();
    try {
      const starting = display.start();
      sender.post({ type: "local-data-reset", canvasId: "TEST-fresh", epoch: "TEST-epoch", version: 0, seq: 0,
        requestId: "TEST-reset", payload: { ownerId: "TEST-owner" } });
      await flushChannel(); release(); await starting;
      expect(store.getState().cards).toEqual([]);
      expect(display.getStatus().canvasId).toBe("TEST-fresh");
    } finally { release?.(); display.stop(); sender.close(); }
  });

  it("clears all canvases, metadata, undo and reader state, and survives takeover/reload", async () => {
    const db = createMemoryDB(), hub = createMemoryHub(), locks = createMemoryLockProvider();
    const store = createCanvasStore(), displayStore = createCanvasStore();
    const resetPreferences = vi.fn();
    const owner = createControlHost({ db, channel: hub.createChannel(), store, lockProvider: locks, reminderPollMs: 1000000 });
    const reader = createControlHost({ db, channel: hub.createChannel(), store: createCanvasStore(), lockProvider: locks,
      reminderPollMs: 1000000, onLocalDataReset: resetPreferences });
    let display: ReturnType<typeof createDisplayClient> | undefined;
    let reloaded: ReturnType<typeof createDisplayClient> | undefined;
    try {
      await owner.start();
      const oldId = owner.getSnapshot().activeCanvasId!;
      owner.dispatch({ schemaVersion: "0.6", requestId: "TEST-before-reset", canvasId: oldId,
        actions: [{ type: "stage.awaken" }, { type: "card.create", card: testCards.TodoCard }] });
      const other = owner.createCanvas("TEST other"); owner.switchCanvas(other);
      owner.setPreferences({ theme: "dark", subtitles: false });
      await flushChannel();
      await db.setMeta("TEST-extra", "must disappear");
      await reader.start();
      display = createDisplayClient({ db, channel: hub.createChannel(), store: displayStore, pinnedCanvasId: oldId });
      await display.start(); await flushChannel();
      expect(displayStore.getState().cards).toHaveLength(1);
      const drag = display.beginCardDrag(testCards.TodoCard.id)!;
      const beforeClear = vi.fn(async () => {
        expect(owner.getSnapshot().ready).toBe(false);
        expect(owner.dispatch({ schemaVersion: "0.6", requestId: "TEST-during-reset", canvasId: other, actions: [{ type: "stage.awaken" }] }).ok).toBe(false);
      });
      expect((await reader.clearLocalData(beforeClear)).ok).toBe(false);
      expect(beforeClear).not.toHaveBeenCalled();
      expect((await owner.clearLocalData(beforeClear)).ok).toBe(true);
      await flushChannel();
      const freshId = owner.getSnapshot().activeCanvasId!;
      expect(freshId).not.toBe(oldId); expect(freshId).not.toBe(other);
      expect(await db.getAllCanvases()).toHaveLength(1);
      expect(await db.getMeta("TEST-extra")).toBeUndefined();
      expect(await db.getMeta("displayPreferences")).toBeUndefined();
      expect(await db.getMeta("reminderInbox")).toBeUndefined();
      expect(store.getState()).toMatchObject({ cards: [], undoStack: [], activity: null, subtitle: null, stage: "STANDBY" });
      expect(displayStore.getState().cards).toEqual([]);
      expect(display.getStatus().canvasId).toBe(freshId);
      expect(display.requestCardMove(drag, 50, 60)).toBe(false);
      expect(displayStore.getPreferences()).toEqual(DEFAULT_DISPLAY_PREFERENCES);
      expect(reader.getSnapshot().canvases.map(c => c.id)).toEqual([freshId]);
      expect(resetPreferences).toHaveBeenCalledOnce();
      expect(owner.undo()).toBe(false);
      reloaded = createDisplayClient({ db, channel: hub.createChannel(), store: createCanvasStore(), pinnedCanvasId: oldId });
      await reloaded.start(); await flushChannel();
      expect(reloaded.getStatus().canvasId).toBe(freshId);
      reader.takeover(); await flushChannel();
      expect(reader.getSnapshot().canvases.map(c => c.id)).toEqual([freshId]);
    } finally { reloaded?.stop(); display?.stop(); reader.stop(); owner.stop(); }
  });

  it.each(["cache", "database"])("retains canvases and writing ability on a %s failure", async failure => {
    const db = createMemoryDB(), hub = createMemoryHub();
    const host = createControlHost({ db, channel: hub.createChannel(), store: createCanvasStore(), lockProvider: createMemoryLockProvider(), reminderPollMs: 1000000 });
    try {
      await host.start(); const before = host.getSnapshot().activeCanvasId;
      // No flush: these accepted writes are still queued when reset starts.
      const justCreated = host.createCanvas("TEST newly created");
      host.renameCanvas(before!, "TEST renamed");
      host.setPreferences({ theme: "dark" });
      const reset = vi.spyOn(db, "reset");
      if (failure === "database") reset.mockRejectedValueOnce(new Error("TEST storage denied"));
      const result = await host.clearLocalData(async () => { if (failure === "cache") throw new Error("TEST cache denied"); });
      expect(result.ok).toBe(false); expect(host.getSnapshot().ready).toBe(true);
      expect(host.getSnapshot().activeCanvasId).toBe(before);
      expect(await db.getCanvas(before!)).toBeDefined();
      expect((await db.getCanvas(before!))?.title).toBe("TEST renamed");
      expect(await db.getCanvas(justCreated)).toBeDefined();
      expect(JSON.parse((await db.getMeta("displayPreferences"))!).theme).toBe("dark");
      if (failure === "cache") expect(reset).not.toHaveBeenCalled();
      expect(host.setPreferences({ theme: "light" }).ok).toBe(true);
    } finally { host.stop(); }
  });

  it("aborts the destructive transaction if ownership is taken while clearing caches", async () => {
    const db = createMemoryDB(), hub = createMemoryHub(), locks = createMemoryLockProvider();
    const a = createControlHost({ db, channel: hub.createChannel(), store: createCanvasStore(), lockProvider: locks, reminderPollMs: 1000000 });
    const b = createControlHost({ db, channel: hub.createChannel(), store: createCanvasStore(), lockProvider: locks, reminderPollMs: 1000000 });
    try {
      await a.start(); await b.start(); const reset = vi.spyOn(db, "reset");
      const result = await a.clearLocalData(async () => { b.takeover(); await flushChannel(); });
      expect(result).toEqual({ ok: false, error: "readonly-not-owner" });
      expect(reset).not.toHaveBeenCalled(); expect(await db.getAllCanvases()).toHaveLength(1);
    } finally { a.stop(); b.stop(); }
  });

  it("waits for an in-flight reminder inbox save so it cannot repopulate cleared data", async () => {
    const db = createMemoryDB(), hub = createMemoryHub();
    const host = createControlHost({ db, channel: hub.createChannel(), store: createCanvasStore(), lockProvider: createMemoryLockProvider(), reminderPollMs: 1000000 });
    let release!: () => void, entered!: () => void;
    const saving = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const setMeta = db.setMeta;
    try {
      await host.start();
      host.dispatch({ schemaVersion: "0.6", requestId: "TEST-due", canvasId: host.getSnapshot().activeCanvasId!, actions: [
        { type: "card.create", card: { ...testCards.CountdownCard, sourceData: {
          startedAt: new Date(Date.now() - 20000).toISOString(), targetAt: new Date(Date.now() - 1000).toISOString(), reminderText: "TEST due" } } },
      ] });
      await flushChannel();
      db.setMeta = async (key, value) => { if (key === "reminderInbox") { entered(); await gate; } await setMeta(key, value); };
      const checking = host.checkReminders(); await saving;
      const resetting = host.clearLocalData();
      release(); await checking;
      expect((await resetting).ok).toBe(true);
      expect(await db.getMeta("reminderInbox")).toBeUndefined();
      expect(host.getSnapshot().reminders).toEqual([]); expect(host.getSnapshot().reminderNotices).toEqual([]);
    } finally { release?.(); host.stop(); }
  });
});
