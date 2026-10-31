import { ATMOSPHERE_PALETTES, type PaletteId } from "@/components/atmosphere/palettes";
import { useEffect, useState, type CSSProperties } from "react";
import { ambientMode, ambientStrength, SPACE_FEEDBACK_EVENT, type AmbientMotion, type SpaceFeedback, type SpacePhase } from "@/motion/spaceMotion";
import { useMotionVisibility, useSystemReducedMotion } from "@/motion/useMotionVisibility";
import LiquidEther from "./LiquidEther";
import "./space-light.css";

/** React Bits Liquid Ether fluid field with Vivic phase and feedback layers. */
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
  const vivid = mode === "vivid";
  const colors = ATMOSPHERE_PALETTES[palette].colors;
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

  const style = {
    "--space-light-strength": strength,
    background: `radial-gradient(ellipse 70% 60% at 22% 48%, ${colors[1]}aa, transparent 72%), radial-gradient(ellipse 60% 55% at 76% 40%, ${colors[2]}99, transparent 70%), radial-gradient(ellipse 50% 40% at 52% 72%, ${colors[3]}66, transparent 70%), ${colors[0]}`
  } as CSSProperties;
  return <div ref={ref} className={`hark-canvas-backdrop pointer-events-none overflow-hidden ${className}`} aria-hidden="true" style={style}
    data-vivic-layer={layer} data-vivic-atmosphere={palette} data-vivic-atmosphere-theme={theme} data-reduced-motion={reduced || undefined}
    data-space-motion={mode} data-space-phase={phase} data-space-running={running}>
    <LiquidEther
      className="hark-liquid-ether"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      colors={[...ATMOSPHERE_PALETTES[palette].swatch]}
      intensity={running ? strength * (vivid ? 1.3 : 0.85) : 0}
      mouseForce={running ? vivid ? 26 : 9 : 0}
      cursorSize={vivid ? 140 : 96}
      persistence={vivid ? 0.88 : 0.8}
      viscosity={vivid ? 0.04 : 0.12}
      resolution={0.42}
      bounceEdges
      clickBurst={false}
      interactive={false}
      autoDemo={running}
      autoSpeed={vivid ? 0.62 : 0.22}
      autoIntensity={vivid ? 2 : 0.65}
      autoResumeDelay={1200}
      intro={running && vivid}
      lightMode={theme === "light"}
      backgroundColor="transparent"
      maxDevicePixelRatio={1.5}
    />
    <div className="hark-space-focus" />
    <div className="hark-space-activity" />
    {feedback && running && <div key={feedback.sequence} className="hark-space-receipt" data-space-receipt={feedback.kind} />}
  </div>;
}
