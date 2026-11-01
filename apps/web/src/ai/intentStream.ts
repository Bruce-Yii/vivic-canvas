import { z } from "zod";
import { ActionEnvelopeSchema } from "@/contracts";
import { FEEDBACK_SCENES, FEEDBACK_TARGET_STATES, HostOperationSchema, DecisionTaskStatusSchema, type FeedbackScene, type FeedbackTargetState } from "@vivic/contracts";
export { FEEDBACK_SCENES, FEEDBACK_TARGET_STATES, type FeedbackScene, type FeedbackTargetState };

/** Paths that intentionally have no single route, but still need a safe line. */
export const IntentProgressSchema = z.object({
  requestId: z.string().min(1).max(128),
  stage: z.enum(["rules", "data", "search", "decision", "planner", "validation", "travel", "total"]),
  status: z.enum(["started", "completed", "failed"]),
  elapsedMs: z.number().finite().nonnegative().optional(),
  feedback: z.string().trim().min(1).max(80).optional(),
  // Optional additions for newer clients. `z.object` strips them for older
  // readers, so the wire format stays backward compatible.
  route: z.string().max(90).optional(),
  scene: z.enum(FEEDBACK_SCENES).optional(),
  targetState: z.enum(FEEDBACK_TARGET_STATES).optional(),
  feedbackSource: z.enum(["model", "preset"]).optional(),
});
export type IntentProgress = z.infer<typeof IntentProgressSchema>;
export const intentStageLabel = (stage: IntentProgress["stage"]): string => ({
  rules: "正在匹配本地指令…", data: "正在获取所需数据…", search: "正在检索资料…",
  decision: "正在判断操作…", planner: "正在整理卡片内容…", validation: "正在校验结果…",
  travel: "正在查询旅游结果…", total: "正在完成处理…",
})[stage];

/**
 * Visible-slot priority: final result > model first sentence > preset > neutral > stage label.
 * A progress frame may replace the visible line only when its rank is strictly higher
 * (except settling, which is absolute). Stage labels rank lowest because they are
 * telemetry: they describe the pipeline, not what Vivic is doing for the user.
 */
export const FEEDBACK_RANK = { stage: 5, neutral: 10, slow: 20, preset: 30, model: 40, final: 90 } as const;
export type FeedbackTier = keyof typeof FEEDBACK_RANK;
/** A result faster than this is a fast completion: the first sentence layer never paints. */
export const FAST_DONE_MS = 250;

export interface FeedbackSlot {
  requestId: string;
  tier: FeedbackTier;
  text: string | null;
  /** Advisory route from the decision layer; a route frame alone never renders. */
  route?: string;
  /** Safe fallback for multi-clause/attachment/continuation/task paths. */
  scene?: FeedbackScene;
  /** Whether the target-sensitive route already resolved a unique card. */
  targetState?: FeedbackTargetState;
  /** A result/error/cancel ended this request; later progress frames are discarded. */
  settled: boolean;
}

export type FeedbackEvent =
  | { type: "neutral"; text: string; requestId?: string }
  | { type: "slow"; text: string; requestId?: string }
  /** Scene copy derived from an already-decided route; `at` is when it was allowed to paint. */
  | { type: "preset"; text: string; route?: string; scene?: FeedbackScene; at?: number; requestId?: string }
  | { type: "progress"; stage: IntentProgress["stage"]; feedback?: string; feedbackSource?: "model" | "preset"; route?: string; scene?: FeedbackScene; targetState?: FeedbackTargetState; requestId?: string }
  | { type: "settle"; text: string | null; elapsedMs?: number; quiet?: boolean; requestId?: string };

export const newFeedbackSlot = (requestId: string, text: string): FeedbackSlot =>
  ({ requestId, tier: "neutral", text, settled: false });

/**
 * One request owns exactly one visible line. This reducer is the only place that
 * decides what may replace what, so the UI cannot accidentally let a late stage
 * frame, a slow hint or an old request overwrite a better sentence.
 */
