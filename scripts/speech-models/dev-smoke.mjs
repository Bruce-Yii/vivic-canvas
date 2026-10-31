import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const web = path.join(root, "apps/web"), require = createRequire(path.join(web, "package.json"));
const { createServer } = await import(require.resolve("vite"));
const react = (await import(require.resolve("@vitejs/plugin-react"))).default;
const tailwind = (await import(require.resolve("@tailwindcss/vite"))).default;
const { chromium } = require("@playwright/test");
const owned = path.join(root, ".cache/sherpaw-poc"); await mkdir(owned, { recursive: true });
// Keep Vite's public directory enabled: this specifically exercises its public-import guard.
const uiRoute = { name: "local-speech-isolated-route", configureServer(dev) {
  // Register before Vite's SPA fallback; never serve the main application here.
  dev.middlewares.use(async (req, res, next) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/__local-speech-ui") return next();
    const html = await dev.transformIndexHtml("/__local-speech-ui", '<!doctype html><html lang="zh"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/favicon.svg"><body><div id="root"></div><script type="module" src="/src/ai/localSpeech/__tests__/uiHarness.tsx"></script></body></html>');
    res.setHeader("Content-Type", "text/html"); res.end(html);
  });
} };
const server = await createServer({ configFile: false, root: web, cacheDir: path.join(owned, "ui-vite-cache"),
  plugins: [react(), tailwind(), uiRoute], resolve: { alias: { "@": path.join(web, "src") } },
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
await server.listen(); const port = server.httpServer.address().port;
if ([5174, 8788].includes(port)) throw new Error("Reserved integration port selected");
console.log(`LOCAL_SPEECH_UI_PORT=${port} (isolated dev public-import check)`);
const browser = await chromium.launch({ headless: true, args: ["--mute-audio"] });
const context = await browser.newContext({ viewport: { width: 900, height: 900 }, permissions: [] });
const page = await context.newPage(), errors = [], requests = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
await context.addInitScript(() => {
  window.__speechCaptureAttempts = 0;
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { window.__speechCaptureAttempts++; throw new Error("Physical microphone forbidden"); };
  if (window.speechSynthesis) window.speechSynthesis.speak = () => { throw new Error("Playback forbidden"); };
});
page.on("request", request => requests.push(new URL(request.url()).pathname));
try {
  await page.goto(`http://127.0.0.1:${port}/__local-speech-ui`);
  await page.locator("[data-vivic-local-speech]").waitFor();
  await page.waitForTimeout(700);
  const text = await page.locator("main").innerText();
  const captureAttempts = await page.evaluate(() => window.__speechCaptureAttempts);
  const modelRows = await page.locator("[data-local-speech-model]").count();
  if (errors.length || captureAttempts || modelRows !== 3 || !text.includes("vivic")) throw new Error(JSON.stringify({ errors, captureAttempts, modelRows, text }));
  if (requests.some(url => /public\/models.*raw/.test(url))) throw new Error("public raw import regression");
  await page.screenshot({ path: path.join(owned, "settings-and-wake.png"), fullPage: true });
  const report = { ok: true, port, errors, captureAttempts, modelRows, requests, screenshot: ".cache/sherpaw-poc/settings-and-wake.png" };
  await writeFile(path.join(owned, "ui-result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  const report = { ok: false, error: String(error), errors, requests, url: page.url() };
  await writeFile(path.join(owned, "ui-failure.json"), JSON.stringify(report, null, 2));
  await page.screenshot({ path: path.join(owned, "ui-failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally { await context.close(); await browser.close(); await server.close(); }
