#!/usr/bin/env node
/** Isolated production-snapshot stress runner. No application test hooks,
 * provider calls, microphone, audio playback, or the user's service ports. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve, extname, join } from "node:path";
import { mkdir, readFile, writeFile, appendFile, readdir, stat, rm, mkdtemp } from "node:fs/promises";
import { tmpdir, platform, arch } from "node:os";
import { performance } from "node:perf_hooks";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireWeb = createRequire(join(root, "apps/web/package.json"));
const { chromium, firefox, webkit } = requireWeb("@playwright/test");
const opts = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...parts] = value.replace(/^--/, "").split("=");
  return [key, parts.length ? parts.join("=") : true];
}));
if (opts["analyze-run"]) {
  const evidenceRoot = join(root, "evidence/phase3-stability");
  const dir = resolve(root, opts["analyze-run"]);
  assert(dir.startsWith(evidenceRoot + "/"), "Analyze only this task's evidence directories");
  const data = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
  const segments = new Map();
  for (const sample of data.samples) for (const [role, page] of Object.entries(sample.pages)) {
    if (!page.timeOrigin) continue;
    const key = `${role}:${page.timeOrigin}`;
    if (!segments.has(key)) segments.set(key, { role, timeOrigin: page.timeOrigin, rows: [] });
    segments.get(key).rows.push({ at: sample.at, soakElapsedMs: sample.soakElapsedMs, ...page });
  }
  const perDocument = [...segments.values()].map(({ role, timeOrigin, rows }) => {
    const heap = rows.map(r => r.jsHeapBytes?.used).filter(Number.isFinite);
    const deltas = rows.map(r => r.frameIntervalMs?.p95).filter(Number.isFinite);
    const frames = rows.reduce((sum, r) => sum + (r.frameIntervalMs?.count ?? 0), 0);
    const span = (Date.parse(rows.at(-1).at) - Date.parse(rows[0].at)) / 60000;
    return { role, timeOrigin, samples: rows.length, firstAt: rows[0].at, lastAt: rows.at(-1).at,
      sampledSpanMinutes: span, cards: [...new Set(rows.map(r => r.cards))],
      jsHeapBytes: heap.length ? { min: Math.min(...heap), max: Math.max(...heap), first: heap[0], last: heap.at(-1),
        endpointDeltaMiBPerMinute: span > 0 ? (heap.at(-1) - heap[0]) / 1048576 / span : null } : null,
      rAF: { frames, perWindowP95MsRange: deltas.length ? [Math.min(...deltas), Math.max(...deltas)] : null,
        weightedMeanMs: frames ? rows.reduce((sum, r) => sum + (r.frameIntervalMs?.mean ?? 0) * (r.frameIntervalMs?.count ?? 0), 0) / frames : null },
      longTasks: { count: rows.reduce((sum, r) => sum + (r.longTasks?.count ?? 0), 0), totalMs: rows.reduce((sum, r) => sum + (r.longTasks?.totalMs ?? 0), 0), maxMs: Math.max(...rows.map(r => r.longTasks?.maxMs ?? 0)) },
    };
  });
  const rawEvents = (await readFile(join(dir, "events.ndjson"), "utf8")).trim().split("\n").filter(Boolean).map(row => JSON.parse(row));
  const origin = Date.parse(data.startedAt), soakOrigin = Date.parse(data.soakStartedAt);
  const normalized = rawEvents.map(row => ({ ...row, rawElapsedMs: row.elapsedMs,
    elapsedMsFromISO: Date.parse(row.at) - origin,
    soakElapsedMsFromISO: Number.isFinite(soakOrigin) ? Date.parse(row.at) - soakOrigin : null }));
  await writeFile(join(dir, "normalized-events.ndjson"), normalized.map(row => JSON.stringify(row)).join("\n") + "\n");
  const summary = { analyzedAt: new Date().toISOString(), state: data.state, ok: data.ok,
    realSoak: { startedAt: data.soakStartedAt, finishedAt: data.soakFinishedAt, monotonicElapsedMs: data.soakCompletedElapsedMs,
      isoElapsedMs: Date.parse(data.soakFinishedAt) - Date.parse(data.soakStartedAt), requestedMinutes: data.durationRequestedMinutes },
    pageErrors: data.errors, requiredChecks: data.checks.filter(c => c.required),
    memoryScope: data.memoryMeaning, note: "No RSS measured. Heap segments are separated by document timeOrigin; endpoint trends are descriptive and do not prove absence of leaks. rAF is callback timing, not presentation FPS.",
    perDocument, cleanup: data.cleanup, videoFiles: data.videos, blockedExternalRequests: data.blockedExternalRequests,
    expectedBackendOfflineResponses: data.expectedBackendOfflineResponses,
    limits: ["Synthetic TEST todo cards, backend offline", data.recordVideo === false ? "Headless instrumentation overhead; no video recording" : "Headless video recording and instrumentation overhead", "No WebKit/Firefox run unless separately installed", "Real CDP freeze commands and synthetic document.hidden injection are separate checks", "No fixed-frame or hard performance SLA is inferred"] };
  await writeFile(join(dir, "analysis.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify({ analyzed: dir, state: data.state, realSoak: summary.realSoak, perDocument }, null, 2));
  process.exit(0);
}
if (opts.help !== undefined) {
  console.log("node scripts/verify-stability.mjs [--focused] [--no-video] [--duration-minutes=30] [--sample-seconds=60] [--browser=chromium] [--port=5174] [--analyze-run=evidence/phase3-stability/RUN]");
  process.exit(0);
}
const focused = opts.focused !== undefined;
const recordVideo = opts["no-video"] === undefined;
const minutes = Number(opts["duration-minutes"] ?? (focused ? 1 : 30)), sampleSeconds = Number(opts["sample-seconds"] ?? 60);
const port = Number(opts.port ?? 5174), browserName = opts.browser ?? "chromium";
assert(minutes > 0 && Number.isFinite(minutes)); assert(sampleSeconds >= 5 && sampleSeconds <= 60);
assert([5174, 5190].includes(port), "Use a reserved test port, never the user's 5173/8787 services.");
assert(["chromium", "firefox", "webkit"].includes(browserName));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(root, "evidence/phase3-stability", `${stamp}-${browserName}`);
await mkdir(join(out, "screenshots"), { recursive: true }); await mkdir(join(out, "videos"), { recursive: true });
const started = performance.now();
const report = { schemaVersion: 1, label: "SYNTHETIC TEST DATA / backend offline", startedAt: new Date().toISOString(),
  mode: focused ? "focused-new-snapshot" : "full-stress-soak",
  pid: process.pid, platform: platform(), arch: arch(), browserName, port, durationRequestedMinutes: minutes,
  thirtyMinuteRequested: minutes >= 30, fullThirtyMinuteRun: false, memoryMeaning: "JavaScript heap bytes (Performance.memory/CDP JSHeapUsedSize), NOT RSS",
  isolation: { appSourceModified: false, devHooksUsed: false, dbWritesFromHarness: false,
    externalRequestsAllowed: false, keysUsed: false, microphoneAllowed: false, audioOutputMuted: true,
    existingDistTouched: false, sharedServicePortsTouched: false, clockManipulated: false },
  instrumentation: "Bounded rAF deltas, PerformanceObserver longtasks, WebGL draw counters, navigation/visibility/error observers; test-only audio/microphone guards. " + (recordVideo ? "Full-session Playwright video adds overhead." : "No video recording."),
  recordVideo,
  checks: [], samples: [], errors: [], consoleErrors: [], consoleDiagnostics: [], browserDiagnostics: [], expectedBackendOfflineResponses: 0,
  apiPaths: {}, blockedExternalRequests: [], videos: [], cleanup: {}, state: "initializing" };
let server, browser, context, control, display, snapshotDir, soakStarted = null, stopping = false;
const sessions = new WeakMap();
const elapsed = () => Math.round(performance.now() - started);
const save = () => writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
async function event(type, detail = {}) {
  const row = { ...detail, at: new Date().toISOString(), elapsedMs: elapsed(), soakElapsedMs: soakStarted === null ? null : Math.round(performance.now() - soakStarted), type };
  await appendFile(join(out, "events.ndjson"), JSON.stringify(row) + "\n");
  console.log(JSON.stringify(row));
}
async function command(args, name) {
  const begin = performance.now(); const logfile = join(out, `${name}.log`);
  await event("command-start", { name, args });
  await new Promise((ok, fail) => {
    const child = spawn("pnpm", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    child.stdout.on("data", chunk => { void appendFile(logfile, chunk); }); child.stderr.on("data", chunk => { void appendFile(logfile, chunk); });
    child.once("error", fail); child.once("exit", code => code === 0 ? ok() : fail(new Error(`${name} exited ${code}; see ${logfile}`)));
  });
  await event("command-pass", { name, durationMs: Math.round(performance.now() - begin) });
}
async function manifest(dir, prefix = "") {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const rel = join(prefix, item.name), path = join(dir, item.name);
    if (item.isDirectory()) files.push(...await manifest(path, rel));
    else { const bytes = await readFile(path); files.push({ path: rel, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }); }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function check(name, fn, required = true) {
  const begin = performance.now(); const result = { name, startedAt: new Date().toISOString(), required, ok: false };
  try { result.detail = await fn(); result.ok = true; }
  catch (error) { result.error = error.stack ?? String(error); await event("check-fail", { name, error: result.error }); }
  result.elapsedMs = Math.round(performance.now() - begin); report.checks.push(result); await save();
  if (result.ok) await event("check-pass", { name, elapsedMs: result.elapsedMs, detail: result.detail });
  return result.ok;
}
async function poll(fn, accept, label, timeout = 20000) {
  const start = performance.now(); let value;
  while (performance.now() - start < timeout) {
    value = await fn(); if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`${label}: timed out, last=${JSON.stringify(value)}`);
}
async function shot(page, name) { const path = join(out, "screenshots", `${name}.png`); await page.screenshot({ path, fullPage: false, timeout: 20000 }); return path; }
async function instrument() {
  // This runs only inside the isolated browser context, not in the app bundle.
  const state = { startedAt: performance.now(), frames: [], frameCount: 0, lastFrame: null, tasks: [], taskCount: 0,
    webglDraws: 0, backgroundDrawsTotal: 0, visibility: [], lifecycle: [], audioAttempts: 0, microphoneAttempts: 0, contextLost: 0, contextRestored: 0, windowErrors: [], unhandledRejections: [] };
  Object.defineProperty(window, "__stabilityObserver", { value: state });
  addEventListener("error", event => { if (state.windowErrors.length < 1000) state.windowErrors.push({ message: event.message, filename: event.filename, at: performance.now() }); });
  addEventListener("unhandledrejection", event => { if (state.unhandledRejections.length < 1000) state.unhandledRejections.push({ message: String(event.reason), at: performance.now() }); });
  const frame = now => {
    if (state.lastFrame !== null && state.frames.length < 20000) state.frames.push(now - state.lastFrame);
    state.lastFrame = now; state.frameCount++; requestAnimationFrame(frame);
  }; requestAnimationFrame(frame);
  try { new PerformanceObserver(list => { for (const entry of list.getEntries()) {
    state.taskCount++; if (state.tasks.length < 5000) state.tasks.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name });
  } }).observe({ type: "longtask", buffered: true }); } catch { state.longTasksUnsupported = true; }
  document.addEventListener("visibilitychange", () => { state.lastFrame = null; state.visibility.push({ at: performance.now(), hidden: document.hidden, visibilityState: document.visibilityState }); });
  for (const type of ["freeze", "resume", "pageshow", "pagehide"]) addEventListener(type, event => state.lifecycle.push({ type, at: performance.now(), persisted: event.persisted ?? null }), true);
  addEventListener("webglcontextlost", () => state.contextLost++, true);
  addEventListener("webglcontextrestored", () => state.contextRestored++, true);
  for (const Proto of [globalThis.WebGLRenderingContext?.prototype, globalThis.WebGL2RenderingContext?.prototype]) {
    if (!Proto) continue;
    for (const name of ["drawArrays", "drawElements"]) { const original = Proto[name];
      Proto[name] = function (...args) { state.webglDraws++; if (this.canvas?.closest?.('[data-vivic-layer="background"]')) state.backgroundDrawsTotal++; return original.apply(this, args); };
    }
  }
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { state.microphoneAttempts++; throw new DOMException("Denied by stability runner", "NotAllowedError"); };
  if (window.speechSynthesis) window.speechSynthesis.speak = () => { state.audioAttempts++; };
  HTMLMediaElement.prototype.play = async function () { state.audioAttempts++; throw new DOMException("Muted stability run", "NotAllowedError"); };
}
async function observe(page, role) {
  if (browserName === "chromium") {
    const session = await context.newCDPSession(page); sessions.set(page, session);
    await session.send("Performance.enable"); await session.send("Log.enable");
    session.on("Log.entryAdded", ({ entry }) => {
      const row = { role, at: new Date().toISOString(), ...entry };
      report.browserDiagnostics.push(row);
      void appendFile(join(out, "browser-diagnostics.ndjson"), JSON.stringify(row) + "\n");
    });
  }
  page.on("pageerror", error => { const row = { role, at: new Date().toISOString(), message: error.message, stack: error.stack };
    report.errors.push(row); void appendFile(join(out, "pageerrors.ndjson"), JSON.stringify(row) + "\n"); });
  page.on("crash", () => { report.errors.push({ role, at: new Date().toISOString(), message: "Page crashed" }); });
  page.on("console", msg => {
    if (!["error", "warning", "warn"].includes(msg.type())) return;
    const row = { role, at: new Date().toISOString(), level: msg.type(), text: msg.text(), location: msg.location() };
    report.consoleDiagnostics.push(row); void appendFile(join(out, "console-diagnostics.ndjson"), JSON.stringify(row) + "\n");
    if (msg.type() === "error") { report.consoleErrors.push(row); void appendFile(join(out, "console-errors.ndjson"), JSON.stringify(row) + "\n"); }
  });
  page.on("response", response => { if (response.url().includes("/api/") && response.status() === 503) report.expectedBackendOfflineResponses++; });
  page.on("close", () => { void event("page-closed", { role }); });
}
async function newControl() {
  const page = await context.newPage(); control = page; await observe(page, "control");
  await page.goto(`http://127.0.0.1:${port}/control`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-vivic-control="ready"][data-vivic-owner="owner"]').waitFor({ timeout: 20000 });
  return page;
}
async function send(text) {
  const input = control.locator("[data-vivic-command-input]");
  await input.fill(text); await control.locator("[data-vivic-command-send]").click();
  const expected = text === "显示全部" ? "已显示全部卡片" : "离线本地模式";
  await poll(() => control.locator("[data-vivic-command-feedback]").textContent(), value => Boolean(value?.includes(expected)), `local command ${text}`);
}
async function readRecord(page) {
  return page.evaluate(async () => {
    const db = await new Promise((ok, fail) => { const req = indexedDB.open("vivic"); req.onsuccess = () => ok(req.result); req.onerror = () => fail(req.error); });
    try {
      const tx = db.transaction(["canvases", "meta"], "readonly");
      const all = new Promise((ok, fail) => { const r = tx.objectStore("canvases").getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
      const preferences = new Promise((ok, fail) => { const r = tx.objectStore("meta").get("displayPreferences"); r.onsuccess = () => ok(r.result?.value ?? null); r.onerror = () => fail(r.error); });
      const [records, prefs] = await Promise.all([all, preferences]);
      return { records, preferences: prefs ? JSON.parse(prefs) : null };
    } finally { db.close(); }
  });
}
async function count(expected) {
  return poll(() => display.locator("[data-card-id]").count(), value => value === expected, `display count ${expected}`);
}
async function sample(tag) {
  const row = { tag, at: new Date().toISOString(), elapsedMs: elapsed(), soakElapsedMs: soakStarted === null ? null : Math.round(performance.now() - soakStarted), pages: {} };
  for (const [role, page] of [["control", control], ["display", display]]) {
    if (!page || page.isClosed()) { row.pages[role] = { closed: true }; continue; }
    try {
      const metrics = await page.evaluate(() => {
        const s = window.__stabilityObserver, frames = s.frames.splice(0), tasks = s.tasks.splice(0);
        const sorted = [...frames].sort((a, b) => a - b), p = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null;
        const memory = performance.memory;
        const result = { url: location.href, timeOrigin: performance.timeOrigin, documentAgeMs: performance.now(), hidden: document.hidden, visibilityState: document.visibilityState,
          cards: document.querySelectorAll("[data-card-id]").length, domNodes: document.querySelectorAll("*").length,
          frameIntervalMs: { count: frames.length, mean: frames.length ? frames.reduce((a, b) => a + b, 0) / frames.length : null, p50: p(.5), p95: p(.95), p99: p(.99), max: p(1), over50ms: frames.filter(x => x > 50).length },
          longTasks: { supported: !s.longTasksUnsupported, count: tasks.length, totalMs: tasks.reduce((a, b) => a + b.duration, 0), maxMs: Math.max(0, ...tasks.map(t => t.duration)), entries: tasks },
          jsHeapBytes: memory ? { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize, limit: memory.jsHeapSizeLimit, source: "performance.memory" } : null,
          webglDrawsSinceSample: s.webglDraws, backgroundDrawsTotal: s.backgroundDrawsTotal, webglContextLostCount: s.contextLost, webglContextRestoredCount: s.contextRestored,
          windowErrors: s.windowErrors, unhandledRejections: s.unhandledRejections,
          visibilityEvents: s.visibility, lifecycleEvents: s.lifecycle, microphoneAttempts: s.microphoneAttempts, suppressedAudioAttempts: s.audioAttempts,
          navigation: performance.getEntriesByType("navigation").map(n => ({ type: n.type, domContentLoadedMs: n.domContentLoadedEventEnd, loadMs: n.loadEventEnd, durationMs: n.duration, transferSize: n.transferSize })),
          devHooksPresent: { vivic: Boolean(window.__vivic), vivicControl: Boolean(window.__vivicControl) } };
        s.webglDraws = 0; return result;
      });
      if (browserName === "chromium") {
        let session = sessions.get(page);
        if (!session) { session = await context.newCDPSession(page); sessions.set(page, session); await session.send("Performance.enable"); }
        const result = await session.send("Performance.getMetrics");
        const values = Object.fromEntries(result.metrics.map(item => [item.name, item.value]));
        metrics.cdp = { JSHeapUsedSize: values.JSHeapUsedSize, JSHeapTotalSize: values.JSHeapTotalSize,
          Nodes: values.Nodes, Documents: values.Documents, TaskDuration: values.TaskDuration, LayoutCount: values.LayoutCount };
      }
      row.pages[role] = metrics;
    } catch (error) { row.pages[role] = { error: error.message }; report.errors.push({ role, message: error.message, at: row.at }); }
  }
  report.samples.push(row); await appendFile(join(out, "samples.ndjson"), JSON.stringify(row) + "\n"); await save();
  await event("sample", { tag, cards: row.pages.display?.cards, soakElapsedMs: row.soakElapsedMs,
    heapBytes: row.pages.display?.jsHeapBytes?.used, frameP95Ms: row.pages.display?.frameIntervalMs?.p95 });
  return row;
}
async function allCardsVisible() {
  return poll(() => display.locator("[data-card-id]").evaluateAll(nodes => ({ count: nodes.length,
    clipped: nodes.filter(node => { const r = node.getBoundingClientRect(); return r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1; }).length })),
    value => value.count === 60 && value.clipped === 0, "all 60 cards inside viewport after fit", 12000);
}
async function refresh(expected, tag) {
  const begin = performance.now(); await display.reload({ waitUntil: "domcontentloaded" }); await count(expected);
  return { expected, recoveryMs: Math.round(performance.now() - begin), screenshot: await shot(display, tag) };
}
async function dragFirst(expected, tag) {
  await count(expected);
  const node = display.locator("[data-card-id]").first(), id = await node.getAttribute("data-card-id");
  const baseline = (await readRecord(display)).records[0].cardsById[id].layout;
  const box = await node.boundingBox(); assert(box && box.width > 0 && box.height > 0);
  await display.mouse.move(box.x + box.width - Math.min(8, box.width / 4), box.y + Math.min(8, box.height / 4));
  await display.mouse.down(); await display.mouse.move(Math.min(1250, box.x + box.width + 65), Math.min(760, box.y + 75), { steps: 20 }); await display.mouse.up();
  const updated = await poll(async () => (await readRecord(display)).records[0].cardsById[id].layout,
    value => value.x !== baseline.x || value.y !== baseline.y, "drag persisted via owner", 15000);
  await refresh(expected, `${tag}-after-drag-refresh`);
  assert.deepEqual((await readRecord(display)).records[0].cardsById[id].layout, updated);
  return { id, before: baseline, after: updated };
}
async function reduced(on) {
  const toggle = control.locator("#canvas-pref-reducedMotion");
  const current = await toggle.getAttribute("aria-checked"); if ((current === "true") !== on) await toggle.click();
  await poll(async () => (await readRecord(display)).preferences?.reducedMotion, value => value === on, "reduced motion preference");
  await new Promise(resolve => setTimeout(resolve, 800));
  const before = await display.evaluate(() => window.__stabilityObserver.webglDraws);
  await new Promise(resolve => setTimeout(resolve, 1500));
  const after = await display.evaluate(() => window.__stabilityObserver.webglDraws);
  await shot(display, `reduced-motion-${on}-${elapsed()}`);
  return { preference: on, webglDrawCallsOver1500ms: after - before, note: "rAF sampler continues even when app animation is reduced" };
}
async function hiddenPath() {
  let actualFreeze = null;
  if (browserName === "chromium") {
    let session = sessions.get(display); if (!session) { session = await context.newCDPSession(display); sessions.set(display, session); }
    await session.send("Page.setWebLifecycleState", { state: "frozen" });
    await new Promise(resolve => setTimeout(resolve, 3000));
    await session.send("Page.setWebLifecycleState", { state: "active" });
    actualFreeze = await display.evaluate(() => ({ hidden: document.hidden, events: window.__stabilityObserver.lifecycle }));
  }
  // Headless tabs may remain visible. Explicitly label this path injection;
  // this does not alter Date/performance time and never claims real OS hide.
  const before = await display.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange")); return window.__stabilityObserver.webglDraws;
  });
  await new Promise(resolve => setTimeout(resolve, 2000));
  const hidden = await display.evaluate(() => ({ hidden: document.hidden, draws: window.__stabilityObserver.webglDraws }));
  await display.evaluate(() => { delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange")); });
  await count(60);
  return { actualFreeze, hiddenInjection: { synthetic: true, elapsedRealMs: 2000, hidden: hidden.hidden, webglDrawsWhileHidden: hidden.draws - before }, recovered: true };
}
async function loseContext() {
  const detail = await display.evaluate(() => {
    const canvas = document.querySelector('[data-vivic-layer="background"] canvas');
    if (!canvas) return { supported: false, reason: "background is already using the non-WebGL fallback" };
    const gl = canvas.getContext("webgl2"), ext = gl?.getExtension("WEBGL_lose_context");
    if (!ext) return { supported: false, reason: "WEBGL_lose_context unavailable" };
    ext.loseContext(); return { supported: true, nativeExtension: true };
  });
  if (detail.supported) {
    await poll(() => display.locator('[data-vivic-layer="background"] canvas').isVisible(), value => !value, "WebGL loss fallback");
    await new Promise(resolve => setTimeout(resolve, 100));
    const before = await display.evaluate(() => window.__stabilityObserver.backgroundDrawsTotal);
    await new Promise(resolve => setTimeout(resolve, 500));
    const after = await display.evaluate(() => window.__stabilityObserver.backgroundDrawsTotal);
    assert.equal(after, before, "Lost background context must stop drawing");
    detail.drawCallsAfterLoss = after - before;
    await count(60); detail.screenshot = await shot(display, "native-webgl-context-loss-fallback");
  }
  return detail;
}
async function cleanup() {
  if (stopping) return; stopping = true;
  report.cleanup.startedAt = new Date().toISOString();
  const pages = context?.pages() ?? [];
  const videos = pages.map(page => page.video()).filter(Boolean);
  try { await context?.close(); report.cleanup.contextClosed = true; } catch (error) { report.cleanup.contextError = error.message; }
  for (const [index, video] of videos.entries()) { try { const path = await video.path(); report.videos.push({ path, bytes: (await stat(path)).size, retained: true, index }); } catch {} }
  for (const file of await readdir(join(out, "videos"))) {
    const path = join(out, "videos", file);
    if (!report.videos.some(video => video.path === path)) report.videos.push({ path, bytes: (await stat(path)).size, retained: true, note: "includes pages closed during owner recovery" });
  }
  try { await browser?.close(); report.cleanup.browserClosed = true; } catch (error) { report.cleanup.browserError = error.message; }
  if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  report.cleanup.serverClosed = !server?.listening;
  if (snapshotDir) { await rm(snapshotDir, { recursive: true, force: true }); report.cleanup.snapshotRemoved = true; }
  report.cleanup.finishedAt = new Date().toISOString(); report.finishedAt = new Date().toISOString(); report.elapsedMs = elapsed();
  report.soakElapsedMs = soakStarted === null ? null : Math.round(performance.now() - soakStarted);
  await save(); await event("cleanup-finished", report.cleanup);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { report.state = "interrupted"; report.exitCode = 130; void cleanup().then(() => process.exit(130)); });

try {
  report.runnerSha256 = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
  await event("run-start", { evidence: out, pid: process.pid }); await save();
  await command(["--filter", "@vivic/web", "typecheck"], "typecheck");
  snapshotDir = await mkdtemp(join(tmpdir(), "vivic-stability-snapshot-")); report.snapshotDir = snapshotDir;
  await command(["--filter", "@vivic/web", "exec", "vite", "build", "--outDir", snapshotDir, "--emptyOutDir"], "production-build");
  report.snapshotManifest = await manifest(snapshotDir); await writeFile(join(out, "snapshot-manifest.json"), JSON.stringify(report.snapshotManifest, null, 2) + "\n");
  const mimes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".webm": "video/webm" };
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith("/api/")) {
        report.apiPaths[url.pathname] = (report.apiPaths[url.pathname] ?? 0) + 1;
        res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: "SYNTHETIC TEST: backend offline (isolated static snapshot)", providers: [] })); return;
      }
      let path = resolve(snapshotDir, "." + decodeURIComponent(url.pathname));
      if (!path.startsWith(snapshotDir + "/") && path !== snapshotDir) { res.writeHead(403).end(); return; }
      let bytes; try { bytes = await readFile(path); } catch { path = join(snapshotDir, "index.html"); bytes = await readFile(path); }
      res.writeHead(200, { "content-type": mimes[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" }); res.end(bytes);
    } catch { res.writeHead(500).end(); }
  });
  await new Promise((ok, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", ok); });
  await event("static-server-start", { host: "127.0.0.1", port, snapshotDir });
  const engine = { chromium, firefox, webkit }[browserName];
  browser = await engine.launch({ headless: true, ...(browserName === "chromium" ? { args: ["--mute-audio", "--deny-permission-prompts", "--enable-precise-memory-info"] } : {}) });
  report.browserVersion = browser.version(); report.browserExecutable = engine.executablePath();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: [], serviceWorkers: "block",
    ...(recordVideo ? { recordVideo: { dir: join(out, "videos"), size: { width: 960, height: 600 } } } : {}) });
  await context.addInitScript(instrument);
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === `http://127.0.0.1:${port}` || ["data:", "blob:"].includes(url.protocol)) return route.continue();
    report.blockedExternalRequests.push({ at: new Date().toISOString(), origin: url.origin, pathname: url.pathname }); await route.abort("blockedbyclient");
  });
  control = await newControl();
  const canvasId = await control.locator("[data-vivic-active-canvas]").getAttribute("data-vivic-active-canvas"); assert(canvasId);
  const load = performance.now(); display = await context.newPage(); await observe(display, "display");
  await display.goto(`http://127.0.0.1:${port}/display?canvasId=${encodeURIComponent(canvasId)}`, { waitUntil: "domcontentloaded" });
  report.initialDisplayLoadMs = Math.round(performance.now() - load);
  assert.equal(await display.evaluate(() => Boolean(window.__vivic || window.__vivicControl)), false, "Production snapshot unexpectedly exposes DEV hooks");
  let created = 0;
  for (const target of [10, 30, 60]) {
    const begin = performance.now();
    while (created < target) {
      created++; await send(`加待办：SYNTHETIC TEST ${String(created).padStart(2, "0")} · backend offline`);
      await count(created);
    }
    await send("显示全部"); await count(target);
    const record = (await readRecord(display)).records.find(r => r.id === canvasId);
    assert.equal(record.cardOrder.length, target);
    await sample(`created-${target}`); await shot(display, `display-${target}-cards`); await shot(control, `control-${target}-cards`);
    await check(`refresh-${target}`, () => refresh(target, `display-${target}-after-refresh`));
    await check(`drag-${target}`, () => dragFirst(target, `display-${target}`));
    report.checks.push({ name: `ui-create-${target}`, ok: true, required: true, elapsedMs: Math.round(performance.now() - begin), cards: target, source: "actual Control text input + send button; no test hooks/IDB writes" });
  }
  await check("backend-offline-visible", async () => { const text = await control.locator("[data-vivic-intent-mode]").textContent(); assert.match(text, /离线|本地/); return { text }; });
  await shot(control, "control-synthetic-backend-offline");
  soakStarted = performance.now(); report.soakStartedAt = new Date().toISOString(); report.state = "soaking"; await save();
  await event("soak-start", { durationRealMinutes: minutes, expectedCards: 60, deadlineAt: new Date(Date.now() + minutes * 60000).toISOString() });
  await sample("soak-0");
  const schedule = focused ? [
    [0, "focused-dark-light-theme", async () => {
      const results = [];
      for (const [label, theme] of [["深色", "dark"], ["浅色", "light"]]) {
        await control.locator("[data-vivic-canvas-settings]").getByRole("radio", { name: label, exact: true }).click();
        await poll(() => display.locator("[data-vivic-theme]").getAttribute("data-vivic-theme"), value => value === theme, `theme ${theme}`);
        results.push({ theme, screenshot: await shot(display, `focused-theme-${theme}`) });
      }
      return results;
    }],
    [.1, "focused-drag-runtime-diagnostics", () => dragFirst(60, "focused-late-drag")],
    [.25, "focused-small-viewport-bounds", async () => {
      await display.setViewportSize({ width: 800, height: 600 }); await send("显示全部");
      const bounds = await allCardsVisible(); return { bounds, screenshot: await shot(display, "focused-800x600-bounds") };
    }],
    [.6, "focused-reduced-motion", () => reduced(true)],
  ] : [
    [3, "hidden-and-real-freeze-resume", hiddenPath],
    [5, "reduced-motion-on", () => reduced(true)],
    [6, "reduced-motion-off", () => reduced(false)],
    [8, "display-refresh-recovery", () => refresh(60, "minute-8-refresh")],
    [10, "owner-close-reopen-recovery", async () => { await control.close(); await new Promise(resolve => setTimeout(resolve, 4000)); await count(60); control = await newControl(); await count(60); return { cards: 60, recordCards: (await readRecord(display)).records[0].cardOrder.length }; }],
    [12, "native-webgl-context-loss", loseContext],
    [13, "webgl-reload-recovery", () => refresh(60, "minute-13-webgl-recovery")],
    [15, "small-viewport-60-cards", async () => { await display.setViewportSize({ width: 800, height: 600 }); await send("显示全部"); await count(60); const bounds = await allCardsVisible(); return { bounds, screenshot: await shot(display, "minute-15-800x600-60-cards") }; }],
    [18, "normal-viewport-recovery", async () => { await display.setViewportSize({ width: 1440, height: 900 }); await send("显示全部"); const bounds = await allCardsVisible(); return { bounds, screenshot: await shot(display, "minute-18-1440x900") }; }],
    [20, "dark-light-theme", async () => { await control.locator('[data-vivic-canvas-settings]').getByRole("radio", { name: "深色", exact: true }).click(); await poll(() => display.locator("[data-vivic-theme]").getAttribute("data-vivic-theme"), x => x === "dark", "dark theme"); await shot(display, "minute-20-dark"); await control.locator('[data-vivic-canvas-settings]').getByRole("radio", { name: "浅色", exact: true }).click(); await poll(() => display.locator("[data-vivic-theme]").getAttribute("data-vivic-theme"), x => x === "light", "light theme"); return { screenshot: await shot(display, "minute-20-light") }; }],
    [22, "late-drag-persistence", () => dragFirst(60, "minute-22")],
    [25, "system-reduced-motion-refresh", async () => { await display.emulateMedia({ reducedMotion: "reduce" }); return refresh(60, "minute-25-system-reduced"); }],
    [27, "system-motion-restore", async () => { await display.emulateMedia({ reducedMotion: "no-preference" }); return refresh(60, "minute-27-normal-motion"); }],
    [29, "final-refresh-and-integrity", async () => { const recovery = await refresh(60, "minute-29-final-refresh"); const records = await readRecord(display); assert.equal(records.records[0].cardOrder.length, 60); assert.equal(new Set(records.records[0].cardOrder).size, 60); return recovery; }],
  ];
  let index = 0, nextSample = sampleSeconds * 1000;
  while (performance.now() - soakStarted < minutes * 60000) {
    const age = performance.now() - soakStarted;
    while (index < schedule.length && age >= schedule[index][0] * 60000) {
      const [, name, fn] = schedule[index++]; await check(name, fn);
    }
    if (age >= nextSample) { await count(60); await sample(`soak-${Math.floor(age / 1000)}s`); nextSample += sampleSeconds * 1000; }
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(1, minutes * 60000 - (performance.now() - soakStarted)))));
  }
  await sample("soak-final"); await shot(display, "display-final-30min"); await shot(control, "control-final-30min");
  report.soakFinishedAt = new Date().toISOString(); report.soakCompletedElapsedMs = Math.round(performance.now() - soakStarted);
  report.fullThirtyMinuteRun = report.soakCompletedElapsedMs >= 30 * 60000;
  report.runtimeDiagnostics = [...report.consoleDiagnostics, ...report.browserDiagnostics].filter(row => /(?:error[ #]*015|#015|ResizeObserver loop|xyflow.*015)/i.test(row.text));
  const observedWindowErrors = report.samples.flatMap(sample => Object.values(sample.pages).flatMap(page => [...(page.windowErrors ?? []), ...(page.unhandledRejections ?? [])]));
  report.ok = report.errors.length === 0 && report.runtimeDiagnostics.length === 0 && observedWindowErrors.length === 0 && report.checks.every(check => !check.required || check.ok) && report.soakCompletedElapsedMs >= minutes * 60000;
  report.state = report.ok ? "passed" : "failed";
  await event("soak-finished", { ok: report.ok, actualElapsedMs: report.soakCompletedElapsedMs, pageErrors: report.errors.length });
} catch (error) {
  report.state = "failed"; report.ok = false; report.fatal = error.stack ?? String(error);
  await event("fatal", { error: report.fatal });
  for (const [role, page] of [["control", control], ["display", display]]) if (page && !page.isClosed()) { try { await shot(page, `fatal-${role}`); } catch {} }
} finally { report.exitCode = report.ok ? 0 : 1; await cleanup(); }
process.exitCode = report.exitCode;
