import { afterEach, expect, it, vi } from "vitest";
import { createComputerConnector } from "@vivic/mobile-console-prototype/connector";
import { createVivicHostAdapter } from "@vivic/mobile-console-prototype/vivicHostAdapter";
import type { Frame } from "@vivic/mobile-console-prototype/protocol";
import type { Transport, TransportEvent } from "@vivic/mobile-console-prototype/transport";
import { createMemoryDB } from "@/persistence/db";
import { canvasStore } from "@/state/canvasStore";
import { createControlHost } from "@/sync/controlHost";
import { createMemoryHub } from "@/sync/channel";
import { createMemoryLockProvider } from "@/sync/testing";
import { postIntent } from "@/ai/api";
import { executeRemoteText } from "../executeRemoteText";

vi.mock("@/ai/api", async original => ({ ...await original<typeof import("@/ai/api")>(), postIntent: vi.fn() }));
class MemoryTransport implements Transport {
  private listeners = new Set<(event: TransportEvent) => void>();
  sent: Frame[] = [];
  connect() { this.listeners.forEach(listener => listener({ type: "open" })); }
  close() {}
  send(frame: Frame) { this.sent.push(frame); return true; }
  subscribe(listener: (event: TransportEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  receive(frame: Frame) { this.listeners.forEach(listener => listener({ type: "message", frame })); }
}
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(stop => stop()); vi.restoreAllMocks(); vi.resetAllMocks(); });

it("publishes the real owner's revision inside a connector commit, then waits for storage before the phone succeeds", async () => {
  const db = createMemoryDB(), transport = new MemoryTransport();
  const host = createControlHost({ db, store: canvasStore, channel: createMemoryHub().createChannel(),
    lockProvider: createMemoryLockProvider(), autosaveMs: 1e8, reminderPollMs: 1e8 });
  cleanup.push(host.stop); await host.start();
  const canvasId = host.getSnapshot().activeCanvasId!;
  const revision = () => host.getSnapshot().canvases.find(canvas => canvas.id === canvasId)!.version;
  const synchronousRevisions: Array<[number, number]> = [], validAfterCommit: boolean[] = [];
  const adapter = createVivicHostAdapter({ host, computerName: "TEST composed owner", shareCardPreviews: true,
    readCards: () => canvasStore.getState().cards, subscribeCards: canvasStore.subscribe,
    submitText: (text, context) => executeRemoteText(host, text, { ...context,
      withCommit<T>(write: () => T): T {
        // Keep the real connector boundary. Observe the actual host snapshot
        // before the async save/emit can conceal an incorrect synchronous value.
        const outcome = context.withCommit!(() => {
          const before = revision(), result = write();
          synchronousRevisions.push([before, revision()]);
          return result;
        });
        validAfterCommit.push(context.isCurrent());
        return outcome;
      },
    }, () => false),
  });
  const connector = createComputerConnector({ transport, host: adapter, deviceId: "computer-test", deviceName: "TEST", accessKey: "TEST-composed-access-key" });
  cleanup.push(connector.stop); connector.start();
  transport.receive({ v: 1, type: "welcome", sessionId: "composed-session", deviceId: "computer-test", computerId: "computer-test",
    epoch: "relay-epoch", token: "TEST-composed-session-token", expiresAt: Date.now() + 60000, permissions: ["text.submit"],
    controllers: [{ deviceId: "phone-test", permissions: ["text.submit"] }] });
  const initial = adapter.getSnapshot();
  let finishSave!: () => void;
  const saving = new Promise<void>(resolve => { finishSave = resolve; });
  const put = db.putCanvas;
  vi.spyOn(db, "putCanvas").mockImplementation(async record => {
    if (record.cardOrder.includes("phone-note")) await saving;
    await put(record);
  });
  const persistedAtReceipt: Awaited<ReturnType<typeof db.getCanvas>>[] = [];
  vi.mocked(postIntent).mockImplementation(async (_text, canvas, _signal, _attachments, _continuation, _location, _progress, request) => {
    const task = { protocolVersion: "vivic-decision-v2" as const, id: request!.id, decision: "native-v2" as const, step: 0 };
    if (request?.cancel) return { kind: "task", task: { ...task, status: "cancelled" } };
    if (request?.receipt) {
      persistedAtReceipt.push(await db.getCanvas(canvasId));
      return { kind: "task", message: "已创建并保存", task: { ...task, step: 1, status: "completed" } };
    }
    return { kind: "envelope", task: { ...task, status: "awaiting_execution", executionId: "phone-create", canvasVersion: canvas.version },
      envelope: { schemaVersion: "0.6", requestId: "model-phone-create", canvasId, actions: [{ type: "card.create", card: {
        id: "phone-note", type: "NoteCard", variant: "minimal", displayProps: { text: "TEST 手机建卡" }, sourceData: {}, sources: [],
        layout: { x: 0, y: 0, width: 264, height: 160, pinned: false },
        metadata: { createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z" },
      } }] } };
  });
  const results = () => transport.sent.filter((frame): frame is Extract<Frame, { type: "result" }> => frame.type === "result");
  transport.receive({ v: 1, type: "command", sessionId: "composed-session", epoch: "relay-epoch", deviceId: "phone-test",
    requestId: "phone-request", canvasId, ownerEpoch: initial.ownerEpoch, expectedVersion: initial.version,
    operation: { kind: "text.submit", text: "创建便笺：TEST 手机建卡" } });
  try {
    await vi.waitFor(() => expect(synchronousRevisions).toHaveLength(1));
    expect(synchronousRevisions).toEqual([[initial.version, initial.version + 1]]);
    expect(validAfterCommit).toEqual([true]);
    expect(adapter.getSnapshot().version).toBe(initial.version + 1);
    expect(canvasStore.getState().cards.map(card => card.record.id)).toEqual(["phone-note"]);
    expect((await db.getCanvas(canvasId))!.cardOrder).toEqual([]);
    expect(postIntent).toHaveBeenCalledOnce();
    expect(results()).toHaveLength(0);
  } finally { finishSave(); }
  await vi.waitFor(() => expect(results()).toHaveLength(1));
  expect(results()[0]).toMatchObject({ requestId: "phone-request", forDeviceId: "phone-test", status: "succeeded", version: initial.version + 1 });
  expect(postIntent).toHaveBeenCalledTimes(2);
  const followup = vi.mocked(postIntent).mock.calls[1]!;
  expect(followup[7]!.id).toBe(vi.mocked(postIntent).mock.calls[0]![7]!.id);
  expect(followup[7]!.receipt).toEqual({ executionId: "phone-create", status: "succeeded", createdCardIds: ["phone-note"] });
  expect(persistedAtReceipt[0]!.cardOrder).toEqual(["phone-note"]);
  expect(persistedAtReceipt[0]!.version).toBe(initial.version + 1);
});
