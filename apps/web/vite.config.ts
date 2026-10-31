import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

/**
 * Hosted development keeps the frontend origin and cookie identity intact.
 * Only explicit legacy mode reads/injects the old local session bearer.
 * Tests may override the target through VIVIC_LOCAL_API.
 */

const readLocalToken = (): string | undefined => {
  try {
    const file = path.resolve(import.meta.dirname, "../local-api/.env.local");
    const line = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .find((l) => l.startsWith("VIVIC_LOCAL_TOKEN="));
    return line?.split("=")[1]?.trim();
  } catch {
    return undefined;
  }
};

export function onlinePublicAssetEntries(publicDirectory = path.resolve(import.meta.dirname, "public")) {
  const approved = fs.readdirSync(publicDirectory, { withFileTypes: true }).filter(entry => entry.isFile() &&
    (entry.name === "favicon.svg" || entry.name === "icons.svg" || entry.name === "audio-capture-worklet.js" || /^HARK-SOURCE[^/\\]*\.(?:txt|json)$/.test(entry.name)))
    .map(entry => ({ fileName: entry.name, path: path.join(publicDirectory, entry.name) }));
  for (const fileName of ["downloads/Vivic-Remote.apk", "downloads/android.json"]) {
    const filename = path.join(publicDirectory, fileName);
    if (fs.existsSync(filename) && fs.statSync(filename).isFile()) approved.push({ fileName, path: filename });
  }
  return approved;
}
export function emitOnlinePublicAssets(emit: (asset: { type: "asset"; fileName: string; source: Uint8Array }) => unknown, publicDirectory?: string) {
  for (const entry of onlinePublicAssetEntries(publicDirectory)) emit({ type: "asset", fileName: entry.fileName, source: fs.readFileSync(entry.path) });
}

export default defineConfig(({ mode: requestedMode }) => {
 const owner = requestedMode === "owner", mode = owner ? "online" : requestedMode;
 return ({
  publicDir: mode === "online" ? false : undefined,
  plugins: [react(), tailwindcss(), { name: "vivic-online-build-marker", transformIndexHtml: { order: "pre", handler(html) {
    if (mode !== "online") return html;
    if (!html.includes('src="/src/main.tsx"')) throw new Error("Online HTML must contain the explicit /src/main.tsx entry to replace.");
    return html.replace('src="/src/main.tsx"', owner ? 'src="/src/hosted/owner-entry.tsx"' : 'src="/src/hosted/entry.tsx"');
  } }, generateBundle() {
    if (mode === "online") {
      this.emitFile({ type: "asset", fileName: ".vivic-online-build.json", source: JSON.stringify({ mode: "online", version: 1, ...(owner ? { ui: "owner", cursorCommit: "43d8e3a" } : {}) }) });
      emitOnlinePublicAssets(asset => this.emitFile(asset));
    }
  } }],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  build: {
    rolldownOptions: {
      // Second page: the beta landing at /landing/ (its own React entry, src/landing/).
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        ...(mode === "online" ? {} : { landing: path.resolve(import.meta.dirname, "landing/index.html") }),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: mode === "online" ? 5180 : 5175,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.VIVIC_LOCAL_API ?? (mode === "online" ? "http://127.0.0.1:8790" : "http://127.0.0.1:8787"),
        changeOrigin: mode !== "online",
        configure: (proxy) => {
          if (mode === "online") return;
          proxy.on("proxyReq", (proxyReq) => {
            // Lazy re-read per request: the API generates .env.local on its
            // first boot, possibly after this config was evaluated.
            const token = readLocalToken();
            if (token) {
              proxyReq.setHeader("authorization", `Bearer ${token}`);
            }
          });
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
}); });
