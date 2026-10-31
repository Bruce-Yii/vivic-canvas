import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const directory = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(directory, "../../..");
const host = process.env.VIVIC_MOBILE_TEST_HOST ?? "127.0.0.1";
if (host !== "127.0.0.1") throw new Error("Mobile development relay controls require 127.0.0.1; use port 5184 for an isolated parallel run.");
const port = Number(process.env.VIVIC_MOBILE_TEST_PORT ?? 5174);
if (![5174, 5184].includes(port)) throw new Error("Mobile tests require an approved isolated port.");
const origin = `http://${host}:${port}`;
const viteCli = path.join(path.dirname(fileURLToPath(import.meta.resolve("vite/package.json"))), "bin/vite.js");
export default defineConfig({
  testDir: path.join(path.dirname(fileURLToPath(import.meta.resolve("@vivic/mobile-console-prototype/protocol"))), "browser"),
  outputDir: path.resolve(directory, "../../../../../evidence/mobile-console/browser-results"),
  workers: 1, timeout: 40_000, reporter: [["list"]],
  use: {
    baseURL: origin, viewport: { width: 390, height: 844 },
    reducedMotion: "reduce", trace: "off", video: "off",
    launchOptions: { args: ["--mute-audio"], ...(process.env.VIVIC_E2E_CHROMIUM ? { executablePath: process.env.VIVIC_E2E_CHROMIUM } : {}) },
  },
  webServer: {
    command: `"${process.execPath}" "${viteCli}" --host ${host} --port ${port} --strictPort`, cwd: web,
    url: `${origin}/src/control/mobile/index.html`, reuseExistingServer: false,
    timeout: 30_000,
  },
});
