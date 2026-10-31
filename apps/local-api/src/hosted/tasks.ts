import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { resumeReminderSource, type CardRecord, type DecisionTaskStatus, type HostedSpaceSnapshot, type HostOperation } from "@vivic/contracts";
import { IntentResponseSchema, type CanvasContext, type IntentResponse } from "../schemas.js";
import { hostOperationIssue } from "../decision/hostOperations.js";
import { createBudget } from "../intent/budget.js";
import { SpaceError } from "../space/errors.js";
import type { HostedSpaceStore, SpaceIdentity } from "../space/store.js";
import { hostedBody, hostedJson } from "./http.js";

export interface HostedTaskRecord {
  id: string; spaceId: string; accountId: string; deviceId: string; businessTaskId: string;
  status: "accepted" | "running" | "awaiting_clarification" | "succeeded" | "failed" | "cancelled" | "unknown";
  message: string; text: string; fingerprint: string; expectedVersion: number; createdAt: number;
  createdCardIds: string[]; focusCardId?: string; executions: string[];
  turns?: Array<{ text: string; question?: string; candidates?: NonNullable<DecisionTaskStatus["clarification"]>["candidates"] }>;
  clarification?: DecisionTaskStatus["clarification"];
  completedSteps?: string[]; executionSignatures?: string[]; conflictRetries?: number;
}
export type HostedInvoke = (accountId: string, route: string, body: unknown, signal?: AbortSignal) => Promise<Response>;
const TaskInput = z.strictObject({ requestId: z.string().min(1).max(128), text: z.string().trim().min(1).max(500),
  expectedVersion: z.int().min(0), continuationTaskId: z.string().min(1).max(128).optional() });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const executionSignature = (value: unknown) => digest(JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));
function createdContent(card: CardRecord) {
  let sourceData: Record<string, unknown> = card.sourceData;
  let displayProps: Record<string, unknown> = card.displayProps;
  if (card.type === "TodoCard") displayProps = { ...card.displayProps, items: card.displayProps.items.map(({ id: _id, ...item }) => item) };
  if (card.type === "CountdownCard" && !sourceData.event && typeof sourceData.startedAt === "string" && typeof sourceData.targetAt === "string") {
    const { startedAt, targetAt, ...rest } = sourceData;
    sourceData = { ...rest, durationMs: Date.parse(targetAt) - Date.parse(startedAt) };
  }
  // Ignore program-generated todo row IDs and relative timer start times, retaining business IDs.
  return { type: "card.create", cardType: card.type, displayProps, sourceData };
}
const taskKey = (spaceId: string, id: string) => `task:${spaceId}:${id}`;
const publicTask = (task: HostedTaskRecord) => ({ id: task.id, status: task.status, message: task.message,
  ...(task.createdCardIds.length ? { createdCardIds: task.createdCardIds } : {}), ...(task.focusCardId ? { focusCardId: task.focusCardId } : {}) });
const terminal = (task: HostedTaskRecord) => ["succeeded", "failed", "cancelled", "unknown", "awaiting_clarification"].includes(task.status);

