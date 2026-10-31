import { afterEach, describe, expect, it, vi } from "vitest";
import type { CountdownCard } from "@/contracts";
import { createMemoryDB } from "@/persistence/db";
import { createCanvasStore } from "@/state/canvasStore";
import { createMemoryHub, flushChannel } from "@/sync/channel";
import { createControlHost, type ControlHost } from "@/sync/controlHost";
import { createMemoryLockProvider } from "@/sync/testing";
import { createDisplayClient } from "@/sync/displayClient";
import { isDue, remainingSeconds } from "../reminders";
import { presentCards } from "@/canvas/reminderPresentation";
import { hasUnpinnedOverlap } from "@/state/canvasStore";
import { testCards } from "@/cards/__tests__/fixtures";

const startAt = Date.parse("2026-10-15T10:00:00.000Z");
const hosts: ControlHost[] = [];
afterEach(() => { hosts.splice(0).forEach(host => host.stop()); });
const timerCard = (id: string, due: number, text = id): CountdownCard => ({
  id, type: "CountdownCard", variant: "minimal", displayProps: {},
  sourceData: { startedAt: new Date(startAt).toISOString(), targetAt: new Date(due).toISOString(), reminderText: text },
  sources: [], layout: { x: 0, y: 0, width: 264, height: 96, pinned: false },
  metadata: { createdAt: new Date(startAt).toISOString(), updatedAt: new Date(startAt).toISOString() },
});
const setup = async () => {
  let at = startAt;
  const hub = createMemoryHub(), db = createMemoryDB(), locks = createMemoryLockProvider();
  const store = createCanvasStore();
  const build = (nextStore = createCanvasStore()) => {
    const host = createControlHost({ db, channel: hub.createChannel(), store: nextStore, lockProvider: locks, now: () => at, reminderPollMs: 1000000 });
    hosts.push(host); return host;
  };
  const host = build(store); await host.start();
  const canvasId = host.getSnapshot().activeCanvasId!;
  let sequence = 0;
  const send = (actions: object[]) => host.dispatch({ schemaVersion: "0.6", canvasId: host.getSnapshot().activeCanvasId, requestId: `test-${++sequence}`, actions });
  return { host, hub, db, store, canvasId, build, send, advance: (ms: number) => { at += ms; } };
};

