import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionEnvelope, CardOfType, DecisionTaskStatus, HostOperation } from "@/contracts";
import { createMemoryDB } from "@/persistence/db";
import { createCanvasStore } from "@/state/canvasStore";
import { createControlHost } from "@/sync/controlHost";
import { createMemoryHub, flushChannel } from "@/sync/channel";
import { createMemoryLockProvider } from "@/sync/testing";
import { postIntent, type IntentResult } from "../api";
import { runDecisionTask } from "../decisionTask";

vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), postIntent: vi.fn() }));
const stops: Array<() => void> = [];
type NoteCard = CardOfType<"NoteCard">;
afterEach(() => { stops.splice(0).reverse().forEach(stop => stop()); vi.restoreAllMocks(); vi.resetAllMocks(); });
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const note = (id: string, x = 0, pinned = false): NoteCard => ({ id, type: "NoteCard", variant: "minimal",
  displayProps: { text: `TEST ${id}` }, sourceData: {}, sources: [],
  layout: { x, y: 0, width: 264, height: 160, pinned },
  metadata: { createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z" },
});
const task = (id: string, status: DecisionTaskStatus["status"], extra: Partial<DecisionTaskStatus> = {}): DecisionTaskStatus => ({
  protocolVersion: "vivic-decision-v2", id, status, step: 0, decision: "native-v2", ...extra,
});
const terminal = (id: string, status: "completed" | "failed" | "cancelled" = "completed"): IntentResult => ({ kind: "task", task: task(id, status), message: status });
const create = (id: string, canvasId: string, executionId: string, canvasVersion: number, cards: NoteCard[]): IntentResult => ({
  kind: "envelope", task: task(id, "awaiting_execution", { executionId, canvasVersion }),
  envelope: { schemaVersion: "0.6", requestId: `envelope-${executionId}`, canvasId, actions: cards.map(card => ({ type: "card.create", card })) },
});
const operation = (id: string, executionId: string, canvasVersion: number, hostOperation: HostOperation): IntentResult => ({
  kind: "host-operation", task: task(id, "awaiting_execution", { executionId, canvasVersion }), hostOperation,
});
const reply = (handler: (...args: Parameters<typeof postIntent>) => Promise<IntentResult> | IntentResult) => vi.mocked(postIntent).mockImplementation((...args) => {
  if (args[7]?.cancel) return Promise.resolve(terminal(args[7].id, "cancelled"));
  return Promise.resolve(handler(...args));
});
const requests = () => vi.mocked(postIntent).mock.calls.filter(args => !args[7]?.cancel);
async function setup() {
  const db = createMemoryDB(), store = createCanvasStore(), hub = createMemoryHub(), locks = createMemoryLockProvider();
  const makeHost = (nextStore = createCanvasStore()) => {
    const host = createControlHost({ db, store: nextStore, channel: hub.createChannel(), lockProvider: locks, autosaveMs: 1e8, reminderPollMs: 1e8 });
    stops.push(host.stop); return host;
  };
  const host = makeHost(store); await host.start();
  const canvasId = host.getSnapshot().activeCanvasId!;
  const version = () => host.getSnapshot().canvases.find(canvas => canvas.id === canvasId)!.version;
  const run = (extra: Partial<Parameters<typeof runDecisionTask>[0]> = {}) => runDecisionTask({ host, store, text: "创建便笺并整理位置",
    taskId: "task-test", signal: new AbortController().signal, isCurrent: () => true, ...extra });
  const seed = async (...cards: NoteCard[]) => {
    const envelope: ActionEnvelope = { schemaVersion: "0.6", requestId: `seed-${version()}`, canvasId, actions: cards.map(card => ({ type: "card.create", card })) };
    expect(host.dispatch(envelope).ok).toBe(true); await host.flush(canvasId, version());
  };
  return { host, store, db, canvasId, version, run, seed, makeHost };
}

describe("owner decision tasks with real in-memory persistence and simulated model replies", () => {
  it("creates, moves and pins in successive steps, acknowledging each only after its stored result", async () => {
    const { host, store, db, canvasId, run } = await setup();
    const disk = deferred<void>(), save = db.putCanvas;
    vi.spyOn(db, "putCanvas").mockImplementation(async record => { if (record.cardOrder.length) await disk.promise; await save(record); });
    const persistedAtReceipt: Awaited<ReturnType<typeof db.getCanvas>>[] = [];
    reply(async (_text, context, _signal, _attachments, _continuation, _location, _progress, request) => {
      if (request?.receipt) persistedAtReceipt.push(await db.getCanvas(canvasId));
      if (!request?.receipt) return create(request!.id, canvasId, "create-two", context.version!, [note("anchor"), note("moving", 600)]);
      if (request.receipt.executionId === "create-two") return operation(request.id, "move-right", context.version!, { kind: "card.move", targetId: "moving", relativeTo: "anchor", direction: "right" });
      if (request.receipt.executionId === "move-right") return operation(request.id, "pin-result", context.version!, { kind: "card.pin", targetId: "moving", pinned: true });
      return terminal(request.id);
    });
    const flush = vi.spyOn(host, "flush"); let settled = false;
    const result = run().then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    expect(store.getState().cards).toHaveLength(2);
    expect(requests()).toHaveLength(1); expect(settled).toBe(false);
    expect((await db.getCanvas(canvasId))!.cardOrder).toHaveLength(0);
    disk.resolve();
    expect(await result).toMatchObject({ task: { status: "completed" }, executed: true });
    expect(requests().slice(1).map(args => args[7]?.receipt)).toEqual([
      { executionId: "create-two", status: "succeeded", createdCardIds: ["anchor", "moving"] },
      { executionId: "move-right", status: "succeeded", createdCardIds: [] },
      { executionId: "pin-result", status: "succeeded", createdCardIds: [] },
    ]);
    expect(flush).toHaveBeenCalledTimes(3);
    expect(persistedAtReceipt[0]!.cardOrder).toEqual(["anchor", "moving"]);
    const moved = persistedAtReceipt[1]!.cardsById.moving!.layout, anchor = persistedAtReceipt[1]!.cardsById.anchor!.layout;
    expect(moved.x).toBeGreaterThanOrEqual(anchor.x + anchor.width);
    expect(persistedAtReceipt[2]!.cardsById.moving!.layout.pinned).toBe(true);
    expect(requests().every(args => args[7]?.id === "task-test")).toBe(true);
  });

  it.each(["abort", "superseded"] as const)("drops a late creation after the request is %s", async reason => {
    const { host, store, db, canvasId, run } = await setup();
    const late = deferred<IntentResult>(), controller = new AbortController(); let current = true;
    reply(() => late.promise); const dispatch = vi.spyOn(host, "dispatch");
    const result = run({ signal: controller.signal, isCurrent: () => current });
    const sent = requests()[0]!;
    if (reason === "abort") controller.abort(); else current = false;
    late.resolve(create(sent[7]!.id, canvasId, "too-late", sent[1].version!, [note("late")]));
    expect(await result).toMatchObject({ kind: "error", handled: true, executed: false });
    expect(dispatch).not.toHaveBeenCalled(); expect(store.getState().cards).toHaveLength(0);
    expect((await db.getCanvas(canvasId))!.cardOrder).toHaveLength(0);
  });

  it("keeps a saved first step but drops a later step after cancellation", async () => {
    const { store, db, canvasId, run } = await setup();
    const late = deferred<IntentResult>(), controller = new AbortController();
    reply((_text, context, _signal, _attachments, _continuation, _location, _progress, request) => request?.receipt ? late.promise
      : create(request!.id, canvasId, "first", context.version!, [note("kept")]));
    const result = run({ signal: controller.signal });
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    controller.abort();
    const next = requests()[1]!;
    late.resolve(create(next[7]!.id, canvasId, "second", next[1].version!, [note("cancelled")]));
    expect(await result).toMatchObject({ kind: "error", executed: true, handled: true });
    expect(store.getState().cards.map(card => card.record.id)).toEqual(["kept"]);
    expect((await db.getCanvas(canvasId))!.cardOrder).toEqual(["kept"]);
  });

  it("retains a saved change after network loss and does not replay it when the same execution is returned again", async () => {
    const { host, store, db, canvasId, run } = await setup();
    const dispatch = vi.spyOn(host, "dispatch");
    reply((_text, _context, _signal, _attachments, _continuation, _location, _progress, request) => {
      if (request?.receipt) throw new TypeError("TEST connection lost after write");
      return create(request!.id, canvasId, "one-write", 0, [note("once")]);
    });
    expect(await run()).toMatchObject({ kind: "error", executed: true, handled: true });
    expect(await run()).toMatchObject({ kind: "error", executed: true, handled: true });
    expect(dispatch).toHaveBeenCalledOnce(); expect(store.getState().cards).toHaveLength(1);
    expect((await db.getCanvas(canvasId))!.cardOrder).toEqual(["once"]);
  });

  it("deduplicates host moves across runs by executionId instead of moving the card twice", async () => {
    const { host, store, run, seed } = await setup(); await seed(note("moving"));
    const move = vi.spyOn(host, "moveCard");
    reply((_text, context, _signal, _attachments, _continuation, _location, _progress, request) => request?.receipt ? terminal(request.id)
      : operation(request!.id, "move-once", context.version!, { kind: "card.move", targetId: "moving", direction: "right" }));
    expect(await run()).toMatchObject({ task: { status: "completed" } });
    const after = structuredClone(store.getState().cards[0]!.record.layout);
    expect(await run({ taskId: "retry-task" })).toMatchObject({ task: { status: "completed" } });
    expect(move).toHaveBeenCalledOnce(); expect(store.getState().cards[0]!.record.layout).toEqual(after);
  });

  it("stops a repeated step in one response loop without another host mutation", async () => {
    const { host, run, seed } = await setup(); await seed(note("moving"));
    const move = vi.spyOn(host, "moveCard");
    reply((_text, context, _signal, _attachments, _continuation, _location, _progress, request) =>
      operation(request!.id, "repeated", context.version!, { kind: "card.move", targetId: "moving", direction: "right" }));
    expect(await run()).toMatchObject({ kind: "error", handled: true, executed: true });
    expect(move).toHaveBeenCalledOnce(); expect(requests()).toHaveLength(2);
  });

  it("refuses stale canvas versions and reports a failed receipt while retaining the user's newer edit", async () => {
    const { host, store, db, canvasId, run, seed } = await setup();
    const late = deferred<IntentResult>();
    reply((_text, _context, _signal, _attachments, _continuation, _location, _progress, request) => request?.receipt ? terminal(request.id, "failed") : late.promise);
    const result = run(), sent = requests()[0]!;
    await seed(note("user-edit"));
    const dispatch = vi.spyOn(host, "dispatch");
    late.resolve(create(sent[7]!.id, canvasId, "stale-version", sent[1].version!, [note("rejected")]));
    expect(await result).toMatchObject({ task: { status: "failed" }, executed: false });
    expect(requests()[1]![7]!.receipt).toMatchObject({ executionId: "stale-version", status: "failed" });
    expect(dispatch).not.toHaveBeenCalled(); expect(store.getState().cards.map(card => card.record.id)).toEqual(["user-edit"]);
    expect((await db.getCanvas(canvasId))!.cardOrder).toEqual(["user-edit"]);
  });

  it("does not write after another real host takes ownership while the model is pending", async () => {
    const { host, db, canvasId, run, makeHost } = await setup();
    const late = deferred<IntentResult>(); reply(() => late.promise);
    const dispatch = vi.spyOn(host, "dispatch"), result = run(), sent = requests()[0]!;
    const next = makeHost(); await next.start(); next.takeover(); await flushChannel(); await flushChannel();
    expect(host.getSnapshot().ownerMode).toBe("readonly");
    late.resolve(create(sent[7]!.id, canvasId, "old-owner", sent[1].version!, [note("forbidden")]));
    expect(await result).toMatchObject({ kind: "error", handled: true, executed: false });
    expect(dispatch).not.toHaveBeenCalled(); expect((await db.getCanvas(canvasId))!.cardOrder).toHaveLength(0);
  });

  it("never sends a succeeded receipt for a failed database flush and never replays its uncertain mutation", async () => {
    const { host, store, db, canvasId, run } = await setup();
    vi.spyOn(db, "putCanvas").mockRejectedValue(new Error("TEST disk write failed"));
    const dispatch = vi.spyOn(host, "dispatch");
    reply((_text, _context, _signal, _attachments, _continuation, _location, _progress, request) => request?.receipt ? terminal(request.id, "failed")
      : create(request!.id, canvasId, "uncertain-write", 0, [note("in-memory")]));
    expect(await run()).toMatchObject({ kind: "error", handled: true, executed: true });
    expect(store.getState().cards).toHaveLength(1); expect((await db.getCanvas(canvasId))!.cardOrder).toHaveLength(0);
    expect(await run()).toMatchObject({ task: { status: "failed" } });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(requests().some(args => args[7]?.receipt?.status === "succeeded")).toBe(false);
  });

  it("honors a pinned card when a task requests a move and supports canvas.arrange through the host", async () => {
    const { host, store, run, seed } = await setup(); await seed(note("fixed", 0, true), note("free", 600));
    const fixed = structuredClone(store.getState().cards.find(card => card.record.id === "fixed")!.record.layout);
    reply((_text, context, _signal, _attachments, _continuation, _location, _progress, request) => request?.receipt ? terminal(request.id, "failed")
      : operation(request!.id, "blocked-move", context.version!, { kind: "card.move", targetId: "fixed", direction: "right" }));
    expect(await run()).toMatchObject({ task: { status: "failed" }, executed: false });
    expect(requests()[1]![7]!.receipt?.status).toBe("failed");
    const arrange = vi.spyOn(host, "arrangeCanvas");
    reply((_text, context, _signal, _attachments, _continuation, _location, _progress, request) => request?.receipt ? terminal(request.id)
      : operation(request!.id, "arrange", context.version!, { kind: "canvas.arrange" }));
    expect(await run({ taskId: "arrange-task" })).toMatchObject({ task: { status: "completed" }, executed: true });
    expect(arrange).toHaveBeenCalledOnce();
    expect(store.getState().cards.find(card => card.record.id === "fixed")!.record.layout).toEqual(fixed);
  });
});
