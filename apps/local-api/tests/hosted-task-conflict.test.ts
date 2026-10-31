import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CountdownCardSchema, NoteCardSchema, TodoCardSchema } from "@vivic/contracts";
import { HostedSpaceStore } from "../src/space/store.js";
import { SpaceError } from "../src/space/errors.js";
import { createHostedTaskService, hostedCanvasContext, type HostedTaskRecord } from "../src/hosted/tasks.js";
import { DecisionTaskManager } from "../src/decision/taskV2.js";
import type { DecisionTrace } from "../src/decision/trace.js";
import type { IntentRequest, IntentResult } from "../src/intent/pipeline.js";

const folders: string[] = [], disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) await dispose();
  for (const folder of folders.splice(0)) {
    const absolute = realpathSync(folder);
    expect(path.dirname(absolute)).toBe(realpathSync(tmpdir()));
    expect(path.basename(absolute)).toMatch(/^vivic-task-conflict-/);
    rmSync(absolute, { recursive: true, force: true });
  }
});
const note = (id: string, text: string) => NoteCardSchema.parse({ id, type: "NoteCard", variant: "minimal", sources: [], sourceData: {},
  displayProps: { text }, layout: { x: 0, y: 0, width: 320, height: 200, pinned: false },
  metadata: { createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z", aliases: ["TEST alias"] } });
const proposal = (request: IntentRequest, text = `TEST planned at version ${request.canvasContext.version}`): IntentResult => {
  const card = note(`planned_${randomUUID()}`, text);
  return { kind: "envelope", envelope: { schemaVersion: "0.6", requestId: randomUUID(), canvasId: request.canvasContext.canvasId,
    actions: [{ type: "card.create", card }, { type: "card.focus", targetId: card.id }] } };
};
const trace = (id: string, taskId: string): DecisionTrace => ({ id, taskId, mode: "on", status: "complete", clauses: ["TEST goal"],
  decisions: [], route: "note", probability: .99, latencyMs: 1, routeLatencyMs: 1, legacyElapsedMs: 1, shadowWaitMs: 0,
  failedCount: 0, legacyKind: "envelope", legacyUsedProvider: "rules", legacyActionTypes: ["card.create"], legacyCardTypes: ["NoteCard"] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
interface Call { request: IntentRequest; signal?: AbortSignal; result?: IntentResult }
interface Setup {
  plan?: (request: IntentRequest) => Promise<IntentResult>;
  transform?: (request: IntentRequest, result: IntentResult) => IntentResult;
  afterProposal?: (f: Fixture, call: Call) => Promise<void> | void;
  beforeInvoke?: (f: Fixture, call: Call) => Promise<void> | void;
}
async function fixture(options: Setup = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "vivic-task-conflict-")); folders.push(dir);
  const store = new HostedSpaceStore({ dataDir: dir, inviteCode: "TEST-conflict-invitation" });
  const { identity } = await store.register({ invite: "TEST-conflict-invitation", username: "test_conflict", password: "TEST-conflict-password" });
  const writer = await store.login({ username: "test_conflict", password: "TEST-conflict-password", deviceName: "TEST competing device" });
  const accountId = identity.accountId, spaceId = store.listSpaces(accountId)[0]!.id;
  const manager = new DecisionTaskManager(), calls: Call[] = [];
  const legacy = vi.fn(options.plan ?? (async (request: IntentRequest) => proposal(request)));
  let f!: Fixture;
  const invoke = vi.fn(async (_accountId: string, _route: string, body: unknown, signal?: AbortSignal) => {
    const request = body as IntentRequest, call: Call = { request: structuredClone(request), signal }; calls.push(call);
    await options.beforeInvoke?.(f, call);
    let result = await manager.run(request, { legacy }, signal);
    if (options.transform) result = options.transform(request, result);
    if (result.envelope || result.hostOperation) {
      result = { ...result, trace: trace(`trace_${calls.length}`, request.task!.id) }; call.result = result;
      await options.afterProposal?.(f, call);
    }
    return Response.json(result);
  });
  const service = createHostedTaskService({ store, invoke });
  disposals.push(async () => { await service.dispose(); manager.dispose(); store.dispose(); });
  const snapshot = () => store.getSnapshot(accountId, spaceId);
  const read = (id = "TEST-task") => store.getAccountValue<HostedTaskRecord>(accountId, `task:${spaceId}:${id}`)!;
  const start = async (input: { requestId?: string; text?: string; expectedVersion?: number; continuationTaskId?: string } = {}) => {
    const response = await service.handle(new Request(`https://unit.test/api/space/spaces/${spaceId}/tasks`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "TEST-task", text: "创建一张TEST便笺",
        expectedVersion: snapshot().space.version, ...input }),
    }), identity);
    expect(response!.status).toBe(202);
  };
  const cancel = (id = "TEST-task") => service.handle(new Request(`https://unit.test/api/space/spaces/${spaceId}/tasks/${id}/cancel`, { method: "POST" }), identity);
  const wait = async (id = "TEST-task") => { await vi.waitFor(() => expect(service.activeCount()).toBe(0)); return read(id); };
  const bump = () => store.applyCommand(accountId, spaceId, { requestId: randomUUID(), expectedVersion: snapshot().space.version,
    command: { type: "note.create", text: "TEST another device's edit" } }, writer.identity.device.id);
  f = { store, manager, service, identity, accountId, spaceId, calls, legacy, invoke, snapshot, read, start, cancel, wait, bump };
  return f;
}
type Fixture = {
  store: HostedSpaceStore; manager: DecisionTaskManager; service: ReturnType<typeof createHostedTaskService>;
  identity: Awaited<ReturnType<HostedSpaceStore["register"]>>["identity"]; accountId: string; spaceId: string;
  calls: Call[]; legacy: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn>;
  snapshot: () => ReturnType<HostedSpaceStore["getSnapshot"]>;
  read: (id?: string) => HostedTaskRecord; start: (input?: { requestId?: string; text?: string; expectedVersion?: number; continuationTaskId?: string }) => Promise<void>;
  cancel: (id?: string) => Promise<Response | null>; wait: (id?: string) => Promise<HostedTaskRecord>; bump: () => unknown;
};
const proposals = (f: Fixture) => f.calls.filter(call => call.result?.envelope || call.result?.hostOperation);
const cancellations = (f: Fixture) => f.calls.filter(call => call.request.task?.cancel);
const plannedCards = (f: Fixture) => f.snapshot().space.cards.filter(card => card.id.startsWith("planned_"));

