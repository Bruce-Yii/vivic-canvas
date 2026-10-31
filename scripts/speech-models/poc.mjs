import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const web = path.join(root, "apps/web");
const require = createRequire(path.join(web, "package.json"));
const { build } = await import(require.resolve("vite"));
const { chromium } = require("@playwright/test");
const owned = path.join(root, ".cache/sherpaw-poc");
const defaultWake = process.argv.includes("--default-wake");
const defaultWakeOut = path.join(root, "evidence/next-plan", `default-wake-${new Date().toISOString().replace(/[:.]/g, "-")}`);
if (defaultWake) await mkdir(defaultWakeOut, { recursive: true });
const silenceSeconds = Number(process.argv.find(arg => arg.startsWith("--silence-seconds="))?.split("=")[1] ?? 0);
if (!Number.isFinite(silenceSeconds) || silenceSeconds < 0 || silenceSeconds > 300) throw new Error("Invalid silence seconds");
const outDir = path.join(owned, defaultWake ? "default-wake-browser-build" : "browser-build");
const manifest = JSON.parse(await readFile(path.join(web, "public/models/sherpaw-manifest.json"), "utf8"));
await mkdir(owned, { recursive: true });
// Isolated production build. Never changes the app's Vite configuration or dist.
await build({ configFile: false, root: web, publicDir: false, cacheDir: path.join(owned, "vite-cache"),
  resolve: { alias: { "@": path.join(web, "src") } },
  build: { outDir, emptyOutDir: true, target: "es2023", reportCompressedSize: false,
    rollupOptions: { input: path.join(web, `src/ai/localSpeech/__tests__/${defaultWake ? "defaultWakeHarness" : "browserHarness"}.ts`), output: { entryFileNames: "harness.js" } },
  },
});
const fixture = path.join(root, "evidence/phase2-voice-input/synthetic-command.wav");
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end('<!doctype html><html lang="zh"><meta charset="UTF-8"><title>Local speech isolated PoC</title><body><p>File-only local speech test; microphone and playback disabled.</p><script type="module" src="/harness.js"></script></body></html>'); return;
  }
  const model = manifest.models.find(model => pathname === `/__local-speech-model/${model.id}`);
  const worklet = path.join(web, "public/audio-capture-worklet.js");
  const wakeFixture = /^\/__wake-fixture\/(?:wake|command)-(?:3|6|9)\.wav$/.test(pathname) ? path.join(root, "evidence/next-plan/wake-fixtures", path.basename(pathname)) : null;
  const file = wakeFixture ?? (model ? path.join(owned, "models", `${model.id}.bin`) : pathname === "/__local-speech-fixture.wav" ? fixture
    : pathname === "/audio-capture-worklet.js" ? worklet : path.resolve(outDir, `.${pathname}`));
  if (!model && !wakeFixture && file !== fixture && file !== worklet && !file.startsWith(outDir + path.sep)) { response.writeHead(403); response.end(); return; }
  const extension = path.extname(file);
  const contentType = { ".js": "text/javascript", ".wasm": "application/wasm", ".wav": "audio/wav", ".json": "application/json" }[extension] ?? "application/octet-stream";
  response.setHeader("Access-Control-Allow-Origin", "*");
  const size = await stat(file).catch(() => null);
  if (size) response.setHeader("Content-Length", size.size);
  const stream = createReadStream(file);
  stream.once("error", () => { if (!response.headersSent) response.writeHead(404); response.end(); });
  response.setHeader("Content-Type", contentType); stream.pipe(response);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
if ([5174, 8788].includes(port)) throw new Error("Reserved integration port selected");
console.log(`LOCAL_SPEECH_POC_PORT=${port} (isolated headless, no app/API server)`);
const browser = await chromium.launch({ headless: true, args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ permissions: [] });
const browserErrors = [], network = [], resources = [];
const page = await context.newPage();
page.on("pageerror", error => browserErrors.push(error.message));
page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text().slice(0, 1000)); if (message.text().startsWith("[speech-poc]")) console.log(message.text()); });
page.on("crash", () => console.error("POC_PAGE_CRASH"));
browser.on("disconnected", () => console.error("POC_BROWSER_DISCONNECTED"));
await context.addInitScript(() => {
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error("Physical microphone forbidden in local speech PoC"); };
  if (window.speechSynthesis) window.speechSynthesis.speak = () => { throw new Error("Audio output forbidden in local speech PoC"); };
});
await context.route("**/*", async route => {
  const url = route.request().url(); network.push(new URL(url).origin + new URL(url).pathname);
  if (new URL(url).origin === `http://127.0.0.1:${port}`) return route.continue();
  const model = manifest.models.find(model => model.url === url);
  if (model?.id === "vad" && process.env.SPEECH_POC_LIVE_VAD === "1") return route.continue();
  if (process.env.SPEECH_POC_LIVE_VAD === "1") {
    let previous = route.request().redirectedFrom();
    while (previous) {
      if (previous.url() === manifest.models.find(model => model.id === "vad").url) return route.continue();
      previous = previous.redirectedFrom();
    }
  }
  // Do not serialize 169MB through Playwright's protocol; stream the fixed verified file over HTTP.
  if (model) return route.fulfill({ status: 302, headers: { Location: `http://127.0.0.1:${port}/__local-speech-model/${model.id}`, "Access-Control-Allow-Origin": "*" } });
  return route.abort("blockedbyclient");
});
const cdp = await browser.newBrowserCDPSession();
let polling = false;
const sampleResources = async () => {
  if (polling) return; polling = true;
  try {
    const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
    const ids = processInfo.map(process => String(process.id)).filter(id => /^\d+$/.test(id));
    const output = execFileSync("ps", ["-o", "pid=,rss=,%cpu=", "-p", ids.join(",")], { encoding: "utf8" });
    resources.push({ at: Date.now(), processes: output.trim() });
  } catch { /* Process churn is expected when workers terminate. */ }
  finally { polling = false; }
};
const timer = setInterval(() => { void sampleResources(); }, 500);
const readSystem = key => { try { return execFileSync("sysctl", ["-n", key], { encoding: "utf8" }).trim(); } catch { return "unavailable"; } };
let report;
try {
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "load" });
  await page.waitForFunction(wake => typeof window[wake ? "runDefaultWakePoc" : "runLocalSpeechPoc"] === "function", defaultWake);
  report = defaultWake ? await page.evaluate(seconds => window.runDefaultWakePoc(seconds), silenceSeconds) : await page.evaluate(() => window.runLocalSpeechPoc());
  report = { ...report, browserErrors, network, port, resources,
    machine: { cpu: readSystem("machdep.cpu.brand_string"), memoryBytes: readSystem("hw.memsize") },
    note: "Production bundle; synthetic WAV only. RSS/%CPU snapshots are browser process samples, not a sustained performance guarantee.",
  };
  await writeFile(defaultWake ? path.join(defaultWakeOut, "report.json") : path.join(owned, "browser-result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, (key, value) => ["network", "resources"].includes(key) ? `[${value.length} records]` : value, 2));
  if (!report.ok || browserErrors.length) process.exitCode = 1;
} catch (error) {
  console.error("POC_FAILURE", error);
  await writeFile(defaultWake ? path.join(defaultWakeOut, "failure.json") : path.join(owned, "browser-failure.json"), JSON.stringify({ error: String(error), browserErrors, network, resources }, null, 2));
  process.exitCode = 1;
} finally {
  clearInterval(timer); await context.close().catch(() => {}); await browser.close().catch(() => {});
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
