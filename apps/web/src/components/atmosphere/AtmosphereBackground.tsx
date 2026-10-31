import { HarkCanvasBackdrop } from "@/components/hark/HarkCanvasBackdrop";
import type { PaletteId } from "./palettes";

export interface AtmosphereBackgroundProps {
  theme: "light" | "dark";
  palette: PaletteId;
  paused?: boolean;
  className?: string;
  layer?: string;
}

/** Shared React Bits fluid background for hosted, landing and prototype surfaces. */
export const AtmosphereBackground = ({ theme, palette, paused = false, className, layer }: AtmosphereBackgroundProps) =>
  <HarkCanvasBackdrop theme={theme} palette={palette} paused={paused} className={className ?? "absolute inset-0"} layer={layer} />;
