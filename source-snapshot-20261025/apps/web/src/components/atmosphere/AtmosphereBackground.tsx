import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { PastelAtmosphere } from "./pastelAtmosphere";
import { ATMOSPHERE_PALETTES, type PaletteId } from "./palettes";

/** 流光以太 is the only motion offered; the HTML lab's other five modes stay unused. */
const ETHER_MODE = 1;
const LAB_DEFAULTS = { density: 68, speed: 43, glow: 66, brightness: 70, direction: "right" } as const;

export interface AtmosphereBackgroundProps {
  theme: "light" | "dark";
  palette: PaletteId;
  paused?: boolean;
  className?: string;
  /** Kept on the Display host so existing layer probes still find it. */
  layer?: string;
}

/**
 * Shared Display / user page / settings background. The canvas is created
 * imperatively so the shader's own 2D fallback can swap the node, and each
 * mount (including StrictMode's re-run) owns and releases its own context.
 * WebGL loss stops drawing and leaves the static palette wash underneath.
 */
export const AtmosphereBackground = ({ theme, palette, paused = false, className, layer }: AtmosphereBackgroundProps) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const effectRef = useRef<PastelAtmosphere | null>(null);
  const colors = ATMOSPHERE_PALETTES[palette].colors;
  const dark = theme === "dark" ? 1 : 0;
  const latest = useRef({ colors, dark, paused }); latest.current = { colors, dark, paused };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = document.createElement("canvas");
    canvas.className = "absolute inset-0 block h-full w-full";
    host.prepend(canvas);
    const effect = new PastelAtmosphere(canvas, { ...LAB_DEFAULTS, mode: ETHER_MODE,
      colors: [...latest.current.colors], dark: latest.current.dark });
    effect.setPaused(latest.current.paused);
    effectRef.current = effect;
    const surface = effect.canvas;
    const onLost = (event: Event) => {
      event.preventDefault();
      effect.destroy();
      surface.style.visibility = "hidden";
      host.dataset.vivicGlLost = "true";
    };
    surface.addEventListener("webglcontextlost", onLost);
    return () => {
      surface.removeEventListener("webglcontextlost", onLost);
      effect.destroy();
      if (host.dataset.vivicGlLost !== "true") effect.gl?.getExtension("WEBGL_lose_context")?.loseContext();
      surface.remove();
      delete host.dataset.vivicGlLost;
      if (effectRef.current === effect) effectRef.current = null;
    };
  }, []);
  useEffect(() => { effectRef.current?.setOptions({ colors: [...colors], dark }); }, [colors, dark]);
  useEffect(() => { effectRef.current?.setPaused(paused); }, [paused]);

  const [base, a, b, c] = colors;
  return <div ref={hostRef} aria-hidden="true" data-vivic-layer={layer} data-vivic-atmosphere={palette} data-vivic-atmosphere-theme={theme}
    className={cn("pointer-events-none overflow-hidden", className ?? "absolute inset-0")}
    style={{ background: `radial-gradient(ellipse 70% 60% at 22% 48%, ${a}aa, transparent 72%), radial-gradient(ellipse 60% 55% at 76% 40%, ${b}99, transparent 70%), radial-gradient(ellipse 50% 40% at 52% 72%, ${c}66, transparent 70%), ${base}` }}>
    <div className="vivic-atmosphere-grain" />
  </div>;
};
