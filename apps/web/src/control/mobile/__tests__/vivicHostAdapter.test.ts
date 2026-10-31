import { afterEach, describe, expect, it } from "vitest";
import { createVivicHostAdapter, type TextExecutionContext } from "@vivic/mobile-console-prototype/vivicHostAdapter";
import { createMemoryDB } from "@/persistence/db";
import { createCanvasStore } from "@/state/canvasStore";
import { createMemoryHub, flushChannel } from "@/sync/channel";
import { createControlHost } from "@/sync/controlHost";
import { createDisplayClient } from "@/sync/displayClient";
import { createMemoryLockProvider } from "@/sync/testing";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(stop => stop()));

async function setup(shareCardPreviews = false) {
  const hub = createMemoryHub(), db = createMemoryDB(), store = createCanvasStore();
  const host = createControlHost({ db, store, channel: hub.createChannel(), lockProvider: createMemoryLockProvider(), reminderPollMs: 1_000_000 });
  cleanup.push(host.stop); await host.start();
  const canvasId = host.getSnapshot().activeCanvasId!;
  const stamp = "2026-10-21T00:00:00.000Z";
  expect(host.dispatch({ schemaVersion: "0.6", requestId: "seed-mobile", canvasId, actions: [{ type: "card.create", card: {
    id: "mobile-quote", type: "QuoteCard", variant: "standard", displayProps: { text: "PRIVATE TEST CONTENT MUST NOT LEAVE COMPUTER" }, sourceData: {}, sources: [],
    layout: { x: 0, y: 0, width: 320, height: 200, pinned: false }, metadata: { createdAt: stamp, updatedAt: stamp },
  } }] }).ok).toBe(true);
  await flushChannel();
  const displayStore = createCanvasStore();
  const display = createDisplayClient({ db, store: displayStore, channel: hub.createChannel() });
  cleanup.push(display.stop); await display.start(); await flushChannel();
  let commitText: ((text: string, context: TextExecutionContext) => Promise<{ ok: boolean; message: string }>) = async () => ({ ok: false, message: "not installed" });
  const adapter = createVivicHostAdapter({ host, computerName: "TEST computer", shareCardPreviews, readCards: () => store.getState().cards,
    subscribeCards: store.subscribe, submitText: (text, context) => commitText(text, context) });
  return { adapter, db, host, store, displayStore, canvasId, setTextExecutor: (executor: typeof commitText) => { commitText = executor; } };
}

