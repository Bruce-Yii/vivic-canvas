import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { activeCanvasId, controlDispatch, gotoDisplay, openData, openPreferences, openSpace, showChat, todoCardRecord } from "./helpers1";

// Keep normal browser background throttling for this lifecycle probe. All
// inputs are isolated fixtures; no microphone, model request or real audio.
test.use({ launchOptions: { args: ["--mute-audio"], ignoreDefaultArgs: [
  "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
] } });
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("vivic.deviceLocation.v1", "off");
    localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", browserVoice: "" }));
    HTMLMediaElement.prototype.play = async () => { throw new Error("TEST no audio"); };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST no capture"); };
  });
});

test("existing cards measure in a real display popup and resync after a frozen background lifecycle", async ({ page, context }, info) => {
  await page.goto("/");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  const canvasId = await activeCanvasId(page);
  await controlDispatch(page, "popup-before-open", canvasId, [{ type: "card.create", card: todoCardRecord("TEST-popup-existing", ["打开前已经保存的进度"]) }]);
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("button", { name: "展示窗口", exact: true }).click();
  const display = await popupPromise;
  await display.bringToFront();
  await expect(display.locator('[data-card-id="TEST-popup-existing"]')).toBeVisible();
  await expect(display.locator(".react-flow__node")).toHaveCSS("visibility", "visible");
  await display.screenshot({ path: info.outputPath("popup-measured.png") });

  const lifecycle = await context.newCDPSession(display);
  await lifecycle.send("Page.setWebLifecycleState", { state: "frozen" });
  await page.bringToFront();
  await controlDispatch(page, "popup-frozen-update", canvasId, [{ type: "card.create", card: todoCardRecord("TEST-popup-new", ["休眠期间新增的卡片"]) }]);
  await lifecycle.send("Page.setWebLifecycleState", { state: "active" });
  await display.bringToFront();
  await expect(display.locator("[data-card-id]")).toHaveCount(2);
  await expect(display.locator('[data-card-id="TEST-popup-new"]')).toBeVisible();
  await display.reload();
  await expect(display.locator("[data-card-id]")).toHaveCount(2);
  await display.screenshot({ path: info.outputPath("popup-resumed-and-reloaded.png") });
  await lifecycle.detach();
});

test("all four orb colors synchronize, persist, and stop mesh motion when reduced motion is selected", async ({ page, context }, info) => {
  await page.goto("/");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  const display = await gotoDisplay(context, await activeCanvasId(page));
  await openPreferences(page, true);
  await page.locator("[data-vivic-orb-settings] > summary").click();
  const colors = new Set<string>();
  const initial = await display.locator(".siri-orb").evaluate(el => getComputedStyle(el).getPropertyValue("--c1"));
  const expected: Record<string, string> = { aurora: initial, sky: "#7b9de3", mint: "#71c4af", peach: "#e8a088" };
  for (const id of ["aurora", "sky", "mint", "peach"]) {
    await page.locator(`[data-vivic-orb-palette="${id}"]`).click();
    await expect(page.locator(`[data-vivic-orb-palette="${id}"]`)).toHaveAttribute("aria-pressed", "true");
    const controlColor = expected[id];
    await expect.poll(() => display.locator(".siri-orb").evaluate(el => getComputedStyle(el).getPropertyValue("--c1"))).toBe(controlColor);
    colors.add(controlColor);
  }
  expect(colors.size).toBe(4);
  await page.getByRole("switch", { name: "减少动效", exact: true }).check();
  await expect.poll(() => display.locator(".siri-orb").evaluate(el => getComputedStyle(el, "::before").animationName)).toBe("none");
  await display.reload();
  await expect.poll(() => display.locator(".siri-orb").evaluate(el => getComputedStyle(el).getPropertyValue("--c1"))).toBe("#e8a088");
  await showChat(page); await page.reload(); await openPreferences(page);
  await expect(page.locator('[data-vivic-orb-palette="peach"]')).toHaveAttribute("aria-pressed", "true");
  await display.screenshot({ path: info.outputPath("peach-orb-reduced-motion.png") });
});

test("exported browser backup imports into a new canvas, survives reload, and rejects malformed input without data loss", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  const originalId = await activeCanvasId(page);
  await controlDispatch(page, "backup-seed", originalId, [{ type: "card.create", card: todoCardRecord("TEST-backup", ["备份完整正文", "下一步进度"]) }]);
  await openData(page);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出备份", exact: true }).click();
  const download = await downloadPromise;
  const backupPath = info.outputPath("canvas-backup.json");
  await download.saveAs(backupPath);
  const contents = await readFile(backupPath, "utf8");
  expect(contents).toContain("备份完整正文");
  expect(contents).not.toMatch(/apiKey|access_token|refresh_token/i);
  await page.locator("[data-vivic-import-input]").setInputFiles(backupPath);
  await expect(page.locator("[data-vivic-data-feedback]")).toContainText("已导入并切换到新画布");
  const importedId = await activeCanvasId(page);
  expect(importedId).not.toBe(originalId);
  expect(await page.evaluate(() => window.__vivic!.getState().cards[0].record.displayProps)).toEqual({ items: [
    { id: "TEST-backup-i1", text: "备份完整正文", done: false }, { id: "TEST-backup-i2", text: "下一步进度", done: false },
  ] });
  await page.reload();
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  expect(await activeCanvasId(page)).toBe(importedId);
  await openData(page);
  await page.locator("[data-vivic-import-input]").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from("{bad") });
  await expect(page.locator("[data-vivic-data-feedback]")).toContainText("JSON");
  expect(await activeCanvasId(page)).toBe(importedId);
  expect(await page.evaluate(() => window.__vivic!.getState().cards.length)).toBe(1);
  await openSpace(page); await expect(page.locator("[data-vivic-canvas-list] li")).toHaveCount(2);
  await page.screenshot({ path: info.outputPath("backup-restored-space.png") });
});