function summarize(record: Record<string, unknown>) {
  const truncatedFields: string[] = [];
  const visit = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return value.length > 400 ? `${value.slice(0, 399)}…` : value;
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return depth > 3 ? `[${value.length}项]` : value.slice(0, 12).map(item => visit(item, depth + 1));
    if (value && typeof value === "object") return depth > 3 ? "[部分内容]" : Object.fromEntries(Object.entries(value).slice(0, 24)
      .filter(([key]) => !/api.?key|token|secret|password|credential|authorization|cookie|__proto__|constructor|prototype/i.test(key))
      .map(([key, item]) => [key, visit(item, depth + 1)]));
    return undefined;
  };
  const value = Object.fromEntries(Object.entries(record).map(([key, item]) => {
    const next = visit(item, 0); if (JSON.stringify(item) !== JSON.stringify(next)) truncatedFields.push(key); return [key, next];
  }));
  return { value, truncatedFields };
}
export function hostedCanvasContext(snapshot: HostedSpaceSnapshot): CanvasContext {
  const selected = [...snapshot.space.cards].sort((a, b) => Number(b.layout.pinned) - Number(a.layout.pinned) || b.metadata.updatedAt.localeCompare(a.metadata.updatedAt));
  const cards: CanvasContext["cards"] = []; let bytes = 0;
  for (const card of selected) {
    const display = summarize(card.displayProps), source = summarize(card.sourceData);
    const value: CanvasContext["cards"][number] = { id: card.id, type: card.type,
      ...(card.metadata.aliases ? { aliases: card.metadata.aliases.slice(0, 12) } : {}), displayProps: display.value,
      sourceDataSummary: source.value, layout: { x: card.layout.x, y: card.layout.y, width: card.layout.width,
        height: card.layout.height, pinned: card.layout.pinned }, surface: "display",
      ...(display.truncatedFields.length ? { contextSummary: { truncatedFields: display.truncatedFields } } : {}) };
    const size = Buffer.byteLength(JSON.stringify(value));
    if (cards.length >= 64 || bytes + size > 48_000) break;
    cards.push(value); bytes += size;
  }
  return { canvasId: snapshot.space.id, version: snapshot.space.version, stage: snapshot.space.cards.length ? "WORKSPACE" : "STANDBY",
    viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: "Asia/Shanghai", cards,
    ...(cards.length < snapshot.space.cards.length ? { totalCardCount: snapshot.space.cards.length } : {}) };
}

