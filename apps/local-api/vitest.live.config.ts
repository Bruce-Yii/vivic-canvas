import { defineConfig } from "vitest/config";

/**
 * `STEPFUN_KEY=... pnpm test:live` — REAL network calls to StepFun.
 * Skipped entirely without a key; never mocked here.
 */
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
