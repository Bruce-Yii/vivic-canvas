import { runDecisionTask } from "@/ai/decisionTask";
import { parseCommand, type CommandResult } from "@/commands/parse";
import { focusResponseActions } from "@/commands/responseFocus";
import { canvasStore } from "@/state/canvasStore";
import type { ControlHost } from "@/sync/controlHost";
import type { TextExecutionContext } from "@vivic/mobile-console-prototype/vivicHostAdapter";
import { startsNewInstruction } from "@vivic/contracts";

const conversations = new WeakMap<ControlHost, Map<string, { taskId: string; canvasId: string; ownerId: string | null; at: number; utterance: string; question: string }>>();

/** No placeholders or shared conversation history: one guarded owner commit, followed by durable confirmation. */
export async function executeRemoteText(host: ControlHost, text: string, context: TextExecutionContext, desktopBusy: () => boolean) {
  const before = host.getSnapshot(), canvasId = before.activeCanvasId;
  const current = () => !desktopBusy() && !context.signal.aborted && context.isCurrent();
  const rejected = (message: string) => ({ ok: false, message });
  if (!canvasId || !current()) return rejected("电脑正在处理其他指令或控制会话已变化，请稍后重试。");
  const commandContext = { canvasId, state: canvasStore.getState() };
  let local: CommandResult | undefined;
  let envelope: unknown;
  let message = "已执行并保存。";
  {
    try {
      const thread = context.conversationId, histories = conversations.get(host) ?? new Map(); conversations.set(host, histories);
      const previous = thread ? histories.get(thread) : undefined;
      const followup = previous && previous.canvasId === canvasId && previous.ownerId === before.ownerId && Date.now() - previous.at < 120000 && text.length <= 80 && !startsNewInstruction(text, previous.utterance) ? previous : undefined;
      if (thread) histories.delete(thread);
      const result = await runDecisionTask({ host, text, signal: context.signal, isCurrent: current, withCommit: context.withCommit,
        taskId: followup?.taskId, continuation: followup ? { utterance: followup.utterance, question: followup.question } : undefined });
      if (!current()) {
        if (result.executed) throw new RemoteCommitUncertain("部分操作已执行，控制会话已变化，请检查电脑画布。");
        return rejected("控制会话或画布已变化，未提交指令。");
      }
      if (result.task || result.executed || result.handled) {
        if (result.task?.status === "awaiting_clarification" && thread) {
          if (histories.size >= 16) histories.delete(histories.keys().next().value!);
          histories.set(thread, { taskId: result.task.id, canvasId, ownerId: before.ownerId, at: Date.now(), utterance: followup?.utterance ?? text, question: result.message ?? "请补充信息。" });
        }
        if (result.executed && result.kind === "error") throw new RemoteCommitUncertain(result.message ?? "保存确认中断");
        return { ok: result.task?.status === "completed" || result.task?.status === "awaiting_clarification", message: result.message ?? "本次操作未完成。" };
      }
      if (result.kind === "locale" && result.locale) return { ok: true, message: result.locale.answer };
      if (result.kind === "envelope" && result.envelope) {
        envelope = { ...result.envelope, actions: focusResponseActions(result.envelope.actions, canvasStore.getState()) };
        message = result.envelope.spokenText ?? message;
      } else {
        local = parseCommand(text, commandContext);
        if (local.kind === "unknown") return rejected(result.message ?? local.message);
      }
    } catch (error) {
      if (error instanceof RemoteCommitUncertain) throw error;
      if (!current()) return rejected("本次指令已取消或失效。");
      local = parseCommand(text, commandContext);
    }
  }
  if (local?.kind === "unknown") return rejected(local.message);
  if (local?.kind === "clarify") return rejected(`${local.prompt} 请在下一条指令中写明卡片名称。`);
  // The lease is checked immediately before the sole mutation, with no await in between.
  if (!current()) return rejected("控制会话或画布已变化，未提交指令。");
  if (local?.kind === "undo") {
    if (!host.undo()) return rejected("没有可撤销的操作。");
    message = "已撤销上一步操作。";
  } else if (local?.kind === "redo") {
    if (!host.redo()) return rejected("没有可重做的操作。");
    message = "已重做上一步操作。";
  } else {
    if (local?.kind === "envelope") {
      envelope = { schemaVersion: "0.6", requestId: `mobile-${context.requestId}`, canvasId,
        actions: focusResponseActions(local.actions, canvasStore.getState()) };
      message = local.spokenText ?? local.description;
    }
    const outcome = host.dispatch(envelope);
    if (!outcome.ok) return rejected(`未执行：${outcome.error}`);
  }
  const after = host.getSnapshot();
  const committedCanvas = after.activeCanvasId;
  if (!committedCanvas) throw new Error("commit_scope_unknown");
  await host.flush(committedCanvas, after.canvases.find(canvas => canvas.id === committedCanvas)?.version ?? 0);
  return { ok: true, message };
}

class RemoteCommitUncertain extends Error {}
