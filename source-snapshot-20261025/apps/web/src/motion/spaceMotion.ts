/** Ephemeral visual receipts. Call only after the corresponding operation succeeds. */
export const SPACE_FEEDBACK_EVENT = "vivic:space-feedback";
export type SpaceFeedbackKind = "saved" | "transfer" | "arrange" | "undo" | "redo";
export interface SpaceFeedback { kind: SpaceFeedbackKind; cardIds?: string[] }
export type SpacePhase = "idle" | "awakening" | "thinking" | "listening" | "speaking" | "focus";
export type AmbientMotion = "off" | "subtle" | "vivid";

export function emitSpaceFeedback(feedback: SpaceFeedback): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<SpaceFeedback>(SPACE_FEEDBACK_EVENT, { detail: feedback }));
}

export const ambientStrength = (value?: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value!)) : 0.55;

export const ambientMode = (value?: string): AmbientMotion =>
  value === "off" || value === "vivid" ? value : "subtle";
