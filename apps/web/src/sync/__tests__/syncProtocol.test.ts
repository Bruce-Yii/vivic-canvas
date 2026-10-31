import { describe, expect, it } from "vitest";
import type { ActionEnvelope } from "@/contracts";
import { emptyVivicState } from "@/persistence/canvasRecord";
import { createMemoryDB } from "@/persistence/db";
import { createCanvasStore } from "@/state/canvasStore";
import { createMemoryHub, flushChannel } from "../channel";
import { createControlHost } from "../controlHost";
import { createDisplayClient } from "../displayClient";
import type { SyncMessage } from "../protocol";
import { createMemoryLockProvider } from "../testing";

/** Per-hub lock scope: models one browser profile, not one tab. */
const locksByHub = new WeakMap<object, ReturnType<typeof createMemoryLockProvider>>();
const hubLocks = (hub: object) => {
  let l = locksByHub.get(hub);
  if (!l) {
    l = createMemoryLockProvider();
    locksByHub.set(hub, l);
  }
  return l;
};

const fixedNow = "2026-10-14T10:00:00.000Z";

const todoCard = (id: string, items: string[]) => ({
  id,
  type: "TodoCard" as const,
  variant: "minimal" as const,
  displayProps: {
    items: items.map((text, i) => ({ id: `${id}-i${i}`, text, done: false })),
  },
  sourceData: {},
  sources: [],
  layout: { x: 0, y: 0, width: 288, height: 160, pinned: false },
  metadata: { createdAt: fixedNow, updatedAt: fixedNow },
});

let seq = 0;
const envelope = (canvasId: string, actions: object[]): ActionEnvelope => ({
  schemaVersion: "0.6",
  requestId: `t-${(seq += 1)}`,
  canvasId,
  actions: actions as ActionEnvelope["actions"],
});

const setup = async () => {
  const hub = createMemoryHub();
  const db = createMemoryDB();
  const hostStore = createCanvasStore();
  const host = createControlHost({
    db,
    channel: hub.createChannel(),
    store: hostStore,
    lockProvider: hubLocks(hub),
  });
  await host.start();
  const canvasId = host.getSnapshot().activeCanvasId!;
  const displayStore = createCanvasStore();
  const client = createDisplayClient({
    channel: hub.createChannel(),
    store: displayStore,
    pinnedCanvasId: canvasId,
  });
  await client.start();
  await flushChannel();
  return { hub, db, host, hostStore, client, displayStore, canvasId };
};

