import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * Build of the beta landing only, with relative URLs so it works under any
 * sub-path of a static host (e.g. /vivic/).
 *   default            dist-landing/: code-split, lazy chunks load on demand (for hosting)
 *   LANDING_SINGLE=1   dist-landing-single/: one JS chunk, one stylesheet, assets inlined,
 *                      for scripts/inline-landing.mjs to fold into a single HTML file
 * Set VITE_LANDING_APP_URL when the build has no Vivic app beside it.
 */
const single = process.env.LANDING_SINGLE === "1";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  base: "./",
  build: {
    outDir: single ? "dist-landing-single" : "dist-landing",
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    ...(single ? { assetsInlineLimit: 100_000_000, cssCodeSplit: false, modulePreload: false } : {}),
    rolldownOptions: {
      input: { landing: path.resolve(import.meta.dirname, "landing/index.html") },
      ...(single ? { output: { inlineDynamicImports: true } } : {}),
    },
  },
});
