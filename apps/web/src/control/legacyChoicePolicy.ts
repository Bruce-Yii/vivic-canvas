interface TaskResult { kind: string; executed?: boolean; task?: { decision?: string; status?: string } }

/** A server question owns its continuation. A local picker cannot authorize deletion. */
export function canReuseLegacyLocalChoice(result: TaskResult, action: string): boolean {
  return !result.executed && result.task?.decision === "legacy-fallback"
    && result.task.status !== "awaiting_clarification"
    && ["unknown", "error"].includes(result.kind) && action !== "delete";
}

/** Persisted subtitle/highlight dispatches advance the canvas confirmation version. */
export const canPublishTaskFeedback = (result: TaskResult): boolean => result.task?.status !== "awaiting_clarification";
export const canPreviewLocalChoice = (choice: { taskId?: string } | null): boolean => !choice?.taskId;
