import type { DecisionExecutionReceipt, DecisionTaskRequest } from "@vivic/contracts";
import { canvasStore, type CanvasStore } from "@/state/canvasStore";
import type { ControlHost } from "@/sync/controlHost";
import { buildCanvasContext, postIntent, type IntentResult } from "./api";
import { IntentResultSchema } from "./intentStream";
import { executeHostOperation } from "./hostOperation";
import { newId } from "@/lib/id";
import { z } from "zod";
import { taskPreflight } from "./taskPreflight";
import { focusResponseActions } from "@/commands/responseFocus";

type SavedReceipt = { fingerprint: string; canvasId: string; receipt: DecisionExecutionReceipt; applied: boolean; at: number };
const receipts = new WeakMap<ControlHost, Map<string, SavedReceipt>>();
export interface DecisionTaskOptions {
  host: ControlHost; text: string; signal: AbortSignal; isCurrent(): boolean;
  taskId?: string; store?: CanvasStore; request?: typeof postIntent;
  withCommit?<T>(write: () => T): T;
  attachments?: Parameters<typeof postIntent>[3]; continuation?: Parameters<typeof postIntent>[4];
  deviceLocation?: Parameters<typeof postIntent>[5]; onProgress?: Parameters<typeof postIntent>[6];
}
export type DecisionTaskResult = IntentResult & { executed?: boolean; handled?: boolean };

export async function cancelDecisionTask(host: ControlHost, id: string) {
  const snapshot = host.getSnapshot();
  if (!snapshot.activeCanvasId) return;
  await postIntent("取消", buildCanvasContext(canvasStore.getState(), snapshot.activeCanvasId), AbortSignal.timeout(2000),
    undefined, undefined, undefined, undefined, { id, cancel: true }).catch(() => {});
}