describe("reminder delivery owned by the controller", () => {
  it("brings a distant reminder into the one-hour window without moving a pinned obstacle", async () => {
    vi.useFakeTimers(); vi.setSystemTime(startAt);
    try {
      const { host, store, send, advance } = await setup();
      const pinned = { ...testCards.TodoCard, layout: { ...testCards.TodoCard.layout, pinned: true } };
      send([{ type: "card.create", card: pinned }, { type: "card.create", card: timerCard("soon", startAt + 3601000) }]);
      await host.checkReminders();
      expect(presentCards(store.getState().cards)).toHaveLength(1);
      advance(2000); vi.setSystemTime(startAt + 2000); await host.checkReminders();
      expect(presentCards(store.getState().cards)).toHaveLength(2);
      expect(hasUnpinnedOverlap(store.getState().cards)).toBe(false);
      expect(store.getState().cards.find(c => c.record.id === pinned.id)!.record.layout).toEqual(pinned.layout);
      expect(host.getSnapshot().reminderNotices).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
  it("three due timers become distinct notices exactly once and keep minimal props empty", async () => {
    const { host, store, send, advance } = await setup();
    send(["喝水", "休息", "开会"].map((text, index) => ({ type: "card.create", card: timerCard(`r${index}`, startAt + 5000, text) })));
    await host.checkReminders();
    expect(host.getSnapshot().reminderNotices).toHaveLength(0);
    advance(5000);
    await Promise.all([host.checkReminders(), host.checkReminders()]);
    expect(host.getSnapshot().reminderNotices.map(n => n.text)).toEqual(["喝水", "休息", "开会"]);
    expect(store.getState().cards.every(c => c.record.type === "CountdownCard" && c.record.sourceData.notifiedAt && Object.keys(c.record.displayProps).length === 0)).toBe(true);
    await host.checkReminders();
    expect(host.getSnapshot().reminderNotices).toHaveLength(3);
    expect(store.getState().subtitle?.priority).toBe("reminder");
  });

  it("checks inactive canvases without switching and broadcasts their marked state", async () => {
    const { host, hub, db, send, advance, canvasId } = await setup();
    send([{ type: "card.create", card: timerCard("hidden", startAt + 5000) }]);
    const displayStore = createCanvasStore();
    const display = createDisplayClient({ channel: hub.createChannel(), store: displayStore, pinnedCanvasId: canvasId });
    await display.start(); await flushChannel();
    const other = host.createCanvas("其他画布"); host.switchCanvas(other);
    advance(6000); await host.checkReminders(); await flushChannel();
    expect(host.getSnapshot().activeCanvasId).toBe(other);
    const card = displayStore.getState().cards[0]!.record;
    expect(card.type === "CountdownCard" && card.sourceData.notifiedAt).toBeTruthy();
    const persistedHidden = (await db.getCanvas(canvasId))!.cardsById.hidden!;
    expect(persistedHidden.type === "CountdownCard" && persistedHidden.sourceData.notifiedAt).toBeTruthy();
    expect(host.getSnapshot().reminderNotices).toHaveLength(1);
    display.stop();
  });

  it("reloads persisted deliveries without repeating and catches up a missed deadline", async () => {
    const { host, send, advance, build } = await setup();
    send([{ type: "card.create", card: timerCard("done", startAt + 5000) },
      { type: "card.create", card: timerCard("late", startAt + 10000) }]);
    advance(5000); await host.checkReminders(); host.stop();
    advance(10000);
    const revived = build(); await revived.start(); await revived.checkReminders();
    expect(revived.getSnapshot().reminderNotices.map(n => n.cardId)).toEqual(["done", "late"]);
    await revived.checkReminders();
    expect(revived.getSnapshot().reminderNotices).toHaveLength(2);
  });

  it("pause freezes remaining time, cancellation suppresses delivery, rescheduling creates a new occurrence", async () => {
    const { host, send, store, advance } = await setup();
    const card = timerCard("paused", startAt + 10000);
    card.sourceData.pausedAt = new Date(startAt + 2000).toISOString();
    expect(remainingSeconds(card, startAt + 500000)).toBe(8);
    expect(isDue(card, startAt + 500000)).toBe(false);
    send([{ type: "card.create", card }, { type: "card.create", card: timerCard("cancelled", startAt + 1000) }]);
    send([{ type: "card.delete", targetId: "cancelled" }]);
    advance(20000); await host.checkReminders();
    expect(host.getSnapshot().reminderNotices).toHaveLength(0);
    send([{ type: "card.update", targetId: "paused", sourceData: { pausedAt: null, targetAt: new Date(startAt + 25000).toISOString() } }]);
    advance(6000); await host.checkReminders();
    expect(host.getSnapshot().reminderNotices).toHaveLength(1);
    send([{ type: "card.update", targetId: "paused", sourceData: { notifiedAt: null, targetAt: new Date(startAt + 30000).toISOString() } }]);
    advance(5000); await host.checkReminders();
    expect(host.getSnapshot().reminderNotices).toHaveLength(2);
    expect(store.getState().cards).toHaveLength(1);
  });

  it("does not announce a timer cancelled while inbox persistence is pending", async () => {
    const { host, send, advance, db } = await setup();
    const original = db.setMeta;
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    let first = true;
    db.setMeta = async (key, value) => {
      if (key === "reminderInbox" && first) { first = false; started(); await new Promise<void>(resolve => { release = resolve; }); }
      await original(key, value);
    };
    send([{ type: "card.create", card: timerCard("cancel", startAt + 1000) }]);
    advance(2000); const checking = host.checkReminders(); await begun;
    send([{ type: "card.delete", targetId: "cancel" }]); release(); await checking;
    expect(host.getSnapshot().reminderNotices).toHaveLength(0);
  });

  it("a read-only controller cannot deliver even if asked to check", async () => {
    const { host, send, advance, build } = await setup();
    send([{ type: "card.create", card: timerCard("owner", startAt + 1000) }]);
    const reader = build(); await reader.start();
    advance(2000); await reader.checkReminders();
    expect(reader.getSnapshot().ownerMode).toBe("readonly");
    expect(reader.getSnapshot().reminderNotices).toHaveLength(0);
    await host.checkReminders();
    expect(host.getSnapshot().reminderNotices).toHaveLength(1);
  });

  it("one undo restores every timer from a batch deletion on both windows", async () => {
    const { host, hub, store, send, canvasId } = await setup();
    send(["a", "b", "c"].map(id => ({ type: "card.create", card: timerCard(id, startAt + 60000) })));
    const displayStore = createCanvasStore();
    const display = createDisplayClient({ channel: hub.createChannel(), store: displayStore, pinnedCanvasId: canvasId });
    await display.start(); await flushChannel();
    send(["a", "b", "c"].map(targetId => ({ type: "card.delete", targetId })));
    await flushChannel();
    for (const requestId of Object.keys(displayStore.getState().pendingDeletes)) displayStore.internal({ type: "card.delete.commit", requestId });
    expect(store.getState().cards).toHaveLength(0);
    expect(displayStore.getState().cards).toHaveLength(0);
    expect(host.undo()).toBe(true); await flushChannel();
    expect(store.getState().cards.map(c => c.record.id)).toEqual(["a", "b", "c"]);
    expect(displayStore.getState().cards.map(c => c.record.id)).toEqual(["a", "b", "c"]);
    // General history now also includes the earlier grouped creation.
    expect(host.undo()).toBe(true); await flushChannel();
    expect(store.getState().cards).toHaveLength(0);
    expect(displayStore.getState().cards).toHaveLength(0);
    expect(host.undo()).toBe(false);
    expect(host.redo()).toBe(true); await flushChannel();
    expect(displayStore.getState().cards.map(c => c.record.id)).toEqual(["a", "b", "c"]);
    display.stop();
  });

  it("takeover reloads delivery stamps and a read-only window closing cannot overwrite them", async () => {
    const { host, send, advance, build, db, canvasId } = await setup();
    send([{ type: "card.create", card: timerCard("once", startAt + 1000) }]);
    const reader = build(); await reader.start();
    advance(2000); await host.checkReminders();
    expect(reader.getSnapshot().reminderNotices).toHaveLength(0); // intentionally old reader state
    reader.takeover(); await flushChannel();
    expect(reader.getSnapshot().ownerMode).toBe("owner");
    expect(reader.getSnapshot().ready).toBe(true);
    await reader.checkReminders();
    expect(reader.getSnapshot().reminderNotices).toHaveLength(1);
    host.stop(); await flushChannel();
    const persisted = (await db.getCanvas(canvasId))!.cardsById.once!;
    expect(persisted.type === "CountdownCard" && persisted.sourceData.notifiedAt).toBeTruthy();
    await reader.checkReminders();
    expect(reader.getSnapshot().reminderNotices).toHaveLength(1);
  });
});
