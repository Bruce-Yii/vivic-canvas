import { UNSAFE_FEEDBACK_PATTERN, isSafeFeedbackText, type IntentRouteId } from "@vivic/contracts";
import type { FeedbackScene, FeedbackTargetState, FeedbackTier } from "./intentStream";

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
 *
 * Target-sensitive routes only get confirmation copy, never the action itself:
 * the route hint can arrive before the target promise resolves, so "我来改这张
 * 卡" would name a target the user has not chosen yet. The confirmation line is
 * safe both before and after a unique target is known.
 */
export const PRESET_FEEDBACK: Record<IntentRouteId, string | null> = {
  chat: "我先回你",
  answer: "我先看一下这个问题",
  search: "我先查一下",
  countdown: null,
  todo: null,
  note: null,
  generate: "我来整理一下",
  focus: "我先找一下相关卡片",
  overview: null,
  restore: null,
  highlight: "我来标出来",
  edit: "我先确认要改哪张",
  arrange: "我来整理布局",
  delete: "我先确认要删哪张",
  undo: "我来撤销",
  unsupported: "我先看看能不能做",
};

/** Extension routes are dynamic, so they share one safe, non-committal line. */
export const EXT_FEEDBACK = "我在整理这类内容";
/**
 * A target-sensitive route may name the action only after the server says a
 * unique card was resolved. `delete` intentionally has no action copy: a
 * destructive step keeps its confirmation wording even when the target is known.
 */
export const TARGET_ACTION_FEEDBACK: Partial<Record<IntentRouteId, string>> = {
  focus: "我来打开这张卡",
  edit: "我来修改这张卡",
  highlight: "我来标出这张卡",
};
/**
 * Paths that intentionally suppress a concrete route hint (multi-clause,
 * attachment, continuation, task) still need a line instead of an empty wait.
 */
export const SCENE_FEEDBACK: Record<FeedbackScene, string> = {
  multi: "我在分开处理这几件事",
  attachment: "我先看看你发的内容",
  continuation: "我在接着处理这件事",
  task: "我在接着处理这件事",
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
 * implementation names. The web slot re-runs the same check server-side before
 * painting a model sentence.
 */
export const PRESET_FORBIDDEN = UNSAFE_FEEDBACK_PATTERN;

/**
 * Web-side hard gate for a model sentence. The server already filters, but the
 * client must not trust a stale server or a provider regression: an unsafe
 * sentence is dropped and the slot keeps waiting for the result.
 */
export const safeFeedbackSentence = (sentence: string | undefined): string | undefined =>
  sentence && isSafeFeedbackText(sentence) ? sentence : undefined;

/**
 * Route copy, or a safe fallback for extension/unknown routes. A missing route
 * still returns null: there is nothing to cover, and neutral copy is honest.
 */
export const presetFeedbackFor = (route: string | undefined, scene?: FeedbackScene,
  targetState?: FeedbackTargetState): string | null => {
  if (scene) return SCENE_FEEDBACK[scene];
  if (!route) return null;
  if (!Object.prototype.hasOwnProperty.call(PRESET_FEEDBACK, route)) return EXT_FEEDBACK;
  const action = TARGET_ACTION_FEEDBACK[route as IntentRouteId];
  if (targetState === "resolved" && action) return action;
  return PRESET_FEEDBACK[route as IntentRouteId] ?? null;
};

export interface PresetPlanContext {
  /** Wall-clock time the route hint arrived. */
  now: number;
  tier: FeedbackTier;
  settled: boolean;
  /** A preset is already waiting for this request. */
  scheduled?: boolean;
  /** Multi-clause/attachment/continuation/task fallback when no route is sent. */
  scene?: FeedbackScene;
  /** Only `resolved` unlocks an action sentence for focus/edit/highlight. */
  targetState?: FeedbackTargetState;
}

export interface PresetPlan {
  route?: string;
  scene?: FeedbackScene;
  text: string;
  delayMs: number;
  showAt: number;
}

/**
 * Pure eligibility/timing decision for a route/scene hint. Painting is allowed
 * only while the slot is still neutral: a slow hint, a model sentence, an
 * earlier preset or a settled request all win, and rule-direct routes never map
 * to copy.
 */
export function planPreset(route: string | undefined, context: PresetPlanContext): PresetPlan | null {
  const text = presetFeedbackFor(route, context.scene, context.targetState);
  if (!text || (!route && !context.scene)) return null;
  if (context.settled || context.scheduled || context.tier !== "neutral") return null;
  return { ...(route ? { route } : {}), ...(context.scene ? { scene: context.scene } : {}),
    text, delayMs: PRESET_DELAY_MS, showAt: context.now + PRESET_DELAY_MS };
}
