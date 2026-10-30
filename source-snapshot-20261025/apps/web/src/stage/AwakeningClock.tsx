import { useEffect } from "react";
import { useReducedMotion } from "motion/react";
import { canvasStore, useVivicState, useDisplayPreferences } from "@/state/canvasStore";

/** How long the stage stays in AWAKENING before the workspace takes over. */
export const AWAKENING_TOTAL_MS = 960;

/**
 * The Display shows the same Hark sky background as the user page in every
 * stage — no black standby veil (user request, 2026-10-17). Waking only
 * advances AWAKENING → WORKSPACE after a short beat; the orb and the cards'
 * own transitions provide the motion. Reduced motion advances sooner.
 */
export const AwakeningClock = () => {
  const stage = useVivicState((s) => s.stage);
  const preferences = useDisplayPreferences();
  const reduceMotion = useReducedMotion() || preferences.reducedMotion;
  useEffect(() => {
    if (stage !== "AWAKENING") return;
    const timer = setTimeout(() => canvasStore.internal({ type: "stage.awakening.complete" }), reduceMotion ? 400 : AWAKENING_TOTAL_MS);
    return () => clearTimeout(timer);
  }, [stage, reduceMotion]);
  return null;
};
