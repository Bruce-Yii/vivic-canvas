import { defineConfig } from "@playwright/test";

/** Run after pnpm build, separately from the development regression suite. */
export default defineConfig({
  testDir: "./tests/production",
  workers: 1,
  timeout: 30_000,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:5174", launchOptions: { args: ["--mute-audio"] } },
  webServer: {
    command: "pnpm exec vite preview --host 127.0.0.1 --port 5174 --strictPort",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: false,
    env: { VIVIC_LOCAL_API: "http://127.0.0.1:8788" },
  },
});