export function reduceFeedback(slot: FeedbackSlot, event: FeedbackEvent): FeedbackSlot {
  // Frames from a superseded request are dropped before they can touch the slot.
  if (event.requestId && event.requestId !== slot.requestId) return slot;
  if (slot.settled) return slot;
  if (event.type === "settle") {
    // A silent success faster than the quiet window clears the line instead of
    // flashing neutral/first-sentence text; other fast completions paint only
    // their own final line.
    const quietFast = event.quiet === true && event.elapsedMs !== undefined && event.elapsedMs < FAST_DONE_MS;
    return { ...slot, tier: "final", text: quietFast && slot.tier === "neutral" ? null : event.text, settled: true };
  }
  if (event.type === "neutral") {
    if (FEEDBACK_RANK.neutral <= FEEDBACK_RANK[slot.tier]) return slot;
    return { ...slot, tier: "neutral", text: event.text };
  }
  if (event.type === "slow") {
    // The 5s slow hint may only replace the neutral sentence, and nothing later
    // (stage, preset, a second slow hint) may overwrite it.
    if (slot.tier !== "neutral") return slot;
    return { ...slot, tier: "slow", text: event.text };
  }
  if (event.type === "preset") {
    // Scene copy only fills a still-neutral line. A slow hint, a model sentence,
    // an earlier preset or a settled request all keep the visible line, and an
    // equal-tier preset can never replace itself.
    if (slot.tier !== "neutral") return slot;
    return { ...slot, tier: "preset", text: event.text, ...(event.route ? { route: event.route } : {}),
      ...(event.scene ? { scene: event.scene } : {}) };
  }
  const routed = event.route && event.route !== slot.route ? { ...slot, route: event.route } : slot;
  const scened = event.scene && event.scene !== routed.scene ? { ...routed, scene: event.scene } : routed;
  const next = event.targetState ? { ...scened, targetState: event.targetState } : scened;
  if (event.feedback) {
    const tier: FeedbackTier = event.feedbackSource === "preset" ? "preset" : "model";
    if (FEEDBACK_RANK[tier] <= FEEDBACK_RANK[slot.tier]) return next;
    return { ...next, tier, text: event.feedback };
  }
  // A stage label is telemetry: it may record the route but never writes the line.
  return next;
}

export const IntentResultSchema = z.object({
  kind: z.enum(["envelope", "clarify", "unknown", "error", "locale", "host-operation", "task"]),
  hostOperation: HostOperationSchema.optional(), task: DecisionTaskStatusSchema.optional(),
  envelope: ActionEnvelopeSchema.optional(), message: z.string().max(400).optional(),
  suggestions: z.array(z.string().max(100)).max(5).optional(),
  locale: z.object({ name: z.string(), admin1: z.string().optional(), country: z.string().optional(),
    basis: z.enum(["device", "network"]), answer: z.string() }).optional(),
  usedProvider: z.enum(["rules", "stepfun", "deepseek", "gpt", "rules-offline", "search", "decision"]).optional(),
}).refine(result => result.kind !== "envelope" || Boolean(result.envelope), "缺少已校验的操作")
  .refine(result => result.kind !== "host-operation" || Boolean(result.hostOperation && result.task?.status === "awaiting_execution"), "缺少宿主操作任务");

/** Progress is advisory. Only one complete, schema-valid result leaves this parser. */
export async function readIntentStream(response: Response, onProgress: (event: IntentProgress) => void, signal?: AbortSignal) {
  if (!response.ok) throw new Error(`api ${response.status}`);
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return IntentResultSchema.parse(await response.json());
  if (!response.body) throw new Error("指令响应为空");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", requestId: string | undefined;
  const accepted = z.object({ requestId: z.string().min(1).max(128) });
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 2 * 1024 * 1024) throw new Error("指令响应过大");
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const lines = frame.split(/\r?\n/);
        const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
        const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (event === "accepted") {
          const next = accepted.parse(JSON.parse(data)).requestId;
          if (requestId && next !== requestId) throw new Error("指令响应会话不一致");
          requestId = next;
        } else if (event === "progress") {
          const parsed = IntentProgressSchema.safeParse(JSON.parse(data));
          if (parsed.success && requestId && parsed.data.requestId === requestId) {
            try { onProgress(parsed.data); } catch { /* UI observation cannot cancel a request. */ }
          }
        } else if (event === "result") {
          if (!requestId) throw new Error("指令响应缺少会话标识");
          return IntentResultSchema.parse(JSON.parse(data));
        }
      }
      if (done) throw new Error("指令响应提前结束，请重试。");
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
