import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/online", testMatch: "online-native-full.spec.ts", workers: 1, timeout: 240_000,
  expect: { timeout: 15000 }, reporter: [["list"]],
  outputDir: `../../.cache/full-android-20261024/browser-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  use: { viewport: { width: 1440, height: 900 }, launchOptions: { args: ["--mute-audio"] } },
});
