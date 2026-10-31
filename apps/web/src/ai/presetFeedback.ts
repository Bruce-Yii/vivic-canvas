import type { IntentRouteId } from "@vivic/contracts";
import type { FeedbackTier } from "./intentStream";

/**
 * Scene copy for the third feedback layer: the server already decided the route,
 * but no model sentence exists yet. Copy is deliberately generic (never names a
 * card, a count or a time) and stays in the client so the server keeps sending
 * only a route id.
 *
 * `null` means "rule-direct route": the deterministic path finishes without a
 * model/planner wait, so a preset sentence would add a third line instead of
 * covering a wait. The five null entries are exactly the routes that can execute
 * from parsed slots alone (countdown/todo/note/overview/restore).
 */
export const PRESET_FEEDBACK: Record<IntentRouteId, string | null> = {
  chat: "我先回你",
  answer: "我先看一下这个问题",
  search: "我先查一下",
  countdown: null,
  todo: null,
  note: null,
  generate: "我来整理一下",
  focus: "我来找到那张卡",
  overview: null,
  restore: null,
  highlight: "我来标出来",
  edit: "我来改这张卡",
  arrange: "我来整理布局",
  delete: "我来处理删除",
  undo: "我来撤销",
  unsupported: "我先看看能不能做",
};

/** Visible copy budget, in Unicode code points (punctuation included). */
export const PRESET_MAX_CHARS = 20;
/** Wait after the route is known before painting its scene copy. */
export const PRESET_DELAY_MS = 600;
/**
 * A visible preset is a progress line, so another progress line must outlive it
 * by this much before replacing it. A model sentence and every terminal event
 * (result/cancel/error) are exempt: they always replace immediately.
 */
export const PRESET_MIN_VISIBLE_MS = 600;
/**
 * Hard bans from the interaction spec: no finished-state claims, no internal
 * implementation names. Case-insensitive so JSON/slots/contract also match.
 */
export const PRESET_FORBIDDEN = /已完成|已创建|已保存|已生成|已执行|已记下|成功|好了|完成了|JSON|slots|contract|字段|工具|参数|推理|targetId|card\.|canvas\./i;

export const presetFeedbackFor = (route: string | undefined): string | null => {
  if (!route || !Object.prototype.hasOwnProperty.call(PRESET_FEEDBACK, route)) return null;
  return PRESET_FEEDBACK[route as IntentRouteId] ?? null;
};

export interface PresetPlanContext {
  /** Wall-clock time the route hint arrived. */
  now: number;
  tier: FeedbackTier;
  settled: boolean;
  /** A preset is already waiting for this request. */
  scheduled?: boolean;
}

export interface PresetPlan {
  route: string;
  text: string;
  delayMs: number;
  showAt: number;
}

/**
 * Pure eligibility/timing decision for a route hint. Painting is allowed only
 * while the slot is still neutral: a slow hint, a model sentence, an earlier
 * preset or a settled request all win, and rule-direct routes never map to copy.
 */
export function planPreset(route: string | undefined, context: PresetPlanContext): PresetPlan | null {
  const text = presetFeedbackFor(route);
  if (!text || !route) return null;
  if (context.settled || context.scheduled || context.tier !== "neutral") return null;
  return { route, text, delayMs: PRESET_DELAY_MS, showAt: context.now + PRESET_DELAY_MS };
}
