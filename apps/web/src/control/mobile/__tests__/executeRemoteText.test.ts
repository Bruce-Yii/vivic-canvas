import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryDB } from "@/persistence/db";
import { canvasStore } from "@/state/canvasStore";
import { createMemoryHub } from "@/sync/channel";
import { createMemoryLockProvider } from "@/sync/testing";
import { createControlHost } from "@/sync/controlHost";
import { postIntent } from "@/ai/api";
import { executeRemoteText } from "../executeRemoteText";
vi.mock("@/ai/api", async original => ({ ...await original<typeof import("@/ai/api")>(), postIntent: vi.fn() }));
const stops: Array<() => void> = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.resetAllMocks(); });
async function setup() {
  const db = createMemoryDB();
  const host = createControlHost({ db, store: canvasStore, channel: createMemoryHub().createChannel(),
    lockProvider: createMemoryLockProvider(), reminderPollMs: 1e8 });
  stops.push(host.stop); await host.start();
  const canvasId = host.getSnapshot().activeCanvasId!;
  const context = { requestId: "remote-test", signal: new AbortController().signal, isCurrent: () => true };
  return { host, db, canvasId, context };
}
describe("formal remote text executor", () => {
  it("returns a computer location answer without inventing or saving a card", async () => {
    const { host, context } = await setup();
    vi.mocked(postIntent).mockResolvedValue({ kind: "locale", locale: { name: "测试城市", basis: "network", answer: "电脑当前使用的地点是测试城市。" } });
    const dispatch = vi.spyOn(host, "dispatch"), flush = vi.spyOn(host, "flush");
    expect(await executeRemoteText(host, "我在哪里", context, () => false)).toEqual({ ok: true, message: "电脑当前使用的地点是测试城市。" });
    expect(dispatch).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled();
  });
  it("awaits durable confirmation before reporting a single successful commit", async () => {
    const { host, canvasId, context } = await setup();
    vi.mocked(postIntent).mockResolvedValue({ kind: "envelope", envelope: { schemaVersion: "0.6", requestId: "backend-test", canvasId,
      actions: [{ type: "canvas.fit" }] } });
    const dispatch = vi.spyOn(host, "dispatch"), flush = vi.spyOn(host, "flush");
    let finish!: () => void; flush.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    let finished = false;
    const result = executeRemoteText(host, "请求测试模型理解文字", context, () => false).then(value => { finished = true; return value; });
    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    expect(dispatch).toHaveBeenCalledOnce(); expect(finished).toBe(false);
    finish(); expect((await result).ok).toBe(true);
  });
  it("drops an old model result when the lease or desktop priority changes", async () => {
    const { host, canvasId, context } = await setup();
    let resolve!: (value: Awaited<ReturnType<typeof postIntent>>) => void;
    vi.mocked(postIntent).mockImplementation(() => new Promise(done => { resolve = done; }));
    const dispatch = vi.spyOn(host, "dispatch"); let busy = false;
    const result = executeRemoteText(host, "理解一个测试指令", context, () => busy);
    busy = true;
    resolve({ kind: "envelope", envelope: { schemaVersion: "0.6", requestId: "late-test", canvasId, actions: [{ type: "canvas.fit" }] } });
    expect((await result).ok).toBe(false); expect(dispatch).not.toHaveBeenCalled();
  });
  it("surfaces uncertain storage after a committed action as an exception for connector unknown", async () => {
    const { host, context } = await setup();
    vi.spyOn(host, "flush").mockRejectedValue(new Error("fixture save failed"));
    const dispatch = vi.spyOn(host, "dispatch");
    await expect(executeRemoteText(host, "显示全部卡片", context, () => false)).rejects.toThrow("fixture save failed");
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it("does not start parsing or network work for cancelled or busy requests", async () => {
    const { host, context } = await setup(); const dispatch = vi.spyOn(host, "dispatch");
    expect((await executeRemoteText(host, "显示全部卡片", { ...context, signal: AbortSignal.abort() }, () => false)).ok).toBe(false);
    expect((await executeRemoteText(host, "显示全部卡片", context, () => true)).ok).toBe(false);
    expect(dispatch).not.toHaveBeenCalled(); expect(postIntent).not.toHaveBeenCalled();
  });

  it.each([
    { next: "第一张", conversationId: "phone-a", sameTask: true },
    { next: "创建一个便笺：新的计划", conversationId: "phone-a", sameTask: false },
    { next: "第一张", conversationId: "phone-b", sameTask: false },
  ])("keeps clarification scope only for a genuine answer from the same phone ($next / $conversationId)", async ({ next, conversationId, sameTask }) => {
    const { host, context } = await setup();
    const dispatch = vi.spyOn(host, "dispatch");
    let firstTask = "";
    vi.mocked(postIntent).mockImplementation(async (_text, _canvas, _signal, _attachments, _continuation, _location, _progress, request) => {
      if (!firstTask) {
        firstTask = request!.id;
        return { kind: "clarify", message: "要删除哪张便笺？", task: {
          protocolVersion: "vivic-decision-v2", id: request!.id, step: 0, status: "awaiting_clarification", decision: "native-v2",
        } };
      }
      return { kind: "task", message: "测试已完成", task: {
        protocolVersion: "vivic-decision-v2", id: request!.id, step: 1, status: "completed", decision: "native-v2",
      } };
    });
    expect(await executeRemoteText(host, "删除一张便笺", { ...context, conversationId: "phone-a" }, () => false)).toMatchObject({ ok: true, message: "要删除哪张便笺？" });
    expect((await executeRemoteText(host, next, { ...context, requestId: "remote-next", conversationId }, () => false)).ok).toBe(true);
    expect(postIntent).toHaveBeenCalledTimes(2);
    const second = vi.mocked(postIntent).mock.calls[1]!;
    expect(second[0]).toBe(next);
    if (sameTask) {
      expect(second[7]!.id).toBe(firstTask);
      expect(second[4]).toEqual({ utterance: "删除一张便笺", question: "要删除哪张便笺？" });
    } else {
      expect(second[7]!.id).not.toBe(firstTask);
      expect(second[4]).toBeUndefined();
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not fall back and recreate a local note after a task has committed and its follow-up request fails", async () => {
    const { host, db, canvasId, context } = await setup();
    const dispatch = vi.spyOn(host, "dispatch");
    vi.mocked(postIntent).mockImplementation(async (_text, canvas, _signal, _attachments, _continuation, _location, _progress, request) => {
      if (request?.cancel) return { kind: "task", task: { protocolVersion: "vivic-decision-v2", id: request.id, step: 1, status: "cancelled", decision: "native-v2" } };
      if (request?.receipt) throw new TypeError("TEST network lost after saved note");
      return { kind: "envelope", task: { protocolVersion: "vivic-decision-v2", id: request!.id, step: 0,
        status: "awaiting_execution", decision: "native-v2", executionId: "remote-created-once", canvasVersion: canvas.version },
        envelope: { schemaVersion: "0.6", requestId: "model-remote-note", canvasId, actions: [{ type: "card.create", card: {
          id: "remote-once", type: "NoteCard", variant: "minimal", displayProps: { text: "只创建一次" }, sourceData: {}, sources: [],
          layout: { x: 0, y: 0, width: 264, height: 160, pinned: false },
          metadata: { createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z" },
        } }] } };
    });
    await expect(executeRemoteText(host, "新建便笺：只创建一次", context, () => false)).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(canvasStore.getState().cards.map(card => card.record.id)).toEqual(["remote-once"]);
    expect((await db.getCanvas(canvasId))!.cardOrder).toEqual(["remote-once"]);
  });
});
