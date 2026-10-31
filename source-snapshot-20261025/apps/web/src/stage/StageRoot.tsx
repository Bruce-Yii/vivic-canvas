import { CanvasView } from "@/canvas/CanvasView";
import { useVivicState, useDisplayPreferences } from "@/state/canvasStore";
import { BackgroundLayer } from "./BackgroundLayer";
import { AwakeningClock } from "./AwakeningClock";
import { OrbLayer } from "./OrbLayer";
import { SubtitleLayer } from "./SubtitleLayer";
import { useResolvedTheme } from "./useResolvedTheme";
import { motion, MotionConfig } from "motion/react";
import { useSystemReducedMotion } from "@/motion/useMotionVisibility";

/**
 * Display layering (bottom → top):
 * z-0  Hark sky with composited light (independent of canvas transforms)
 * z-10 React Flow canvas + cards
 * (no veil: standby shows the same background as the user page)
 * z-30 SmoothUI Siri Orb
 * z-40 transient subtitle
 */
export const StageRoot = () => {
  const stage = useVivicState((s) => s.stage);
  const reminderAlert = useVivicState((s) => s.subtitle?.priority === "reminder");
  const preferences = useDisplayPreferences();
  const reduced = useSystemReducedMotion() || preferences.reducedMotion;
  const resolvedTheme = useResolvedTheme();

  return (
    <MotionConfig reducedMotion={reduced ? "always" : "user"}><div
      className="fixed inset-0 overflow-hidden bg-black"
      data-vivic-stage={stage}
      data-vivic-theme={resolvedTheme}
      data-space-motion={preferences.ambientMotion ?? "subtle"}
      data-reduced-motion={reduced || undefined}
    >
      <BackgroundLayer theme={resolvedTheme} />
      <motion.div className="vivic-reminder-glow pointer-events-none absolute inset-0 z-[25]"
        aria-hidden="true" data-vivic-reminder-glow={reminderAlert ? "true" : undefined}
        animate={{ opacity: reminderAlert ? 1 : 0 }} transition={{ duration: reduced ? 0 : 0.6 }}
      />
      {stage === "WORKSPACE" && <CanvasView resolvedTheme={resolvedTheme} />}
      <AwakeningClock />
      <OrbLayer />
      <SubtitleLayer />
    </div></MotionConfig>
  );
};
