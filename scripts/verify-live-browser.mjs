import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
const apiRequire = createRequire(new URL("../apps/local-api/package.json", import.meta.url));
const { chromium, expect } = webRequire("@playwright/test");
const sharp = apiRequire("sharp");
const base = "http://localhost:5173";
const dir = new URL("../evidence/phase3-live-browser/", import.meta.url);
await mkdir(dir, { recursive: true });
const report = { checkedAt: new Date().toISOString(), audioPlayed: false, microphoneCaptured: false,
  data: "Only a generated TEST arithmetic image and public queries; isolated browser storage.", cases: [] };
const browser = await chromium.launch({ headless: true, args: ["--mute-audio"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: new URL("videos/", dir).pathname, size: { width: 1440, height: 900 } } });
await context.addInitScript(() => {
  localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", browserVoice: "" }));
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error("Physical microphone forbidden in this verification"); };
});
let previous = "stepfun";
const errors = [];
async function post(path, data) { const response = await context.request.post(base + path, { data, headers: { Origin: base }, timeout: 30_000 }); return response.json(); }
const save = () => writeFile(new URL("live.json", dir), JSON.stringify(report, null, 2) + "\n");
try {
  const before = await (await context.request.get(base + "/api/providers/status")).json(); previous = before.activeProvider ?? "stepfun";
  const connected = await post("/api/gpt/connect", { source: "pi" }); assert.equal(connected.ok, true, connected.lastError);
  assert.ok(connected.capabilities.includes("vision"));
  assert.equal((await post("/api/providers/select", { provider: "gpt" })).ok, true);
  report.model = connected.defaultModel;
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(base + "/control"); await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  await expect(page.locator("[data-vivic-tts-toggle]")).not.toBeChecked();
  const canvasId = await page.evaluate(() => window.__vivicControl.snapshot().activeCanvasId);
  const display = await context.newPage(); display.on("pageerror", error => errors.push(error.message));
  await display.goto(base + "/display?canvasId=" + canvasId);
  async function command(name, text, verify) {
    const out = { name, input: text, ok: false }; const began = performance.now();
    try {
      const pending = page.waitForResponse(response => response.url().endsWith("/api/intent") && response.request().method() === "POST", { timeout: 100_000 });
      await page.locator("[data-vivic-command-input]").fill(text); await page.locator("[data-vivic-command-send]").click();
      const response = await pending; out.http = response.status(); out.result = await response.json();
      assert.equal(out.http, 200); assert.equal(out.result.kind, "envelope", out.result.message);
      await verify(out); out.ok = true;
    } catch (error) { out.error = error instanceof Error ? error.message : "Verification failed"; }
    out.elapsedMs = Math.round(performance.now() - began); report.cases.push(out); await save();
    console.log(JSON.stringify({ name, ok: out.ok, elapsedMs: out.elapsedMs, error: out.error }));
  }
  const testImage = await sharp(Buffer.from('<svg width="400" height="160" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="160" fill="white"/><text x="20" y="40" font-family="Arial" font-size="24" fill="black">TEST</text><text x="20" y="112" font-family="Arial" font-size="54" fill="black">17 + 26</text></svg>')).png().toBuffer();
  await writeFile(new URL("TEST-arithmetic.png", dir), testImage);
  await page.getByLabel("选择图片附件").setInputFiles({ name: "TEST-arithmetic.png", mimeType: "image/png", buffer: testImage });
  await expect(page.getByAltText("待发送图片预览")).toBeVisible();
  await command("real-gpt-vision", "读取图片里的算式并算出结果，创建一张简短便笺。", async out => {
    assert.equal(out.result.usedProvider, "gpt");
    const notes = out.result.envelope.actions.filter(action => action.type === "card.create" && action.card.type === "NoteCard");
    assert.ok(notes.length > 0); assert.match(JSON.stringify(notes.map(action => action.card.displayProps)), /43/);
    await expect(display.locator('[data-card-id="' + notes[0].card.id + '"]')).toContainText("43");
    const state = await display.evaluate(() => JSON.stringify(window.__vivic.getState()));
    assert.ok(!state.includes(testImage.toString("base64"))); assert.ok(!state.includes("data:image/"));
  });
  await command("real-current-weather", "上海,上海市天气", async out => {
    const card = out.result.envelope.actions.find(action => action.type === "card.create" && action.card.type === "WeatherCard")?.card;
    assert.ok(card && card.sources.some(source => source.provider === "open-meteo/forecast"));
    await expect(display.locator('[data-card-id="' + card.id + '"]')).toContainText("°C");
  });
  await command("user-data-table", "用表格记录：周一3，周二5，周三4", async out => {
    const card = out.result.envelope.actions.find(action => action.type === "card.create" && action.card.type === "TableCard")?.card;
    assert.ok(card); assert.deepEqual(card.displayProps.rows.map(row => row[1]), [3, 5, 4]);
    await expect(display.locator('[data-card-id="' + card.id + '"] tbody tr')).toHaveCount(3);
  });
  await command("existing-table-to-chart", "把这张表格画成柱状图", async out => {
    const card = out.result.envelope.actions.find(action => action.type === "card.create" && action.card.type === "ChartCard")?.card;
    assert.ok(card); assert.deepEqual(card.displayProps.points.map(point => point.y), [3, 5, 4]);
    await expect(display.locator('[data-card-id="' + card.id + '"] .recharts-bar-rectangle')).toHaveCount(3);
  });
  await command("real-gpt-search-cards", "搜索 React Flow 官方文档", async out => {
    assert.equal(out.result.usedProvider, "search");
    const cards = out.result.envelope.actions.filter(action => action.type === "card.create").map(action => action.card);
    assert.ok(cards.length > 0 && cards.every(card => card.sources.some(source => source.provider === "pi-web-access/gpt-oauth")));
    await expect(display.locator("[data-vivic-source-link]")).toHaveCount(cards.length);
  });
  async function verifyLayout() {
    return display.locator("[data-card-id]").evaluateAll(elements => {
      const bounds = elements.map(element => ({ id: element.getAttribute("data-card-id"), ...element.getBoundingClientRect().toJSON() }));
      const overlaps = [];
      for (let i = 0; i < bounds.length; i++) for (let j = i + 1; j < bounds.length; j++) {
        const a = bounds[i], b = bounds[j];
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.25 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.25) overlaps.push([a.id, b.id]);
      }
      return { cards: bounds.length, overlaps };
    });
  }
  await expect.poll(async () => (await verifyLayout()).overlaps).toEqual([]);
  report.layoutBeforeReload = await verifyLayout();
  await page.screenshot({ path: new URL("real-control.png", dir).pathname, fullPage: true });
  await display.screenshot({ path: new URL("real-display.png", dir).pathname });
  const beforeReload = await display.locator("[data-card-id]").count(); await display.reload();
  await expect(display.locator("[data-card-id]")).toHaveCount(beforeReload); report.reloadPreservedCards = beforeReload;
  await expect.poll(async () => (await verifyLayout()).overlaps).toEqual([]);
  report.layoutAfterReload = await verifyLayout();
  report.pageErrors = errors; report.ok = report.cases.every(out => out.ok) && !errors.length;
} catch (error) { report.ok = false; report.error = error instanceof Error ? error.message : "Verification failed"; }
finally {
  await post("/api/providers/select", { provider: previous }).catch(() => undefined);
  await context.close(); await browser.close(); report.completedAt = new Date().toISOString(); await save();
}
process.exitCode = report.ok ? 0 : 1;
