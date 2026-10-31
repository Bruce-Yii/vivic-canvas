import { test, expect } from "@playwright/test";
import path from "node:path";
import { activeCanvasId, controlDispatch, openPreferences } from "./helpers1";
import { testCards } from "../../src/cards/__tests__/fixtures";

test("TEST typography, materials, long text and fixed cards", async ({ page, context }, info) => {
  await context.addInitScript(() => {
    HTMLMediaElement.prototype.play = async () => { throw new Error("TEST no audio"); };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST no microphone"); };
  });
  await page.goto("/control");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  const id = await activeCanvasId(page);
  await openPreferences(page, true);
  await page.getByRole("radio", { name: "浅色", exact: true }).click();
  await page.getByRole("switch", { name: "减少动效" }).check();
  await controlDispatch(page, "TEST-visual", id, [{ type: "stage.awaken" }, ...[
    { ...testCards.NoteCard, variant: "expanded", displayProps: { text: "TEST 周五的阅读与工作安排\n先整理今天的思路，核对提醒事项与来源。中文正文需要清楚的行距，阅读时也应保留原有段落。\n记录项目进度与下一步，让注意力回到内容本身。", bullets: ["14:30 核对发布资料，保留所有来源", "完成后记录结论与待办"] }, layout: { x: 0, y: 0, width: 360, height: 300, pinned: true } },
    { ...testCards.SearchResultCard, displayProps: { title: "TEST 一篇关于阅读、空间与注意力的文章", summary: "信息层级从标题开始，正文以稳定的行距展开；来源退后一步，仍然清楚可见。中英文混排 Reading notes 2026。", sourceLabel: "example.com · 正文摘录" }, layout: { x: 420, y: 0, width: 360, height: 240, pinned: true } },
    { ...testCards.TodoCard, displayProps: { items: [{ id: "TEST-task1", text: "整理发布会资料和真实测试反馈", done: false }, { id: "TEST-task2", text: "核对 3 项体验改动", done: true }] }, layout: { x: 0, y: 400, width: 360, height: 160, pinned: true } },
    { ...testCards.CountdownCard, sourceData: { targetAt: new Date(Date.now() + 3600000).toISOString() }, layout: { x: 420, y: 340, width: 250, height: 100, pinned: true } },
    { ...testCards.WeatherCard, layout: { x: 420, y: 500, width: 250, height: 100, pinned: true } },
  ].map(card => ({ type: "card.create", card })), { type: "canvas.fit" }]);
  const display = await context.newPage(); await display.goto(`/display?canvasId=${id}`);
  await expect(display.locator(".vivic-card")).toHaveCount(5);
  await expect(display.locator('[data-vivic-stage="WORKSPACE"]')).toBeVisible();
  await display.evaluate(() => document.fonts.ready);
  const folder = path.resolve(process.cwd(), "../../evidence/experience-20261016", process.env.VIVIC_BASELINE ? "baseline" : "final", info.project.use.browserName ?? "chromium");
  await display.screenshot({ path: path.join(folder, "TEST-light-materials.png") });
  await page.getByRole("radio", { name: "深色", exact: true }).click();
  await expect(display.locator('[data-vivic-theme="dark"]')).toBeVisible();
  await display.screenshot({ path: path.join(folder, "TEST-dark-materials.png") });
  await display.setViewportSize({ width: 800, height: 600 });
  await controlDispatch(page, "TEST-narrow-fit", id, [{ type: "canvas.fit" }]);
  await expect.poll(() => display.locator(".vivic-card").evaluateAll(elements => elements.every(el => {
    const r = el.getBoundingClientRect(); return r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
  }))).toBe(true);
  await display.screenshot({ path: path.join(folder, "TEST-narrow-fixed.png") });
});

test("TEST restores a legacy canvas with current reading metrics, preserves two fixed coordinates and repairs automatic cards", async ({ page, context }, info) => {
  const pins = [
    { ...testCards.NoteCard, variant: "expanded", layout: { x: 0, y: 0, width: 300, height: 80, pinned: true }, displayProps: { text: "TEST 旧画布的固定便笺\n" + "中文内容恢复后按照新的行距阅读，固定坐标应保持原样。".repeat(4) } },
    { ...testCards.SearchResultCard, layout: { x: 420, y: 0, width: 360, height: 220, pinned: true } },
  ];
  const cards = [...pins, ...[0, 1, 2].map(i => ({ ...testCards.TodoCard, id: `TEST-legacy-auto-${i}`, layout: { x: 0, y: 0, width: 320, height: 80, pinned: false } }))];
  await page.goto("/display");
  await page.evaluate(async cards => {
    const dbPath = "/src/persistence/db.ts", recordsPath = "/src/persistence/canvasRecord.ts";
    const { openVivicDB } = await import(/* @vite-ignore */ dbPath);
    const { emptyVivicState, toCanvasRecord } = await import(/* @vite-ignore */ recordsPath);
    const db = await openVivicDB();
    await db.putCanvas(toCanvasRecord("TEST-legacy-canvas", "TEST 旧画布恢复", 4, { ...emptyVivicState(), cards: cards.map(record => ({ record })) }));
    await db.setMeta("lastCanvasId", "TEST-legacy-canvas"); db.close();
  }, cards);
  await page.goto("/control"); await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  await openPreferences(page, true);
  await page.getByRole("radio", { name: "浅色", exact: true }).click(); await page.getByRole("switch", { name: "减少动效" }).check();
  const display = await context.newPage(); await display.goto("/display?canvasId=TEST-legacy-canvas");
  await expect(display.locator(".vivic-card")).toHaveCount(5);
  const geometries = () => display.locator(".vivic-card").evaluateAll(elements => elements.map(el => {
    const r = el.getBoundingClientRect(); return { id: el.getAttribute("data-card-id"), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }));
  await expect.poll(async () => {
    const rects = await geometries(); return rects.flatMap((a, i) => rects.slice(i + 1).filter(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top));
  }).toEqual([]);
  const restored = await page.evaluate(() => window.__vivic!.getState().cards.map(entry => entry.record));
  for (const pin of pins) expect(restored.find(card => card.id === pin.id)!.layout).toEqual(pin.layout);
  await display.screenshot({ path: path.resolve(process.cwd(), "../../evidence/experience-20261016/final", info.project.use.browserName ?? "chromium", "TEST-legacy-fixed-restored.png") });
  await page.reload(); await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  expect(await page.evaluate(() => window.__vivic!.getState().cards.map(entry => entry.record))).toEqual(restored);
});