describe("hosted task conflict replanning against the real store and DecisionTaskManager", () => {
  it("uses a fresh snapshot for an initially stale expectedVersion and includes real metadata aliases", async () => {
    const f = await fixture(); f.bump();
    await f.start({ expectedVersion: 0 }); const task = await f.wait();
    expect(task.status).toBe("succeeded"); expect(task.conflictRetries).toBe(0);
    expect(f.calls[0].request.canvasContext.version).toBe(1);
    expect(cancellations(f)).toEqual([]); expect(plannedCards(f)).toHaveLength(1);
    expect(hostedCanvasContext(f.snapshot()).cards.find(card => card.id === task.createdCardIds[0])?.aliases).toEqual(["TEST alias"]);
  });

  it("cancels the cached stale proposal, replans with a new internal id, and marks only the actual proposal successful", async () => {
    let races = 0;
    const f = await fixture({ afterProposal: current => { if (races++ === 0) current.bump(); } });
    await f.start(); const task = await f.wait(), plans = proposals(f);
    expect(task.status).toBe("succeeded"); expect(plans).toHaveLength(2);
    expect(plans.map(call => call.request.canvasContext.version)).toEqual([0, 1]);
    expect(plans[1].request.task!.id).not.toBe(plans[0].request.task!.id);
    expect(cancellations(f).map(call => call.request.task!.id)).toEqual([plans[0].request.task!.id]);
    expect(plans[1].request.task!.receipt).toBeUndefined();
    const firstId = plans[0].result!.envelope!.actions.find(action => action.type === "card.create")!;
    expect(task.executions).toEqual([plans[1].result!.task!.executionId]);
    expect(task.createdCardIds).toEqual(plannedCards(f).map(card => card.id));
    expect(task.createdCardIds).toHaveLength(1);
    if (firstId.type === "card.create") expect(task.createdCardIds).not.toContain(firstId.card.id);
    expect(f.legacy).toHaveBeenCalledTimes(2);
    const old = await f.manager.run(plans[0].request, { legacy: async () => { throw new Error("TEST old task must stay cancelled"); } });
    expect(old.task?.status).toBe("cancelled");
    const logs = f.store.listDecisionLogs(f.accountId);
    expect(logs.find(row => row.trace.id === plans[0].result!.trace!.id)?.outcome).toBe("conflict");
    expect(logs.find(row => row.trace.id === plans[1].result!.trace!.id)?.outcome).toBe("succeeded");
  });

  it("permits exactly two replans and succeeds on the third proposal", async () => {
    let races = 0;
    const f = await fixture({ afterProposal: current => { if (races++ < 2) current.bump(); } });
    await f.start(); const task = await f.wait();
    expect(task.status).toBe("succeeded"); expect(task.conflictRetries).toBe(2);
    expect(proposals(f).map(call => call.request.canvasContext.version)).toEqual([0, 1, 2]);
    expect(new Set(proposals(f).map(call => call.request.task!.id)).size).toBe(3);
    expect(cancellations(f)).toHaveLength(2); expect(plannedCards(f)).toHaveLength(1);
    expect(task.executions).toHaveLength(1);
  });

  it("stops after two replans when all three real version races conflict", async () => {
    const f = await fixture({ afterProposal: current => { current.bump(); } });
    await f.start(); const task = await f.wait();
    expect(task.status).toBe("failed"); expect(task.message).toContain("两次重新规划");
    expect(task.conflictRetries).toBe(2); expect(proposals(f)).toHaveLength(3); expect(cancellations(f)).toHaveLength(3);
    expect(task.createdCardIds).toEqual([]); expect(task.executions).toEqual([]); expect(plannedCards(f)).toEqual([]);
    expect(f.store.listDecisionLogs(f.accountId).map(row => row.outcome)).toEqual(["conflict", "conflict", "conflict"]);
    expect(f.calls.filter(call => call.request.task?.receipt)).toEqual([]);
  });

  it("does not leak JavaScript execution/focus/card ids from a rolled back transaction into the retry", async () => {
    const f = await fixture(), original = f.store.setAccountValue.bind(f.store); let fail = true;
    vi.spyOn(f.store, "setAccountValue").mockImplementation((accountId, key, value) => {
      original(accountId, key, value);
      if (fail && key.startsWith("task:") && (value as HostedTaskRecord).executions.length) {
        fail = false; throw new SpaceError(409, "version-conflict", "TEST conflict at outer commit");
      }
    });
    await f.start(); const task = await f.wait();
    expect(task.status).toBe("succeeded"); expect(proposals(f)).toHaveLength(2);
    expect(task.createdCardIds).toEqual(plannedCards(f).map(card => card.id)); expect(task.createdCardIds).toHaveLength(1);
    expect(task.focusCardId).toBe(task.createdCardIds[0]); expect(task.executions).toHaveLength(1);
    expect(proposals(f)[1].request.task?.receipt).toBeUndefined();
    expect(proposals(f)[1].request.text).not.toContain("以下步骤已真实提交");
  });

  it("does not retry an unknown write result or publish uncommitted execution state", async () => {
    const f = await fixture(), original = f.store.applyEnvelope.bind(f.store);
    vi.spyOn(f.store, "applyEnvelope").mockImplementation((...args) => { original(...args); throw new Error("TEST unknown write confirmation"); });
    await f.start(); const task = await f.wait();
    expect(task.status).toBe("failed"); expect(proposals(f)).toHaveLength(1); expect(cancellations(f)).toEqual([]);
    expect(task.createdCardIds).toEqual([]); expect(task.executions).toEqual([]); expect(task.focusCardId).toBeUndefined();
    expect(plannedCards(f)).toEqual([]);
  });

  it("does not retry a non-version 409 rejection", async () => {
    const f = await fixture();
    vi.spyOn(f.store, "applyEnvelope").mockImplementation(() => { throw new SpaceError(409, "invalid-operation", "TEST rejected operation"); });
    await f.start(); const task = await f.wait();
    expect(task.status).toBe("failed"); expect(task.message).toBe("TEST rejected operation");
    expect(proposals(f)).toHaveLength(1); expect(cancellations(f)).toEqual([]); expect(task.executions).toEqual([]);
  });

  it("stops on revocation after planning without retrying or sending a success receipt", async () => {
    const f = await fixture({ afterProposal: current => current.store.revokeDevice(current.accountId, current.identity.device.id, current.identity.device.id) });
    await f.start(); const task = await f.wait();
    expect(task.status).toBe("failed"); expect(task.message).toContain("授权已失效");
    expect(proposals(f)).toHaveLength(1); expect(cancellations(f)).toEqual([]); expect(task.executions).toEqual([]);
  });

  it("cancels while discarding an old proposal even if transport ignores abort, and never starts another proposal", async () => {
    const gate = deferred<void>();
    const f = await fixture({ afterProposal: current => { current.bump(); }, beforeInvoke: async (_f, call) => {
      if (call.request.task?.cancel) await gate.promise;
    } });
    await f.start(); await vi.waitFor(() => expect(cancellations(f)).toHaveLength(1));
    try {
      const cancelled = await f.cancel(); expect(cancelled!.status).toBe(200);
      expect((await f.wait()).status).toBe("cancelled");
      expect(proposals(f)).toHaveLength(1); expect(plannedCards(f)).toEqual([]);
      expect(f.calls.every(call => call.signal === f.calls[0].signal)).toBe(true);
      expect(f.calls[0].signal?.aborted).toBe(true);
    } finally { gate.resolve(); }
  });

  it("keeps all replans inside the original ninety second deadline", async () => {
    const gate = deferred<void>(); let attempts = 0;
    const f = await fixture({ afterProposal: async current => {
      if (++attempts === 1) { await vi.advanceTimersByTimeAsync(60_000); current.bump(); }
      else await gate.promise;
    } });
    vi.useFakeTimers();
    await f.start(); await vi.waitFor(() => expect(proposals(f)).toHaveLength(2));
    try {
      await vi.advanceTimersByTimeAsync(30_001);
      const task = await f.wait(); expect(task.status).toBe("failed"); expect(task.message).toContain("超时");
      expect(task.conflictRetries).toBe(1); expect(task.executions).toEqual([]); expect(plannedCards(f)).toEqual([]);
      expect(f.calls.every(call => call.signal === f.calls[0].signal)).toBe(true);
    } finally { gate.resolve(); }
  });

  it("preserves a successful creation and sends only its real receipt before replanning a conflicting later step", async () => {
    let secondStep = false, raced = false;
    const f = await fixture({ plan: async request => {
      const created = request.canvasContext.cards.find(card => card.id.startsWith("planned_"));
      return created ? { kind: "host-operation", hostOperation: { kind: "card.pin", targetId: created.id, pinned: true } } : proposal(request, "TEST one saved note");
    }, transform: (request, result) => {
      // A scripted second native step; the first proposal/cache/receipt uses the real manager.
      if (request.task?.receipt && result.task?.status === "completed" && !secondStep) {
        secondStep = true;
        return { kind: "host-operation", hostOperation: { kind: "card.pin", targetId: request.task.receipt.createdCardIds![0], pinned: true },
          task: { protocolVersion: "vivic-decision-v2", id: request.task.id, step: 2, status: "awaiting_execution", decision: "native-v2", executionId: "TEST-second-step" } };
      }
      return result;
    }, afterProposal: (current, call) => {
      if (call.result?.hostOperation && !raced) { raced = true; current.bump(); }
    } });
    await f.start({ text: "创建一张TEST便笺并固定它" }); const task = await f.wait();
    expect(task.status).toBe("succeeded"); expect(plannedCards(f)).toHaveLength(1);
    expect(plannedCards(f)[0].layout.pinned).toBe(true); expect(task.createdCardIds).toHaveLength(1); expect(task.executions).toHaveLength(2);
    const retried = proposals(f).at(-1)!;
    expect(retried.request.text).toContain("创建一张TEST便笺并固定它");
    expect(retried.request.text).toContain("以下步骤已真实提交"); expect(retried.request.text).toContain("TEST one saved note");
    expect(retried.request.task!.receipt).toBeUndefined();
    expect(f.calls.filter(call => call.request.task?.receipt).every(call => call.request.task!.receipt!.executionId !== "TEST-second-step")).toBe(true);
  });

  it.each(["note", "todo", "timer"])("rejects a regenerated committed %s step despite fresh ids/start times", async kind => {
    let secondStep = false, raced = false, generation = 0;
    const f = await fixture({ plan: async request => {
      const result = proposal(request, "TEST identical saved content"), create = result.envelope!.actions[0]; generation++;
      if (create.type !== "card.create") throw new Error("TEST expected creation");
      if (kind === "todo") create.card = TodoCardSchema.parse({ ...create.card, type: "TodoCard", displayProps: { items: [{ id: randomUUID(), text: "TEST same item", done: false }] } });
      if (kind === "timer") create.card = CountdownCardSchema.parse({ ...create.card, type: "CountdownCard", displayProps: {}, sourceData: {
        startedAt: new Date(generation * 1000).toISOString(), targetAt: new Date(generation * 1000 + 60_000).toISOString() } });
      return result;
    }, transform: (request, result) => {
      if (request.task?.receipt && result.task?.status === "completed" && !secondStep) {
        secondStep = true;
        return { ...proposal(request, "TEST second pending content"), task: { protocolVersion: "vivic-decision-v2", id: request.task.id,
          step: 2, status: "awaiting_execution", decision: "native-v2", executionId: "TEST-second-step" } };
      }
      return result;
    }, afterProposal: (current, call) => { if (call.result?.task?.executionId === "TEST-second-step" && !raced) { raced = true; current.bump(); } } });
    await f.start(); const task = await f.wait();
    expect(task.status).toBe("failed"); expect(task.message).toContain("已保存的步骤");
    expect(plannedCards(f)).toHaveLength(1); expect(task.executions).toHaveLength(1); expect(task.createdCardIds).toHaveLength(1);
    expect(f.store.listDecisionLogs(f.accountId).filter(row => row.outcome === "succeeded")).toHaveLength(1);
  });

  it("retains the original goal, clarification question and answer when a continued task must replan", async () => {
    let race = false;
    const f = await fixture({ plan: async request => request.text === "记录一条便笺" ? { kind: "clarify", message: "便笺写什么？" } : proposal(request, "TEST clarification answer"),
      afterProposal: current => { if (!race) { race = true; current.bump(); } } });
    await f.start({ requestId: "question", text: "记录一条便笺" }); expect((await f.wait("question")).status).toBe("awaiting_clarification");
    await f.start({ requestId: "answer", text: "TEST clarification answer", continuationTaskId: "question" });
    const task = await f.wait("answer"); expect(task.status).toBe("succeeded");
    const retried = proposals(f).at(-1)!.request;
    expect(retried.text).toContain("记录一条便笺"); expect(retried.text).toContain("便笺写什么？"); expect(retried.text).toContain("TEST clarification answer");
    expect(retried.task!.id).not.toBe("question"); expect(retried.task!.receipt).toBeUndefined();
  });

  it("keeps frozen clarification candidate ids with a numbered answer after the snapshot order changes", async () => {
    const first = note("TEST-choice-first", "TEST first"), second = note("TEST-choice-second", "TEST second");
    let race = false;
    const f = await fixture({ plan: async request => request.text === "聚焦那张便笺" ? { kind: "clarify", message: "请选择便笺。" }
      : { kind: "envelope", envelope: { schemaVersion: "0.6", requestId: randomUUID(), canvasId: request.canvasContext.canvasId,
        actions: [{ type: "card.focus", targetId: second.id }] } }, transform: (request, result) => {
      if (request.text === "聚焦那张便笺" && result.task?.status === "awaiting_clarification") return { ...result,
        task: { ...result.task, clarification: { question: "请选择便笺。", candidates: [
          { number: 1, id: first.id, label: "TEST first" }, { number: 2, id: second.id, label: "TEST second" }] } } };
      return result;
    }, afterProposal: current => {
      if (!race) {
        race = true;
        current.store.applyCommand(current.accountId, current.spaceId, { requestId: randomUUID(), expectedVersion: current.snapshot().space.version,
          command: { type: "card.pin", cardId: second.id, pinned: true } }, current.identity.device.id);
      }
    } });
    const requestId = randomUUID(); f.store.applyEnvelope(f.accountId, f.spaceId, { requestId, expectedVersion: 0,
      envelope: { schemaVersion: "0.6", requestId, canvasId: f.spaceId, actions: [first, second].map(card => ({ type: "card.create", card })) } }, f.identity.device.id);
    await f.start({ requestId: "question", text: "聚焦那张便笺" }); await f.wait("question");
    await f.start({ requestId: "answer", text: "2", continuationTaskId: "question" }); const task = await f.wait("answer");
    expect(task.status).toBe("succeeded"); expect(task.focusCardId).toBe(second.id);
    const retried = proposals(f).at(-1)!.request;
    expect(retried.text).toContain(`1=${first.id}（TEST first）`); expect(retried.text).toContain(`2=${second.id}（TEST second）`);
    expect(retried.text).toContain("答复：2"); expect(retried.canvasContext.cards[0].id).not.toBe(first.id);
  });

  it("does not truncate a maximum-length initial goal when changing the internal task id", async () => {
    let raced = false;
    const f = await fixture({ afterProposal: current => { if (!raced) { raced = true; current.bump(); } } });
    const goal = "测".repeat(500);
    await f.start({ text: goal }); expect((await f.wait()).status).toBe("succeeded");
    expect(proposals(f).at(-1)!.request.text).toBe(goal);
  });

  it("stops explicitly if the full clarification/execution history cannot fit the intent text bound", async () => {
    const original = "原".repeat(400), answer = "答".repeat(300);
    const f = await fixture({ plan: async request => request.text === original ? { kind: "clarify", message: "请补充材料。" } : proposal(request),
      afterProposal: current => { current.bump(); } });
    await f.start({ requestId: "question", text: original }); await f.wait("question");
    await f.start({ requestId: "answer", text: answer, continuationTaskId: "question" });
    const task = await f.wait("answer"); expect(task.status).toBe("failed"); expect(task.message).toContain("无法安全自动重规划");
    expect(task.turns!.map(turn => turn.text)).toEqual([original, answer]);
    expect(proposals(f)).toHaveLength(1); expect(cancellations(f)).toHaveLength(1); expect(plannedCards(f)).toEqual([]);
  });
});
