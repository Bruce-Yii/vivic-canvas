import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/online", workers: 1, timeout: 90000,
  expect: { timeout: 15000 }, reporter: [["list"]],
  outputDir: process.env.VIVIC_ONLINE_EVIDENCE_DIR ?? "../../.cache/online-20261023/browser",
  use: { baseURL: "http://localhost:18794", viewport: { width: 1440, height: 900 },
    launchOptions: { args: ["--mute-audio"] } },
  webServer: { command: "pnpm --filter @vivic/local-api exec node --import tsx src/online/index.ts",
    url: "http://localhost:18794/healthz", reuseExistingServer: true, timeout: 30000,
    env: { PORT: "18794", VIVIC_ONLINE_ORIGIN: "http://localhost:18794" } },
});
