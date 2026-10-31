import { afterEach, it, expect } from "vitest";
import { createMemoryDB } from "@/persistence/db";
import { createCanvasStore } from "@/state/canvasStore";
import { createMemoryHub, flushChannel } from "../channel";
import { createControlHost } from "../controlHost";
import { createDisplayClient } from "../displayClient";
import { createMemoryLockProvider } from "../testing";
import type { CardRecord } from "@/contracts";
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(stop => stop()));
const make = (id: string): CardRecord => ({ id, type: "NoteCard", variant: "standard", displayProps: { text: id }, sources: [], sourceData: {},
  layout: { x: 0, y: 0, width: 300, height: 180, pinned: false }, metadata: { createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z" } });
async function setup() {
  const db = createMemoryDB(), hub = createMemoryHub(), locks = createMemoryLockProvider(), store = createCanvasStore(), displayStore = createCanvasStore();
  const host = createControlHost({ db, channel: hub.createChannel(), store, lockProvider: locks, reminderPollMs: 1000000 });
  const display = createDisplayClient({ db, channel: hub.createChannel(), store: displayStore });
  cleanup.push(host.stop, display.stop); await host.start(); await display.start(); await flushChannel();
  const id = host.getSnapshot().activeCanvasId!;
  let n = 0;
  const send = (actions: unknown[]) => host.dispatch({ schemaVersion: "0.6", canvasId: id, requestId: `TEST-history-${++n}`, actions });
  send(["a", "b"].map(id => ({ type: "card.create", card: make(id) }))); await flushChannel();
  const flush = async () => { await host.flush(id, host.getSnapshot().canvases.find(c => c.id === id)!.version); await flushChannel(); };
  return { db, store, host, displayStore, id, send, flush };
}
it("edit, portal, grouped deletion and redo have durable owner/display agreement", async () => {
  const { db, store, host, displayStore, id, send, flush } = await setup();
  send([{ type: "card.update", targetId: "a", displayProps: { text: "edited" } }]); await flush();
  expect(host.undo()).toBe(true); await flush();
  expect((await db.getCanvas(id))!.cardsById.a!.displayProps).toEqual({ text: "a" });
  expect(host.redo()).toBe(true); await flush();
  expect(displayStore.getState().cards.find(c => c.record.id === "a")!.record.displayProps).toEqual({ text: "edited" });
  host.setCardSurface("a", "user"); await flush(); expect(host.undo()).toBe(true); await flush();
  expect(store.getState().cards[0]!.record.layout.surface).toBeUndefined();
  expect(host.redo()).toBe(true); await flush();
  expect(displayStore.getState().cards[0]!.record.layout.surface).toBe("user");
  send([{ type: "cards.delete", targetIds: ["a", "b"] }]); await flush(); expect(store.getState().cards).toHaveLength(0);
  expect(host.undo()).toBe(true); await flush(); expect(displayStore.getState().cards).toHaveLength(2);
  expect(host.redo()).toBe(true); await flush(); expect(Object.keys((await db.getCanvas(id))!.cardsById)).toHaveLength(0);
});
it("classification and arrangement restore exact order and coordinates and reject old previews", async () => {
  const { host, store, id, flush } = await setup();
  host.setCardPinned("a", true); await flush();
  const fixed = structuredClone(store.getState().cards[0]!.record.layout);
  expect(host.setCardOrganization(["a"], { section: "旅行", priority: "high", dueDate: "2026-11-01" }, id).ok).toBe(true);
  expect(host.setCardOrganization(["b"], { section: "工作", priority: "low", dueDate: "2026-10-25" }, id).ok).toBe(true); await flush();
  const before = structuredClone(store.getState().cards), version = host.getSnapshot().canvases.find(c => c.id === id)!.version;
  const options = { sort: "due", direction: "asc", group: "keep" } as const;
  expect(host.organizeCanvas(options, version - 1).ok).toBe(false);
  expect(host.organizeCanvas(options, version).ok).toBe(true); await flush();
  const after = structuredClone(store.getState().cards);
  expect(after.map(c => c.record.id)).toEqual(["b", "a"]);
  expect(after.find(c => c.record.id === "a")!.record.layout).toEqual(fixed);
  expect(host.undo()).toBe(true); await flush(); expect(store.getState().cards).toEqual(before);
  expect(host.redo()).toBe(true); await flush(); expect(store.getState().cards).toEqual(after);
});
it("keeps histories scoped to spaces and forgets them after local reset", async () => {
  const { host, id } = await setup();
  const other = host.createCanvas("TEST second"); host.switchCanvas(other); await flushChannel();
  expect(host.undo()).toBe(false); expect(host.redo()).toBe(false);
  host.switchCanvas(id); await flushChannel(); expect(host.undo()).toBe(true);
  expect((await host.clearLocalData()).ok).toBe(true); expect(host.undo()).toBe(false); expect(host.redo()).toBe(false);
});
