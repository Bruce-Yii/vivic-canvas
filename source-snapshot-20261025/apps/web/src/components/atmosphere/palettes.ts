/**
 * VIVIIC 动态背景调色实验室 palettes (user-provided HTML, 2026-10-17).
 * `colors` feed the shader as [base, A, B, C]; `swatch` is the lab's three-tone
 * preview circle. Only the palette is user-selectable — the motion is always
 * 流光以太 (Ether).
 */
export const DARK_PALETTE_IDS = ["graphite", "midnight", "ocean", "velvet", "ember", "forest"] as const;
export const LIGHT_PALETTE_IDS = ["milk", "peach", "lilac", "mint", "dawn", "berry"] as const;
export type DarkPaletteId = (typeof DARK_PALETTE_IDS)[number];
export type LightPaletteId = (typeof LIGHT_PALETTE_IDS)[number];
export type PaletteId = DarkPaletteId | LightPaletteId;

export interface AtmospherePalette {
  name: string;
  colors: readonly [string, string, string, string];
  swatch: readonly [string, string, string];
}

export const ATMOSPHERE_PALETTES: Record<PaletteId, AtmospherePalette> = {
  graphite: { name: "石墨星雾", colors: ["#0E101B", "#292B46", "#565577", "#947CAD"], swatch: ["#292b46", "#555475", "#907aab"] },
  midnight: { name: "午夜蓝紫", colors: ["#0C1224", "#20466B", "#5A52A2", "#AF6E9E"], swatch: ["#20466b", "#5a52a2", "#af6e9e"] },
  ocean: { name: "深海极光", colors: ["#071923", "#146475", "#2A9992", "#6686B9"], swatch: ["#146475", "#2a9992", "#6686b9"] },
  velvet: { name: "丝绒莓紫", colors: ["#180E20", "#68395C", "#9355A5", "#D281A6"], swatch: ["#68395c", "#9355a5", "#d281a6"] },
  ember: { name: "暮色余烬", colors: ["#1C111A", "#7C405D", "#BB665F", "#DAAC77"], swatch: ["#7c405d", "#bb665f", "#daac77"] },
  forest: { name: "雨夜森林", colors: ["#101A1A", "#3B645A", "#819D83", "#B3A67B"], swatch: ["#3b645a", "#819d83", "#b3a67b"] },
  milk: { name: "云朵蓝紫", colors: ["#F8FAFF", "#BCD7FA", "#DEC9FA", "#FADCEA"], swatch: ["#c2d9ff", "#ddcdff", "#f5cfe3"] },
  peach: { name: "奶油蜜桃", colors: ["#FFFBF7", "#FFDCC9", "#FFE8C8", "#E9D3F7"], swatch: ["#ffdfc8", "#ffeac6", "#e8cff7"] },
  lilac: { name: "丁香莓粉", colors: ["#FCF9FF", "#DEC6FC", "#F6CDE8", "#CFDCFA"], swatch: ["#dfc6ff", "#f5cbec", "#d3defa"] },
  mint: { name: "薄荷微风", colors: ["#F8FFFC", "#C5EAD9", "#CBE9F7", "#E9D6F5"], swatch: ["#c3e9d7", "#cde9f8", "#e8d8f7"] },
  dawn: { name: "纯白晨光", colors: ["#FFFFFF", "#CFE2FA", "#F7DFE8", "#FBE4D1"], swatch: ["#cce0ff", "#f5e0e6", "#ffe5c8"] },
  berry: { name: "蓝莓牛奶", colors: ["#FBFCFF", "#C5D1F9", "#E5D5FC", "#C5EAF0"], swatch: ["#becbf9", "#e5d5fa", "#c9eff0"] },
};

export const DEFAULT_DARK_PALETTE: DarkPaletteId = "midnight";
export const DEFAULT_LIGHT_PALETTE: LightPaletteId = "milk";

/** The palette shown for a resolved theme; missing preferences fall back to the defaults. */
export const paletteFor = (
  theme: "light" | "dark",
  preferences: { darkPalette?: DarkPaletteId; lightPalette?: LightPaletteId },
): PaletteId => theme === "dark" ? preferences.darkPalette ?? DEFAULT_DARK_PALETTE : preferences.lightPalette ?? DEFAULT_LIGHT_PALETTE;
