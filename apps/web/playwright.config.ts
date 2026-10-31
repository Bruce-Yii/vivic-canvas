import { defineConfig } from "@playwright/test";

// Playwright manages its own dev servers so it never touches the user's
// dev processes: web on :5174, local decision API on 127.0.0.1:8788 with a
// stubbed StepFun base URL (per-test in-process stub on :45991). When those
// ports belong to another project, VIVIC_E2E_WEB_PORT / VIVIC_E2E_API_PORT /
// VIVIC_E2E_STUB_PORT move the whole run elsewhere (never reuse a foreign server).
export const E2E_WEB_PORT = Number(process.env.VIVIC_E2E_WEB_PORT ?? 5174);
export const E2E_API_PORT = Number(process.env.VIVIC_E2E_API_PORT ?? 8788);
export const E2E_STUB_PORT = Number(process.env.VIVIC_E2E_STUB_PORT ?? 45991);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  // Lazy routes, IndexedDB commits and background-window rendering are async.
  // Keep exact assertions while giving each UI transition an explicit budget.
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    actionTimeout: 20_000,
    baseURL: `http://localhost:${E2E_WEB_PORT}`,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    // Exercise playback state without emitting office audio.
    launchOptions: { args: ["--mute-audio"], ...(process.env.VIVIC_E2E_CHROMIUM ? { executablePath: process.env.VIVIC_E2E_CHROMIUM } : {}) },
  },
  webServer: [
    {
      command: `pnpm dev --port ${E2E_WEB_PORT} --strictPort`,
      url: `http://localhost:${E2E_WEB_PORT}`,
      reuseExistingServer: true,
      timeout: 30_000,
      env: {
        VIVIC_LOCAL_API: `http://127.0.0.1:${E2E_API_PORT}`,
      },
    },
    {
      command: "pnpm --filter @vivic/local-api start",
      url: `http://127.0.0.1:${E2E_API_PORT}/healthz`,
      reuseExistingServer: true,
      timeout: 30_000,
      env: {
        PORT: String(E2E_API_PORT),
        VIVIC_PREFERENCES: "off",
        STEPFUN_BASE_URL: `http://127.0.0.1:${E2E_STUB_PORT}/v1`,
        VIVIC_ALLOWED_ORIGINS: `http://localhost:${E2E_WEB_PORT},http://127.0.0.1:${E2E_WEB_PORT}`,
      },
    },
  ],
});
