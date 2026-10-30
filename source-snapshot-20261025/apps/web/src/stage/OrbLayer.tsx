import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import SiriOrb from "@/components/smoothui/siri-orb";
import { deriveOrb } from "@/motion/motionDirector";
import { useVivicState, useDisplayPreferences } from "@/state/canvasStore";
import { anchorCenter } from "./orbAnchor";
import { orbPalette } from "./orbPalette";
import { useMotionVisibility, useSystemReducedMotion } from "@/motion/useMotionVisibility";

/**
 * The only orb surface. Standby: large breathing orb on pure black.
 * Awakening: brief scale/bloom (~100ms rise) while the reveal mask expands,
 * then it dissolves into the background. Workspace: no resident orb — a small
 * feedback orb returns only while a speaking/thinking event is live. Its
 * top-centre screen anchor stays fixed while cards or the camera move.
 */
export const OrbLayer = () => {
  const stage = useVivicState((s) => s.stage);
  const speaking = useVivicState((s) => s.subtitle !== null || s.activity?.phase === "speaking");
  const activity = useVivicState((s) => s.activity);
  const listening = activity?.phase === "listening";
  const thinking = Boolean(activity && activity.phase !== "speaking" && !listening);
  const preferences = useDisplayPreferences();
  const { ref: motionRef, visible } = useMotionVisibility<HTMLDivElement>();
  const reduceMotion = useSystemReducedMotion() || preferences.reducedMotion || !visible;

  const wrapRef = useRef<HTMLDivElement>(null);
  const [screen, setScreen] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const report = () =>
      setScreen({ width: el.clientWidth, height: el.clientHeight });
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const directive = deriveOrb({ stage, speaking, thinking, listening });
  const feedbackSize = parseInt(directive.size, 10);

  const awakening = stage === "AWAKENING";
  const feedback = directive.feedback;

  const center = anchorCenter("top-center", screen.width, screen.height, feedbackSize);
  const feedbackSpot = { anchor: "top-center", x: center.x - feedbackSize / 2, y: center.y - feedbackSize / 2 };
  // Resting position: STANDBY/AWAKENING sit at screen centre, a feedback orb at
  // its anchor. Plain CSS, never animated: the orb appears and changes anchor
  // in place — only opacity/scale move (user feedback 2026-10-16).
  const restX = feedback ? feedbackSpot.x : (screen.width - feedbackSize) / 2;
  const restY = feedback ? feedbackSpot.y : (screen.height - feedbackSize) / 2;

  return (
    <div
      ref={element => { wrapRef.current = element; motionRef.current = element; }}
      className="pointer-events-none absolute inset-0 z-30"
      aria-hidden="true"
      data-vivic-layer="orb"
      data-vivic-ai-state={activity?.phase ?? (thinking ? "thinking" : speaking ? "speaking" : "idle")}
    >
      <AnimatePresence>
        {directive.visible && screen.width > 0 && (
          <motion.div
            key="orb"
            className="absolute"
            style={{ left: restX, top: restY }}
            data-vivic-orb-anchor={feedback ? feedbackSpot?.anchor : undefined}
            initial={{ opacity: 0, scale: 1 }}
            animate={
              awakening && !reduceMotion
                ? { opacity: [1, 1, 0], scale: [1, 1.16, 1.04] }
                : { opacity: 1, scale: 1 }
            }
            exit={{ opacity: 0, scale: 1.4, transition: { duration: 0.4 } }}
            transition={
              awakening && !reduceMotion
                ? { duration: 0.95, times: [0, 0.12, 1], ease: "easeInOut" }
                : { duration: 0.35, ease: "easeOut" }
            }
          >
            <div className="vivic-orb-halo" data-orb-phase={awakening ? "awakening" : directive.state} data-paused={reduceMotion || undefined} />
            <motion.div
              animate={thinking && !reduceMotion ? { scale: [1, 1.045, 1] } : { scale: 1 }}
              transition={thinking && !reduceMotion ? { duration: 1.8, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }}
            ><SiriOrb
              size={directive.size}
              state={directive.state}
              colors={orbPalette(preferences.orbPalette).colors}
              reducedMotion={reduceMotion}
              amplitude={activity?.phase === "speaking" && !reduceMotion ? activity.speech?.amplitude ?? 0 : 0}
              animationDuration={thinking ? 12 : 24}
            /></motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
