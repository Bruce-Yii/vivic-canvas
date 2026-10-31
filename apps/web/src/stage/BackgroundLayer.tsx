import { HarkCanvasBackdrop } from "@/components/hark/HarkCanvasBackdrop";
import { paletteFor } from "@/components/atmosphere/palettes";
import { useDisplayPreferences, useVivicState } from "@/state/canvasStore";
import type { SpacePhase } from "@/motion/spaceMotion";
import { useSystemReducedMotion } from "@/motion/useMotionVisibility";

/** React Bits fluid backdrop stays outside React Flow and follows display preferences. */
export const BackgroundLayer = ({ theme }: { theme: "light" | "dark" }) => {
  const preferences = useDisplayPreferences();
  const stage = useVivicState(state => state.stage);
  const activity = useVivicState(state => state.activity);
  const focused = useVivicState(state => !!state.focus);
  const reduced = useSystemReducedMotion() || preferences.reducedMotion;
  const phase: SpacePhase = stage === "AWAKENING" ? "awakening"
    : activity ? activity.phase === "listening" ? "listening" : activity.phase === "speaking" ? "speaking" : "thinking"
    : focused ? "focus" : "idle";
  return <HarkCanvasBackdrop theme={theme} palette={paletteFor(theme, preferences)} paused={reduced} layer="background"
    motionMode={preferences.ambientMotion} intensity={preferences.ambientIntensity} phase={phase} />;
};
