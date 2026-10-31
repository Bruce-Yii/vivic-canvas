import { ATMOSPHERE_PALETTES, type PaletteId } from "@/components/atmosphere/palettes";
import { HarkBackdrop } from "./HarkPrimitives";
import { useEffect, useState, type CSSProperties } from "react";
import { ambientMode, ambientStrength, SPACE_FEEDBACK_EVENT, type AmbientMotion, type SpaceFeedback, type SpacePhase } from "@/motion/spaceMotion";
import { useMotionVisibility, useSystemReducedMotion } from "@/motion/useMotionVisibility";
import "./space-light.css";

/** Source sky bytes and material timing, with D composited light choreography.
 * No shader/network runtime; all looping work pauses offscreen and when hidden.
 */
export function HarkCanvasBackdrop({ theme, palette, paused = false, className = "absolute inset-0", layer, motionMode = "subtle", intensity = 0.55, phase = "idle" }: {
  theme: "light" | "dark"; palette: PaletteId; paused?: boolean; className?: string; layer?: string;
  motionMode?: AmbientMotion; intensity?: number; phase?: SpacePhase;
}) {
  const { ref, visible } = useMotionVisibility<HTMLDivElement>();
  const systemReduced = useSystemReducedMotion();
  const reduced = paused || !!systemReduced;
  const mode = ambientMode(motionMode);
  const strength = ambientStrength(intensity);
  const running = !reduced && visible && mode !== "off" && strength > 0;
  const [feedback, setFeedback] = useState<(SpaceFeedback & { sequence: number }) | null>(null);
  useEffect(() => {
    if (!running) { setFeedback(null); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onFeedback = (event: Event) => {
      const detail = (event as CustomEvent<SpaceFeedback>).detail;
      if (!detail || !["saved", "transfer", "arrange", "undo", "redo"].includes(detail.kind)) return;
      clearTimeout(timer);
      setFeedback(previous => ({ ...detail, sequence: (previous?.sequence ?? 0) + 1 }));
      timer = setTimeout(() => setFeedback(null), 1400);
    };
    window.addEventListener(SPACE_FEEDBACK_EVENT, onFeedback);
    return () => { clearTimeout(timer); window.removeEventListener(SPACE_FEEDBACK_EVENT, onFeedback); };
  }, [running]);
  const tint = palette === "milk" || palette === "midnight" ? "transparent" : `${ATMOSPHERE_PALETTES[palette].colors[1]}50`;
  const style = { "--space-light-strength": strength, "--space-light-accent": ATMOSPHERE_PALETTES[palette].colors[1] } as CSSProperties;
  return <div ref={ref} className={`hark-canvas-backdrop pointer-events-none overflow-hidden ${className}`} aria-hidden="true" style={style}
    data-vivic-layer={layer} data-vivic-atmosphere={palette} data-vivic-atmosphere-theme={theme} data-reduced-motion={reduced || undefined}
    data-space-motion={mode} data-space-phase={phase} data-space-running={running}>
    <HarkBackdrop theme={theme} /><div className="hark-palette-tint" style={{ backgroundColor: tint }} />
    <div className="hark-space-light" aria-hidden="true"><i /><i /><i /></div>
    <div className="hark-space-focus" />
    <div className="hark-space-activity" />
    {feedback && running && <div key={feedback.sequence} className="hark-space-receipt" data-space-receipt={feedback.kind} />}
  </div>;
}
