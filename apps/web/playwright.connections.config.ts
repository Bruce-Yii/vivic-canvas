import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/connections", workers: 1, timeout: 100_000, expect: { timeout: 15_000 }, reporter: [["list"]],
  outputDir: "../../.cache/connections-browser-20261024",
  use: { baseURL: "http://localhost:17894", viewport: { width: 1440, height: 900 }, actionTimeout: 15_000, launchOptions: { args: ["--mute-audio"] }, screenshot: "only-on-failure", trace: "off" },
  webServer: [
    { command: "pnpm dev --mode online --port 17894 --strictPort", url: "http://localhost:17894", reuseExistingServer: false, timeout: 40_000,
      env: { VIVIC_LOCAL_API: "http://127.0.0.1:17895" } },
    { command: "node ../local-api/node_modules/tsx/dist/cli.mjs ../local-api/tests/fixtures/connections-browser-server.ts", url: "http://127.0.0.1:17895/healthz", reuseExistingServer: false, timeout: 40_000 },
  ],
});