export function createHostedTaskService(options: { store: HostedSpaceStore; invoke: HostedInvoke; now?: () => number }) {
  const { store, invoke } = options, now = options.now ?? Date.now;
  const active = new Map<string, { controller: AbortController; task: HostedTaskRecord; done: Promise<void> }>();
  let closed = false;
  const read = (accountId: string, spaceId: string, id: string) => store.getAccountValue<HostedTaskRecord>(accountId, taskKey(spaceId, id));
  const save = (task: HostedTaskRecord) => store.setAccountValue(task.accountId, taskKey(task.spaceId, task.id), task);
  function current(task: HostedTaskRecord, signal: AbortSignal) { signal.throwIfAborted(); store.assertDeviceActive(task.accountId, task.deviceId); }
  function runOperation(task: HostedTaskRecord, operation: HostOperation, requestId: string, version: number) {
    const snapshot = store.getSnapshot(task.accountId, task.spaceId), context = hostedCanvasContext(snapshot);
    const issue = hostOperationIssue(operation, context);
    if (issue) throw new SpaceError(409, "invalid-operation", issue);
    const apply = (command: Parameters<HostedSpaceStore["applyCommand"]>[2]["command"]) => store.applyCommand(task.accountId, task.spaceId,
      { requestId, expectedVersion: version, command }, task.deviceId);
    if (operation.kind === "history.undo" || operation.kind === "history.redo") return apply({ type: operation.kind });
    if (operation.kind === "canvas.arrange") return apply({ type: "canvas.arrange" });
    if (operation.kind === "canvas.organize.preview" || operation.kind === "ambient.control") throw new SpaceError(409, "view-action", "请在大屏打开对应空间操作，尚未应用此界面修改。");
    const card = snapshot.space.cards.find(value => value.id === operation.targetId);
    if (!card) throw new SpaceError(409, "missing-target", "目标卡片已经变化，请重新选择。");
    if (operation.kind === "card.pin") return apply({ type: "card.pin", cardId: card.id, pinned: operation.pinned });
    if (operation.kind === "card.surface") {
      if (operation.surface !== "display") throw new SpaceError(409, "space-only", "卡片统一保存在Space，请打开Space查看。");
      task.focusCardId = card.id; return undefined;
    }
    if (operation.kind === "card.move") {
      const anchor = operation.relativeTo ? snapshot.space.cards.find(value => value.id === operation.relativeTo) : card;
      if (!anchor) throw new SpaceError(409, "missing-target", "相对目标已不存在。");
      const horizontal = ["left", "right"].includes(operation.direction), sign = ["left", "up"].includes(operation.direction) ? -1 : 1;
      let x = anchor.layout.x + (horizontal ? sign * ((sign < 0 ? card : anchor).layout.width + 24) : 0);
      let y = anchor.layout.y + (!horizontal ? sign * ((sign < 0 ? card : anchor).layout.height + 24) : 0);
      for (let slot = 0; slot < 64; slot++) {
        if (!snapshot.space.cards.some(other => other.id !== card.id && x < other.layout.x + other.layout.width + 24
          && x + card.layout.width + 24 > other.layout.x && y < other.layout.y + other.layout.height + 24 && y + card.layout.height + 24 > other.layout.y))
          return apply({ type: "card.move", cardId: card.id, x, y });
        if (horizontal) y += card.layout.height + 24; else x += card.layout.width + 24;
      }
      throw new SpaceError(409, "layout-full", "附近没有足够位置，请手动调整。");
    }
    if (operation.kind === "countdown.pause" || operation.kind === "countdown.resume") {
      if (card.type !== "CountdownCard") throw new SpaceError(409, "invalid-target", "目标不是计时卡片。");
      if (operation.kind === "countdown.pause") return apply({ type: "card.update", cardId: card.id, sourceData: { pausedAt: new Date(now()).toISOString() } });
      // Only this validated internal operation may reset delivery stamps. Public card.update remains restricted.
      return store.applyEnvelope(task.accountId, task.spaceId, { requestId, expectedVersion: version,
        envelope: { schemaVersion: "0.6", requestId, canvasId: task.spaceId, actions: [{ type: "card.update", targetId: card.id,
          sourceData: resumeReminderSource(card, now()) }] } }, task.deviceId);
    }
    throw new SpaceError(409, "unsupported-operation", "此操作暂不支持，未更改Space。");
  }
  async function run(task: HostedTaskRecord, signal: AbortSignal) {
    const budget = createBudget(90_000, [signal]); signal = budget.signal;
    const traces = new Map<string, { taskId: string; outcome?: string }>();
    let continuation: { id: string; receipt?: { executionId: string; status: "succeeded"; createdCardIds: string[] } } = { id: task.businessTaskId };
    let planningText = task.text;
    const invokeIntent = (body: unknown) => budget.run(async () => {
      current(task, signal);
      const response = await invoke(task.accountId, "/api/intent", body, signal);
      const raw: unknown = await response.json();
      if (!response.ok) {
        if (response.status === 409 && raw && typeof raw === "object" && "code" in raw && raw.code === "version-conflict")
          throw new SpaceError(409, "version-conflict", "空间在规划期间已更新，旧提案未应用。");
        throw new SpaceError(503, "planner-unavailable", "模型请求暂未完成，请检查连接或稍后重试。");
      }
      return IntentResponseSchema.parse(raw);
    });
    const mark = (taskId: string, outcome: string) => {
      for (const [traceId, trace] of traces) if (trace.taskId === taskId && !trace.outcome) {
        trace.outcome = outcome;
        try { store.setDecisionOutcome(task.accountId, traceId, outcome); } catch { /* advisory */ }
      }
      // Covers traces delivered asynchronously by the hosted observer as well.
      try { store.setDecisionTaskOutcome(task.accountId, taskId, outcome === "succeeded" ? "succeeded" : "failed"); } catch { /* advisory */ }
    };
    const replan = async () => {
      current(task, signal);
      const oldId = continuation.id;
      mark(oldId, "conflict");
      const cancelled = await invokeIntent({ text: planningText, canvasContext: hostedCanvasContext(store.getSnapshot(task.accountId, task.spaceId)), task: { id: oldId, cancel: true } });
      current(task, signal);
      if (cancelled.task?.status !== "cancelled" || cancelled.task.id !== oldId)
        throw new SpaceError(409, "proposal-cancel-failed", "旧提案未确认取消，已停止自动重试；请核对Space。");
      if ((task.conflictRetries ?? 0) >= 2)
        throw new SpaceError(409, "version-conflict", "空间连续变化，两次重新规划后仍有版本冲突；已停止后续操作，已保存步骤保留。");
      const turns = task.turns ?? [{ text: task.text }];
      planningText = turns.length === 1 && !task.completedSteps?.length ? turns[0].text
        : ["原请求及补充（以最新答复为准）：", ...turns.map(turn => `${turn.question ? `问题：${turn.question}\n${turn.candidates?.length ? `当时编号：${turn.candidates.map(candidate => `${candidate.number}=${candidate.id}（${candidate.label}）`).join("、")}\n` : ""}答复：` : ""}${turn.text}`),
          ...(task.completedSteps?.length ? ["以下步骤已真实提交，仅完成剩余要求，禁止重复：", ...task.completedSteps] : [])].join("\n");
      // Never silently truncate a goal, a numbered answer, or the real execution history.
      if (planningText.length > 500) throw new SpaceError(409, "replan-context-limit", "原目标和已保存步骤较长，无法安全自动重规划；请核对Space后仅重发剩余要求。");
      task.businessTaskId = `retry_${randomUUID()}`;
      task.conflictRetries = (task.conflictRetries ?? 0) + 1;
      task.expectedVersion = store.getSnapshot(task.accountId, task.spaceId).space.version;
      continuation = { id: task.businessTaskId }; save(task);
    };
    try {
      task.status = "running"; task.message = "正在处理…"; save(task);
      for (let step = 0; step < 12; step++) {
        current(task, signal);
        const snapshot = store.getSnapshot(task.accountId, task.spaceId);
        if (step === 0 && snapshot.space.version !== task.expectedVersion) { task.expectedVersion = snapshot.space.version; save(task); }
        let result: IntentResponse;
        try { result = await invokeIntent({ text: planningText, canvasContext: hostedCanvasContext(snapshot), task: continuation }); }
        catch (error) {
          if (!(error instanceof SpaceError) || error.code !== "version-conflict" || error.status !== 409) throw error;
          await replan(); step--; continue;
        }
        if (result.trace) {
          traces.set(result.trace.id, { taskId: continuation.id });
          try { store.recordDecisionLog(task.accountId, { spaceId: task.spaceId, path: "task", text: task.text, trace: result.trace, outcome: "pending" }); }
          catch { /* logging does not affect task execution */ }
        }
        current(task, signal);
        if (result.kind === "clarify" || result.task?.status === "awaiting_clarification") {
          task.status = "awaiting_clarification"; task.message = result.message ?? "请补充这次操作的具体要求。";
          task.clarification = result.task?.clarification; save(task); return;
        }
        if (result.task?.status === "cancelled") { task.status = "cancelled"; task.message = result.message ?? "已取消尚未执行的操作。"; save(task); return; }
        if (result.kind === "error" || result.kind === "unknown" || result.task?.status === "failed") {
          task.status = "failed"; task.message = result.message ?? "未执行这次操作，请补充要求。"; save(task); return;
        }
        if (result.envelope || result.hostOperation) {
          const executionId = result.task?.executionId ?? `step_${digest({ task: task.id, step, proposal: continuation.id })}`;
          const commandId = `exec_${digest({ task: task.id, executionId })}`;
          const mutation = result.envelope?.actions.filter(action => !["card.focus", "card.highlight", "canvas.fit", "canvas.restore", "stage.awaken", "stage.sleep", "subtitle.show", "subtitle.hide"].includes(action.type)) ?? [];
          const operations = result.hostOperation ? [result.hostOperation] : mutation.map(action => action.type === "card.create"
            ? createdContent(action.card) : action);
          const signatures = operations.map(executionSignature);
          const next = structuredClone(task);
          try { store.transaction(() => {
            current(task, signal);
            if (store.getSnapshot(task.accountId, task.spaceId).space.version !== snapshot.space.version) throw new SpaceError(409, "version-conflict", "空间在处理期间已更新，旧提案未应用。");
            if (task.executions.includes(executionId)) throw new SpaceError(409, "repeated-step", "服务返回了重复步骤，已停止后续执行。");
            if (task.conflictRetries && signatures.some(signature => task.executionSignatures?.includes(signature)))
              throw new SpaceError(409, "repeated-step", "重新规划包含已保存的步骤，已停止以免重复执行；请仅重发剩余要求。");
            if (result.envelope) {
              const actions = result.envelope.actions;
              const focus = actions.findLast(action => action.type === "card.focus");
              if (focus?.type === "card.focus") next.focusCardId = focus.targetId;
              if (mutation.length) {
                store.applyEnvelope(task.accountId, task.spaceId, { requestId: commandId, expectedVersion: snapshot.space.version,
                  envelope: { ...result.envelope, requestId: commandId, actions: mutation } }, task.deviceId);
                next.createdCardIds.push(...mutation.flatMap(action => action.type === "card.create" ? [action.card.id] : []));
              }
            } else runOperation(next, result.hostOperation!, commandId, snapshot.space.version);
            next.executions.push(executionId); next.executionSignatures = [...next.executionSignatures ?? [], ...signatures];
            next.completedSteps = [...next.completedSteps ?? [], ...(result.hostOperation ? [JSON.stringify(result.hostOperation)] : mutation.map((action, index) =>
              JSON.stringify(action.type === "card.create" ? { ...operations[index], cardId: action.card.id } : operations[index])))];
            next.message = next.focusCardId ? "已找到卡片，打开Space查看。" : result.envelope?.spokenText ?? "已执行并保存。"; save(next);
          }); } catch (error) {
            if (!(error instanceof SpaceError) || error.code !== "version-conflict" || error.status !== 409) throw error;
            await replan(); step--; continue;
          }
          Object.assign(task, next);
          mark(continuation.id, "succeeded");
          if (!result.task) { task.status = "succeeded"; save(task); return; }
          continuation = { id: task.businessTaskId, receipt: { executionId, status: "succeeded", createdCardIds: [...task.createdCardIds] } };
          continue;
        }
        task.status = "succeeded"; task.message = task.focusCardId ? "已找到卡片，打开Space查看。" : result.message ?? "已完成。"; save(task); return;
      }
      task.status = "failed"; task.message = "本次步骤较多，已停止后续操作；已保存内容保留。"; save(task);
    } catch (error) {
      const timedOut = signal.aborted && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
      task.status = signal.aborted && !timedOut ? "cancelled" : "failed";
      task.message = timedOut ? "本次处理超时，后续已停止；请核对已有内容，已保存步骤保留。"
        : signal.aborted ? (task.executions.length ? "后续操作已取消，已保存的变化保留。" : "已取消尚未执行的操作。")
        : error instanceof SpaceError ? error.message : "本次处理或保存未完成，请检查已有内容后重试。";
      try { save(task); } catch { /* A lost storage confirmation is reported as unknown on a later query. */ }
    } finally {
      const outcome = task.status === "awaiting_clarification" ? "clarify"
        : task.status === "succeeded" ? "succeeded" : task.status === "running" ? "pending" : "failed";
      for (const [traceId, trace] of traces) if (!trace.outcome) {
        try { store.setDecisionOutcome(task.accountId, traceId, outcome); }
        catch { /* telemetry does not change the task outcome */ }
      }
      budget.dispose();
    }
  }
  async function handle(request: Request, identity: SpaceIdentity): Promise<Response | null> {
    const match = /^\/api\/space\/spaces\/([^/]+)\/tasks(?:\/([^/]+))?(?:\/(cancel))?$/.exec(new URL(request.url).pathname);
    if (!match) return null;
    const [, spaceId, id, cancel] = match;
    store.assertDeviceActive(identity.accountId, identity.device.id); store.getSnapshot(identity.accountId, spaceId!);
    const responseFor = (task: HostedTaskRecord, status = 200) => hostedJson({ task: publicTask(task), snapshot: store.getSnapshot(identity.accountId, spaceId!) }, status);
    if (id) {
      const task = read(identity.accountId, spaceId!, id);
      if (!task) throw new SpaceError(404, "task-not-found", "没有这个任务记录，请检查原请求。");
      if (!terminal(task) && !active.has(`${identity.accountId}:${spaceId}`)) {
        task.status = "unknown"; task.message = "服务曾中断，已保存步骤保留，请核对Space后重新发起未完成要求。"; save(task);
      }
      if (cancel && request.method === "POST") {
        const job = active.get(`${identity.accountId}:${spaceId}`);
        if (job?.task.id === id) { job.controller.abort(); await job.done; }
        else if (task.status === "awaiting_clarification") { task.status = "cancelled"; task.message = "已取消待补充的问题。"; save(task); }
        else if (task.status === "unknown") { task.status = "cancelled"; task.message = "已取消中断任务的后续操作，已保存的变化与回执保留。"; save(task); }
        return responseFor(read(identity.accountId, spaceId!, id)!);
      }
      if (!cancel && request.method === "GET") return responseFor(task);
      throw new SpaceError(405, "method-not-allowed", "此任务操作不可用。");
    }
    if (request.method !== "POST" || closed) throw new SpaceError(closed ? 503 : 405, "task-unavailable", "暂时无法提交任务。");
    const parsed = TaskInput.safeParse(await hostedBody(request));
    if (!parsed.success) throw new SpaceError(400, "invalid-task", "指令最多500字，需要有效请求编号和空间版本。");
    const input = parsed.data, fingerprint = digest(input), prior = read(identity.accountId, spaceId!, input.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new SpaceError(409, "request-id-conflict", "此请求编号已用于其他指令。");
      return responseFor(prior);
    }
    const scope = `${identity.accountId}:${spaceId}`;
    if (active.has(scope) || active.size >= 8) throw new SpaceError(429, "task-busy", "已有任务正在处理，请先等待结果或取消。");
    const previous = input.continuationTaskId ? read(identity.accountId, spaceId!, input.continuationTaskId) : undefined;
    if (input.continuationTaskId && previous?.status !== "awaiting_clarification") throw new SpaceError(409, "stale-clarification", "原问题已结束或失效，请重新发送完整要求。");
    const task: HostedTaskRecord = { ...input, id: input.requestId, spaceId: spaceId!, accountId: identity.accountId, deviceId: identity.device.id,
      businessTaskId: previous?.businessTaskId ?? input.requestId, status: "accepted", message: "已接受，正在等待处理。", fingerprint,
      createdAt: now(), createdCardIds: [...previous?.createdCardIds ?? []], executions: [...previous?.executions ?? []],
      turns: [...previous?.turns ?? (previous ? [{ text: previous.text }] : []), { text: input.text,
        ...(previous ? { question: previous.clarification?.question ?? previous.message, candidates: previous.clarification?.candidates } : {}) }],
      completedSteps: [...previous?.completedSteps ?? []], executionSignatures: [...previous?.executionSignatures ?? []], conflictRetries: previous?.conflictRetries ?? 0 };
    store.transaction(() => { store.assertDeviceActive(identity.accountId, identity.device.id); save(task);
      if (previous) { previous.status = "cancelled"; previous.message = "已通过后续答复继续此问题。"; save(previous); } });
    const controller = new AbortController(), job = { controller, task, done: Promise.resolve() };
    const deadline = setTimeout(() => controller.abort(new DOMException("Task budget exceeded", "TimeoutError")), 90_000); deadline.unref();
    active.set(scope, job);
    job.done = Promise.resolve().then(() => run(task, controller.signal)).finally(() => { clearTimeout(deadline); if (active.get(scope) === job) active.delete(scope); });
    return responseFor(task, 202);
  }
  return { handle, activeCount: () => active.size, async dispose() { closed = true; for (const job of active.values()) job.controller.abort(); await Promise.allSettled([...active.values()].map(job => job.done)); } };
}
