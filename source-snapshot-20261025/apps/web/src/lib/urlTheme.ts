import { canvasStore } from "@/state/canvasStore";

/** Phase 0 behavior: ?theme=light|dark|auto presets the ambient theme. */
export const applyUrlTheme = () => {
  const theme = new URLSearchParams(window.location.search).get("theme");
  if (theme === "light" || theme === "dark" || theme === "auto") {
    canvasStore.dispatch({
      schemaVersion: "0.6",
      requestId: `url-theme-${Date.now()}`,
      canvasId: "boot",
      actions: [{ type: "ambient.setPreset", preset: "grainient", theme }],
    });
  }
};
