import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const requireWeb = createRequire(path.resolve(here, "../../apps/web/package.json"));
const { defineConfig } = requireWeb("@playwright/test");
export default defineConfig({
  testDir: path.join(here, "tests"), fullyParallel: false, workers: 1, retries: 0, timeout: 30000,
  outputDir: path.join(here, "test-results"), reporter: "list",
  use: { baseURL: "http://127.0.0.1:5196", headless: true, reducedMotion: "reduce", screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "node server.mjs", cwd: here, url: "http://127.0.0.1:5196", reuseExistingServer: false, timeout: 15000 },
});