describe("sync protocol (control host + display client over stub channel)", () => {
  it("broadcasts frozen target numbers without persisting them or advancing action sequence, including newly opened displays", async () => {
    const { hub, host, db, hostStore, client, displayStore, canvasId } = await setup();
    host.dispatch(envelope(canvasId, ["a", "b", "c", "d"].map(id => ({ type: "card.create", card: todoCard(id, [id]) }))));
    await flushChannel(); await flushChannel();
    const version = client.getStatus().version;
    const choice = { id: "TEST-choice", targets: ["d", "b", "a", "c"], expiresAt: Date.now() + 60000 };
    host.setTargetChoice(choice); await flushChannel();
    expect(displayStore.getState().targetChoice).toEqual(choice); expect(client.getStatus().version).toBe(version);
    const lateStore = createCanvasStore(); const late = createDisplayClient({ channel: hub.createChannel(), store: lateStore, pinnedCanvasId: canvasId });
    await late.start(); await flushChannel(); expect(lateStore.getState().targetChoice).toEqual(choice);
    host.dispatch(envelope(canvasId, [{ type: "card.subcard.set", targetId: "b", subcard: { id: "child", itemId: "b-i0", text: "详情" } }]));
    await flushChannel(); await flushChannel();
    expect(displayStore.getState().cards.find(c => c.record.id === "b")?.record.metadata.subcards?.[0]?.text).toBe("详情");
    const saved = await db.getCanvas(canvasId); expect(saved).not.toHaveProperty("targetChoice");
    expect(saved?.cardsById.b?.metadata.subcards?.[0]?.text).toBe("详情");
    host.setTargetChoice(null); await flushChannel(); expect(displayStore.getState().targetChoice).toBeNull();
    expect(hostStore.getState().targetChoice).toBeNull(); late.stop(); host.stop(); client.stop();
  });
  it("clears choice on owner disconnect, rejects other-canvas/epoch messages and never revives it from disk", async () => {
    const { hub, host, db, client, displayStore, canvasId } = await setup();
    host.dispatch(envelope(canvasId, ["a", "b"].map(id => ({ type: "card.create", card: todoCard(id, [id]) }))));
    await flushChannel(); await flushChannel();
    const choice = { id: "TEST-choice", targets: ["a", "b"], expiresAt: Date.now() + 60000 };
    host.setTargetChoice(choice); await flushChannel(); expect(displayStore.getState().targetChoice).toEqual(choice);
    const channel = hub.createChannel();
    channel.post({ type: "target-choice", canvasId, epoch: "fake", version: 0, seq: 0, requestId: "fake", payload: { choice: null } });
    await flushChannel(); expect(displayStore.getState().targetChoice).toEqual(choice);
    host.stop(); await flushChannel(); expect(displayStore.getState().targetChoice).toBeNull();
    const restored = createCanvasStore(); const fresh = createDisplayClient({ db, channel: hub.createChannel(), store: restored, pinnedCanvasId: canvasId });
    await fresh.start(); expect(restored.getState().targetChoice).toBeNull(); fresh.stop(); client.stop();
  });
  it("request feedback syncs without advancing canvas versions and stale clears cannot hide a newer request", async () => {
    const { host, client, displayStore, canvasId } = await setup();
    const before = client.getStatus().version;
    host.setActivity("one", { requestId: "one", text: "让我想想…", expiresAt: Date.now() + 20000 });
    await flushChannel();
    expect(displayStore.getState().activity?.requestId).toBe("one");
    expect(client.getStatus().version).toBe(before);
    host.setActivity("two", { requestId: "two", text: "让我想想…", expiresAt: Date.now() + 20000 });
    host.setActivity("one", null);
    await flushChannel();
    expect(displayStore.getState().activity?.requestId).toBe("two");
    host.setActivity("two", null);
    host.dispatch(envelope(canvasId, [{ type: "card.create", card: todoCard("after-feedback", ["x"]) }]));
    await flushChannel();
    expect(displayStore.getState().activity).toBeNull();
    expect(displayStore.getState().cards).toHaveLength(1);
    host.stop(); client.stop();
  });

  it("a display opened during a request receives feedback in its snapshot; persistence omits it", async () => {
    const { hub, host, db, canvasId, client } = await setup();
    host.setActivity("pending", { requestId: "pending", text: "让我想想…", expiresAt: Date.now() + 20000 });
    const lateStore = createCanvasStore();
    const late = createDisplayClient({ channel: hub.createChannel(), store: lateStore, pinnedCanvasId: canvasId });
    await late.start(); await flushChannel();
    expect(lateStore.getState().activity?.requestId).toBe("pending");
    expect(JSON.stringify(await db.getCanvas(canvasId))).not.toContain("让我想想");
    const second = host.createCanvas("Other");
    host.switchCanvas(second);
    await flushChannel();
    expect(lateStore.getState().activity).toBeNull();
    host.stop(); client.stop(); late.stop();
  });

  it("hello -> snapshot hydrates a fresh display", async () => {
    const { host, client, displayStore, canvasId } = await setup();
    // Fresh display immediately got a snapshot of the empty canvas.
    expect(client.getStatus().hydrated).toBe(true);
    expect(displayStore.getState().cards).toHaveLength(0);

    host.dispatch(
      envelope(canvasId, [{ type: "card.create", card: todoCard("t1", ["a", "b", "c"]) }]),
    );
    await flushChannel();
    const cards = displayStore.getState().cards;
    expect(cards).toHaveLength(1);
    expect(cards[0]!.record.type).toBe("TodoCard");
  });

  it("replayed patch with the same requestId applies exactly once", async () => {
    const { host, displayStore, canvasId } = await setup();
    const env = envelope(canvasId, [
      { type: "card.create", card: todoCard("t2", ["x"]) },
    ]);
    const dispatchResult = host.dispatch(env);
    expect(dispatchResult).toEqual({ ok: true, deduplicated: false });
    host.dispatch(env);
    await flushChannel();
    expect(displayStore.getState().cards).toHaveLength(1);
    const after = displayStore.getState().cards.length;
    expect(env.requestId.length).toBeGreaterThan(0);
    expect(after).toBe(1);
    expect(
      displayStore.getState().processedRequestIds.filter((id) => id === env.requestId),
    ).toHaveLength(1);
  });

  it("version/seq mismatch triggers snapshot re-request and converges without dupes", async () => {
    const hub = createMemoryHub();
    const owner = hub.createChannel(); // scripted fake owner
    const fromDisplay: SyncMessage[] = [];
    owner.subscribe((m) => fromDisplay.push(m));
    const displayStore = createCanvasStore();
    const client = createDisplayClient({
      channel: hub.createChannel(),
      store: displayStore,
      pinnedCanvasId: "c1",
    });
    await client.start();
    await flushChannel();
    expect(fromDisplay.some((m) => m.type === "snapshot-request")).toBe(true);

    const stateWith = (...ids: string[]) => ({
      ...emptyVivicState(),
      stage: "WORKSPACE" as const,
      cards: ids.map((id) => ({ record: todoCard(id, [`item-${id}`]) })),
    });
    const snapshot = (version: number, seqN: number, ids: string[]): SyncMessage => ({
      type: "snapshot",
      canvasId: "c1",
      epoch: "e1",
      version,
      seq: seqN,
      requestId: `snap-${version}`,
      payload: { title: "T", version, vivicState: stateWith(...ids) },
    });
    owner.post(snapshot(2, 5, ["a"]));
    await flushChannel();
    expect(displayStore.getState().cards.map((c) => c.record.id)).toEqual(["a"]);

    // Patch that skips a version (v4 after v2) => ignore + re-request.
    const gapPatch: SyncMessage = {
      type: "patch",
      canvasId: "c1",
      epoch: "e1",
      version: 4,
      seq: 6,
      requestId: "gap-1",
      payload: { envelope: envelope("c1", [{ type: "card.create", card: todoCard("b", ["x"]) }]) },
    };
    owner.post(gapPatch);
    await flushChannel();
    expect(displayStore.getState().cards).toHaveLength(1);
    expect(fromDisplay.filter((m) => m.type === "snapshot-request").length).toBeGreaterThanOrEqual(2);

    // Owner sends a fresh full snapshot; display converges, no replay.
    owner.post(snapshot(4, 6, ["a", "b", "c"]));
    await flushChannel();
    expect(displayStore.getState().cards.map((c) => c.record.id)).toEqual(["a", "b", "c"]);
  });

  it("seq gap within an epoch triggers a snapshot re-request too", async () => {
    const hub = createMemoryHub();
    const owner = hub.createChannel();
    const fromDisplay: SyncMessage[] = [];
    owner.subscribe((m) => fromDisplay.push(m));
    const displayStore = createCanvasStore();
    const client = createDisplayClient({
      channel: hub.createChannel(),
      store: displayStore,
      pinnedCanvasId: "c1",
    });
    await client.start();
    await flushChannel();
    const snapshot: SyncMessage = {
      type: "snapshot",
      canvasId: "c1",
      epoch: "e1",
      version: 1,
      seq: 10,
      requestId: "s1",
      payload: { title: "T", version: 1, vivicState: emptyVivicState() },
    };
    owner.post(snapshot);
    await flushChannel();
    const patch: SyncMessage = {
      type: "patch",
      canvasId: "c1",
      epoch: "e1",
      version: 2,
      seq: 12, // should be 11
      requestId: "p1",
      payload: { envelope: envelope("c1", [{ type: "canvas.fit" }]) },
    };
    owner.post(patch);
    await flushChannel();
    expect(
      fromDisplay.filter((m) => m.type === "snapshot-request").length,
    ).toBeGreaterThanOrEqual(2);
    expect(displayStore.getState().lastFitRequestId).toBeNull();
  });

  it("display follows owner after canvas.switch via snapshot", async () => {
    const hub = createMemoryHub();
    const db = createMemoryDB();
    const hostStore = createCanvasStore();
    const host = createControlHost({
      db,
      channel: hub.createChannel(),
      store: hostStore,
      lockProvider: hubLocks(hub),
    });
    await host.start();
    const displayStore = createCanvasStore();
    const client = createDisplayClient({
      channel: hub.createChannel(),
      store: displayStore,
      // unpinned: follow owner
    });
    await client.start();
    await flushChannel();

    const second = host.createCanvas("第二画布");
    host.switchCanvas(second);
    // No flush between switch and edit: the revision-0 save must not swallow
    // the switch snapshot when revision 1 is already queued.
    host.dispatch(envelope(second, [{ type: "card.create", card: todoCard("immediate", ["立即编辑"]) }]));
    await flushChannel();
    await flushChannel();
    expect(client.getStatus().canvasId).toBe(second);
    expect(displayStore.getState().cards.map(c => c.record.id)).toEqual(["immediate"]);
  });

  it("owner restart (new epoch) re-syncs without duplicating actions", async () => {
    const hub = createMemoryHub();
    const db = createMemoryDB();
    const host1 = createControlHost({
      db,
      channel: hub.createChannel(),
      store: createCanvasStore(),
      lockProvider: hubLocks(hub),
    });
    await host1.start();
    const canvasId = host1.getSnapshot().activeCanvasId!;
    const displayStore = createCanvasStore();
    const client = createDisplayClient({
      channel: hub.createChannel(),
      store: displayStore,
      pinnedCanvasId: canvasId,
    });
    await client.start();
    await flushChannel();

    host1.dispatch(
      envelope(canvasId, [{ type: "card.create", card: todoCard("a", ["1"]) }]),
    );
    await flushChannel();
    expect(displayStore.getState().cards).toHaveLength(1);

    // Owner window closes; then a new owner session starts over the same db.
    host1.stop();
    await flushChannel();
    const revived = createControlHost({
      db,
      channel: hub.createChannel(),
      store: createCanvasStore(),
      lockProvider: hubLocks(hub),
    });
    await revived.start();
    // New owner session announces itself; the stored canvas comes back.
    await flushChannel();
    revived.dispatch(
      envelope(canvasId, [{ type: "card.create", card: todoCard("b", ["2"]) }]),
    );
    await flushChannel();
    await flushChannel();
    // Exactly two cards — the old state's card.create was never replayed.
    const ids = displayStore.getState().cards.map((c) => c.record.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });
});