/** Both desktop and phone use this owner-only, receipt-driven execution loop. */
export async function runDecisionTask(options: DecisionTaskOptions): Promise<DecisionTaskResult> {
  const { host, text, signal } = options, store = options.store ?? canvasStore, request = options.request ?? postIntent;
  const initial = host.getSnapshot(), canvasId = initial.activeCanvasId, ownerId = initial.ownerId;
  if (!canvasId || initial.ownerMode !== "owner") return { kind: "error", message: "请先回到已连接的工作空间。" };
  const id = options.taskId ?? newId("task");
  let task: DecisionTaskRequest = { id }, executed = false, lastMessage = "", finished = false, received = false;
  const current = () => !signal.aborted && options.isCurrent() && host.getSnapshot().activeCanvasId === canvasId && host.getSnapshot().ownerId === ownerId && host.getSnapshot().ownerMode === "owner";
  const version = () => host.getSnapshot().canvases.find(canvas => canvas.id === canvasId)?.version ?? 0;
  const context = () => buildCanvasContext(store.getState(), canvasId, version());
  const ledger = receipts.get(host) ?? new Map<string, SavedReceipt>(); receipts.set(host, ledger);
  // Server tasks expire after ten minutes; retain execution evidence beyond that lifetime.
  for (const [key, item] of ledger) if (Date.now() - item.at > 15 * 60_000) ledger.delete(key);
  const seen = new Set<string>();
  try {
    for (let step = 0; step < 12; step++) {
      if (!current()) return { kind: "error", message: executed ? "后续操作已停止，已保存的更改仍保留。" : "本次请求已取消。", executed, handled: true };
      const raw = await request(text, context(), signal, step === 0 ? options.attachments : undefined,
        step === 0 ? options.continuation : undefined, options.deviceLocation, options.onProgress, task);
      received = true;
      const result = IntentResultSchema.parse(raw);
      if (!current()) return { kind: "error", message: executed ? "后续操作已停止，已保存的更改仍保留。" : "本次请求已取消。", executed, handled: true };
      // An older API can still return its existing validated envelope for the caller.
      if (!result.task) { finished = true; return { ...result, executed }; }
      if (result.task.id !== id) throw new Error("任务响应不一致");
      if (result.task.status !== "awaiting_execution") {
        finished = true;
        return { ...result, message: result.task.status === "completed" && seen.size === 1 && lastMessage
          ? lastMessage : result.message ?? (result.task.status === "completed" ? "已完成并保存。" : undefined), executed };
      }
      const executionId = result.task.executionId;
      if (!executionId || (!result.envelope && !result.hostOperation)) throw new Error("任务缺少可执行操作");
      const fingerprint = JSON.stringify({ envelope: result.envelope, hostOperation: result.hostOperation });
      const cached = ledger.get(executionId);
      if (!cached && ledger.size >= 256) return { kind: "error", message: "短时间内执行较多，请稍后继续；已保存的卡片不受影响。", executed, handled: true };
      let receipt: DecisionExecutionReceipt;
      let applied = false;
      if (cached) {
        if (cached.canvasId !== canvasId || cached.fingerprint !== fingerprint) throw new Error("重复任务的操作内容不一致");
        receipt = cached.receipt; executed ||= cached.applied;
      } else {
        receipt = { executionId, status: "failed" };
        if (result.task.canvasVersion === undefined || result.task.canvasVersion !== version()) receipt.error = "画布版本缺失或已变化，请重新提交指令。";
        else if (result.envelope && result.envelope.canvasId !== canvasId) receipt.error = "任务指向了其他画布。";
        else if (result.envelope && taskPreflight(result.envelope, store.getState().cards.filter(card => !card.exitingRequestId).map(card => card.record))) {
          receipt.error = taskPreflight(result.envelope, store.getState().cards.filter(card => !card.exitingRequestId).map(card => card.record))!;
        } else {
          // No await between the lease/version check and the single owner mutation.
          const write = () => {
            const outcome = result.envelope ? host.dispatch({ ...result.envelope, requestId: executionId, actions: focusResponseActions(result.envelope.actions, store.getState()) })
              : executeHostOperation(host, store.getState(), result.hostOperation!, executionId);
            if (outcome.ok) {
              executed = true; applied = true;
              receipt.error = "更改已执行，保存结果尚未确认，请检查画布。";
              ledger.set(executionId, { fingerprint, canvasId, receipt, applied, at: Date.now() });
            }
            return outcome;
          };
          const outcome = options.withCommit ? options.withCommit(write) : write();
          if (!outcome.ok) receipt.error = outcome.error.slice(0, 240);
          else {
            lastMessage = result.hostOperation?.kind === "canvas.organize.preview" ? "已打开整理预览，请在电脑确认应用。"
              : result.hostOperation?.kind === "ambient.control" ? "已更新空间氛围。"
                : result.hostOperation?.kind === "history.undo" ? "已撤销上一步操作。"
                  : result.hostOperation?.kind === "history.redo" ? "已重做上一步操作。"
                    : result.envelope?.spokenText ?? result.message ?? "已执行并保存。";
            // Store a failure receipt before awaiting disk: a lost acknowledgement must not replay the mutation.
            receipt.error = "更改已执行，保存结果尚未确认，请检查画布。";
            ledger.set(executionId, { fingerprint, canvasId, receipt, applied, at: Date.now() });
            await host.flush(canvasId, version());
            receipt = { executionId, status: "succeeded", createdCardIds: result.envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card.id] : []) ?? [] };
          }
        }
        ledger.set(executionId, { fingerprint, canvasId, receipt, applied, at: Date.now() });
      }
      if (seen.has(executionId)) return { kind: "error", message: "服务重复返回同一步，已停止；卡片不会重复创建。", executed, task: result.task, handled: true };
      seen.add(executionId);
      task = { id, receipt };
    }
    return { kind: "error", message: "本次步骤较多，已停止后续操作；已保存的更改仍保留。", executed, handled: true };
  } catch (error) {
    // Only a request that has never changed the canvas may enter the caller's offline fallback.
    if (!executed && !signal.aborted && !received && !(error instanceof z.ZodError) && !(error instanceof SyntaxError)) throw error;
    return { kind: "error", message: executed ? "后续处理或保存确认中断，请检查已有卡片后再继续。" : signal.aborted ? "本次请求已取消。" : "任务响应未通过校验，未执行操作。", executed, handled: true };
  } finally {
    if (!finished) {
      // Best effort cancellation has no execution rights and gets its own short timeout.
      void request(text, context(), AbortSignal.timeout(2000), undefined, undefined, undefined, undefined, { id, cancel: true }).catch(() => {});
    }
  }
}
