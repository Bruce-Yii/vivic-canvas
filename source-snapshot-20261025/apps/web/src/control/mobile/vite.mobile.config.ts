import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, "../../../../..");

/** Separate mobile entry; never replaces the desktop App or its Vite config. */
export default defineConfig({
  base: "./",
  root: directory,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(directory, "../..") } },
  server: { host: "127.0.0.1", port: 5174, strictPort: true, fs: { allow: [repository] } },
  build: {
    outDir: path.join(repository, "contrib/mobile-console/dist-ui"), emptyOutDir: true,
    rolldownOptions: { input: path.join(directory, "index.html") },
  },
});
