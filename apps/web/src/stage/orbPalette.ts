import type { SiriOrbProps } from "@/components/smoothui/siri-orb";

/** Vivic choices applied to the existing SmoothUI mesh, not replacement artwork. */
export const ORB_PALETTE_IDS = ["aurora", "sky", "mint", "peach"] as const;
export type OrbPaletteId = typeof ORB_PALETTE_IDS[number];
export const ORB_PALETTES: Record<OrbPaletteId, { name: string; colors: NonNullable<SiriOrbProps["colors"]>; swatch: string }> = {
  aurora: { name: "极光", swatch: "linear-gradient(135deg,#57c8ee,#a37cef,#ef79bb)", colors: {} },
  sky: { name: "晴空", swatch: "linear-gradient(135deg,#b0e8ff,#67b9e5,#858de4)", colors: { bg: "#e7f4ff", c1: "#7b9de3", c2: "#5ab8e5", c3: "#8e8cdf", c4: "#92d9ee" } },
  mint: { name: "薄荷", swatch: "linear-gradient(135deg,#b1ead5,#62cdbb,#77b9d7)", colors: { bg: "#e5f7ef", c1: "#71c4af", c2: "#58bec0", c3: "#8ab8d4", c4: "#aadcb2" } },
  peach: { name: "蜜桃", swatch: "linear-gradient(135deg,#f7ceac,#eea4ab,#c99bdd)", colors: { bg: "#fff0e7", c1: "#e8a088", c2: "#e6adb9", c3: "#be97d3", c4: "#f4bf94" } },
};
export const orbPalette = (value?: OrbPaletteId) => ORB_PALETTES[value ?? "aurora"];