describe("unmounted Vivic remote adapter with the actual owner and Display", () => {
  it("moves the one original card in both directions and durably preserves metadata and pin state", async () => {
    const { adapter, host, store, db, displayStore, canvasId } = await setup(true);
    host.setCardPinned("mobile-quote", true);
    host.dispatch({ schemaVersion: "0.6", requestId: "subcard-mobile", canvasId, actions: [{ type: "card.subcard.set", targetId: "mobile-quote", subcard: { id: "detail", text: "保留补充内容" } }] });
    const before = structuredClone(store.getState().cards[0]!.record);
    expect((await adapter.setCardSurface!("mobile-quote", "user", { isCurrent: () => true })).ok).toBe(true);
    await flushChannel();
    expect(store.getState().cards).toHaveLength(1);
    expect(displayStore.getState().cards).toHaveLength(1);
    expect((await db.getCanvas(canvasId))!.cardsById[before.id]!).toMatchObject({
      id: before.id, displayProps: before.displayProps, sourceData: before.sourceData,
      metadata: { subcards: before.metadata.subcards }, layout: { pinned: true, surface: "user" },
    });
    expect((await adapter.setCardSurface!(before.id, "display", { isCurrent: () => true })).ok).toBe(true);
    await flushChannel();
    expect((await db.getCanvas(canvasId))!.cardsById[before.id]!.layout.surface ?? "display").toBe("display");
    expect((await adapter.setCardSurface!(before.id, "user", { isCurrent: () => false })).ok).toBe(false);
    expect(store.getState().cards[0]!.record.layout.surface ?? "display").toBe("display");
    expect((await adapter.setCardSurface!("foreign", "user", { isCurrent: () => true })).ok).toBe(false);
  });
  it("shares opted-in visible card content and surface while keeping owner pin/save behavior", async () => {
    const { adapter, host, db, displayStore, canvasId } = await setup(true);
    expect(adapter.getSnapshot()).toMatchObject({ cardCount: 1, cardsTruncated: false, cards: [{
      id: "mobile-quote", title: "PRIVATE TEST CONTENT MUST NOT LEAVE COMPUTER", surface: "display",
      preview: { kind: "text", body: "PRIVATE TEST CONTENT MUST NOT LEAVE COMPUTER" },
    }] });
    expect(host.setCardSurface("mobile-quote", "user").ok).toBe(true);
    await flushChannel();
    expect(adapter.getSnapshot().cards[0]!.surface).toBe("user");
    expect((await adapter.setCardPinned("mobile-quote", true)).ok).toBe(true);
    await flushChannel();
    expect(displayStore.getState().cards[0]!.record.layout.pinned).toBe(true);
    expect((await db.getCanvas(canvasId))!.cardsById["mobile-quote"]!.layout).toMatchObject({ pinned: true, surface: "user" });
    expect(adapter.getSnapshot().cards[0]!.preview!.body).toBe("PRIVATE TEST CONTENT MUST NOT LEAVE COMPUTER");
  });
  it("pins through the sole owner, saves and updates Display without leaking card bodies", async () => {
    const { adapter, db, displayStore, canvasId } = await setup();
    expect(JSON.stringify(adapter.getSnapshot())).not.toContain("PRIVATE TEST CONTENT");
    expect(await adapter.setCardPinned("mobile-quote", true)).toEqual({ ok: true, message: "电脑已固定卡片。" });
    await flushChannel();
    expect(displayStore.getState().cards[0]!.record.layout.pinned).toBe(true);
    expect((await db.getCanvas(canvasId))!.cardsById["mobile-quote"]!.layout.pinned).toBe(true);
    expect((await adapter.setCardPinned("missing", true)).ok).toBe(false);
  });

  it("switches an existing canvas and Display; never creates a mobile canvas", async () => {
    const { adapter, host, displayStore, canvasId, db } = await setup();
    const target = host.createCanvas("TEST second canvas");
    host.switchCanvas(canvasId); await flushChannel();
    const count = (await db.getAllCanvases()).length;
    expect((await adapter.switchCanvas(target)).ok).toBe(true);
    await flushChannel();
    expect(adapter.getSnapshot().activeCanvasId).toBe(target);
    expect(displayStore.getState().cards).toHaveLength(0);
    expect((await adapter.switchCanvas("foreign-canvas")).ok).toBe(false);
    expect((await db.getAllCanvases()).length).toBe(count);
  });

  it("prevents a late text executor from committing to a switched canvas", async () => {
    const { adapter, host, canvasId, setTextExecutor } = await setup();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let committed = false;
    setTextExecutor(async (_text, context) => {
      await pending;
      if (!context.isCurrent()) return { ok: false, message: "stale" };
      committed = true; return { ok: true, message: "committed" };
    });
    const controller = new AbortController();
    const request = adapter.submitText("TEST text", { requestId: "test-text", signal: controller.signal, isCurrent: () => true });
    const target = host.createCanvas("other");
    expect(target).not.toBe(canvasId);
    host.switchCanvas(target);
    release(); expect((await request).ok).toBe(false); expect(committed).toBe(false);
  });

  it("does not invoke an executor for an already cancelled or unauthorized request", async () => {
    const { adapter, setTextExecutor } = await setup();
    let calls = 0;
    setTextExecutor(async () => { calls++; return { ok: true, message: "done" }; });
    const controller = new AbortController(); controller.abort();
    expect((await adapter.submitText("cancelled", { requestId: "cancelled", signal: controller.signal, isCurrent: () => true })).ok).toBe(false);
    expect((await adapter.submitText("revoked", { requestId: "revoked", signal: new AbortController().signal, isCurrent: () => false })).ok).toBe(false);
    expect(calls).toBe(0);
  });
});
