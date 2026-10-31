import { expect, test, type Page } from "@playwright/test";
import { activeCanvasId, controlDispatch, gotoControl, gotoDisplay, openPreferences, sendCommand, showChat, todoCardRecord } from "./helpers1";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("vivic.deviceLocation.v1", "off");
    localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", browserVoice: "" }));
  });
});
const focusId = (page: Page) => page.evaluate(() => (window.__vivic!.getState() as { focus: { cardId: string } | null }).focus?.cardId ?? null);
const closePortal = (page: Page) => page.getByRole("dialog", { name: "卡片传送门" }).getByRole("button", { name: "关闭窗口" }).click();

test("travel card teleports between tabs, edits and refreshes, then survives a display reload", async ({ context }, info) => {
  const control = await gotoControl(context), canvasId = await activeCanvasId(control);
  const display = await gotoDisplay(context, canvasId);
  await sendCommand(control, "下周去杭州住两晚，预算500");
  await expect(display.locator('[data-card-id][data-scene-type="TravelOffersCard"]')).toBeVisible();
  await display.getByRole("button", { name: "卡片传送门", exact: false }).click();
  const dialog = display.getByRole("dialog", { name: "卡片传送门" });
  await dialog.getByRole("button", { name: "传送到用户页：杭州旅游结果", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("已传送到用户页");
  await expect(display.locator('[data-card-id][data-scene-type="TravelOffersCard"]')).toHaveCount(0);
  await expect(control.locator('[data-vivic-user-card][data-scene-type="TravelOffersCard"]')).toBeVisible();
  await closePortal(display);
  const card = control.locator('[data-vivic-user-card][data-scene-type="TravelOffersCard"]');
  await card.getByRole("textbox", { name: "旅游备注" }).fill("体验备注：希望安静，保留这个选择");
  await card.getByRole("button", { name: "选择", exact: true }).click();
  await card.getByRole("button", { name: "刷新结果", exact: true }).click();
  await expect(card.getByRole("textbox", { name: "旅游备注" })).toHaveValue("体验备注：希望安静，保留这个选择");
  await expect(card.getByRole("button", { name: "已选择", exact: true })).toBeVisible();
  await expect(control.locator('[data-vivic-user-notice]')).toContainText("已刷新旅游结果");
  await control.screenshot({ path: info.outputPath("portal-user-edit.png") });
  await card.getByRole("button", { name: "把「杭州旅游结果」放回副屏", exact: true }).click();
  await expect(display.locator('[data-card-id][data-scene-type="TravelOffersCard"]')).toContainText("体验备注");
  await display.reload();
  await expect(display.locator('[data-card-id][data-scene-type="TravelOffersCard"]')).toContainText("体验备注");
});

test("visible focus, restore and fit controls sync between tabs and disable without an owner", async ({ context }, info) => {
  const control = await gotoControl(context), canvasId = await activeCanvasId(control);
  const display = await gotoDisplay(context, canvasId);
  const pinned = todoCardRecord("portal-fixed", ["固定位置保留"]);
  await openPreferences(control, true);
  await control.getByRole("switch", { name: "减少动效", exact: true }).click();
  pinned.layout = { ...pinned.layout, x: -100, y: -100, pinned: true };
  await controlDispatch(control, "portal-view-seed", canvasId, [{ type: "stage.awaken" },
    { type: "card.create", card: pinned }, { type: "card.create", card: todoCardRecord("portal-view", ["聚焦与恢复"]) }]);
  await showChat(control);
  const target = display.locator('[data-card-id="portal-view"]');
  await expect(target).toBeVisible();
  const beforeFocus = await display.locator(".react-flow__viewport").getAttribute("style");
  await target.hover();
  await target.getByRole("button", { name: "聚焦：聚焦与恢复", exact: true }).click();
  await expect.poll(() => focusId(control)).toBe("portal-view");
  await expect(target).toHaveAttribute("data-focused", "true");
  await display.getByRole("button", { name: "恢复视图", exact: true }).click();
  await expect.poll(() => focusId(control)).toBeNull();
  await expect(display.locator(".react-flow__viewport")).toHaveAttribute("style", beforeFocus!);
  await control.getByRole("button", { name: "卡片传送门", exact: false }).click();
  await control.locator('[data-vivic-portal-card="portal-fixed"]').getByRole("button", { name: "聚焦：固定位置保留", exact: true }).click();
  await expect.poll(() => focusId(display)).toBe("portal-fixed");
  await control.getByRole("button", { name: "卡片传送门", exact: true }).click();
  await control.getByRole("button", { name: "显示全部", exact: true }).click();
  await expect.poll(() => focusId(display)).toBeNull();
  const fixedLayout = await control.evaluate(() => (window.__vivic!.getState() as { cards: Array<{ record: { id: string; layout: object } }> }).cards.find(entry => entry.record.id === "portal-fixed")!.record.layout);
  expect(fixedLayout).toMatchObject({ x: -100, y: -100, pinned: true });
  await expect.poll(() => display.locator("[data-card-id]").evaluateAll(nodes => nodes.every(node => {
    const rect = node.getBoundingClientRect();
    return rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
  }))).toBe(true);
  await display.screenshot({ path: info.outputPath("portal-display-controls.png") });
  await control.close();
  await expect(display.getByRole("button", { name: "显示全部", exact: true })).toBeDisabled();
  await display.getByRole("button", { name: "卡片传送门", exact: false }).click();
  await expect(display.getByRole("dialog").getByRole("button", { name: "传送到用户页：聚焦与恢复", exact: true })).toBeDisabled();
});

test("a same-tab drag into the portal transfers the card and a click brings it back", async ({ context }, info) => {
  const control = await gotoControl(context), canvasId = await activeCanvasId(control);
  const display = await gotoDisplay(context, canvasId);
  await openPreferences(control);
  await control.getByRole("radio", { name: "深色", exact: true }).click();
  await controlDispatch(control, "portal-drag-seed", canvasId, [{ type: "stage.awaken" }, { type: "card.create", card: todoCardRecord("portal-drag", ["拖入传送门"]) }]);
  await showChat(control);
  await expect(display.locator('[data-vivic-move-handle="portal-drag"]')).toBeVisible();
  await display.locator('[data-vivic-move-handle="portal-drag"]').dragTo(display.locator('[data-vivic-portal="display"]'));
  await expect(control.locator('[data-vivic-user-card="portal-drag"]')).toBeVisible();
  await expect(display.locator('[data-card-id="portal-drag"]')).toHaveCount(0);
  await control.getByRole("button", { name: "卡片传送门", exact: false }).click();
  await control.locator('[data-vivic-portal-card="portal-drag"]').getByRole("button", { name: "传送到展示页：拖入传送门", exact: true }).click();
  await expect(control.getByRole("dialog").getByRole("status")).toContainText("已传送到展示页");
  await expect(display.locator('[data-card-id="portal-drag"]')).toBeVisible();
  await closePortal(control);
  await display.getByRole("button", { name: "卡片传送门", exact: false }).click();
  await expect(display.getByRole("dialog", { name: "卡片传送门" })).toHaveClass(/dark/);
  await display.screenshot({ path: info.outputPath("portal-card-list.png") });
  await display.setViewportSize({ width: 390, height: 844 });
  const box = await display.getByRole("dialog", { name: "卡片传送门" }).boundingBox();
  expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await expect(display.getByRole("dialog").getByRole("button", { name: "传送到用户页：拖入传送门", exact: true })).toBeVisible();
  await display.screenshot({ path: info.outputPath("portal-card-list-mobile.png") });
});

test("Hark card corners keep layout dimensions and focus tools work at half and enlarged canvas zoom", async ({ context }, info) => {
  const control = await gotoControl(context), canvasId = await activeCanvasId(control);
  const display = await gotoDisplay(context, canvasId);
  await openPreferences(control, true);
  await control.getByRole("switch", { name: "减少动效", exact: true }).click();
  await controlDispatch(control, "hark-zoom-seed", canvasId, [{ type: "stage.awaken" },
    { type: "card.create", card: todoCardRecord("hark-zoom", ["缩放时卡片和操作保持完整"]) }]);
  await showChat(control);
  const card = display.locator('[data-card-id="hark-zoom"]');
  await expect(card).toBeVisible();
  await display.evaluate(() => document.fonts.ready);
  await expect(card).toHaveAttribute("data-hark-corner", "continuous");
  const geometry = () => card.evaluate(element => ({
    width: element.offsetWidth, height: element.offsetHeight,
    renderedWidth: element.getBoundingClientRect().width,
    clip: (element.querySelector(":scope > .hark-surface-fill") as HTMLElement).style.clipPath,
  }));
  const original = await geometry();
  expect(original.clip).toContain("path(");
  const viewport = display.locator(".react-flow__viewport");
  const readZoom = () => viewport.evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
  for (const zoom of [0.5, 1.4]) {
    await display.mouse.move(1000, 250);
    // Drive real wheel input. Chromium's device-scale normalization can alter
    // the delivered delta, so calibrate its observed exponent before correcting.
    let exponent = -0.002;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await viewport.evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
      if (Math.abs(current - zoom) < 0.000001) break;
      const delta = Math.log2(zoom / current) / exponent;
      await display.mouse.wheel(0, delta);
      await expect.poll(readZoom).not.toBe(current);
      await expect.poll(() => display.locator(".react-flow__renderer").evaluate(element => !("__zooming" in element))).toBe(true);
      exponent = Math.log2(await readZoom() / current) / delta;
    }
    await expect.poll(readZoom).toBeCloseTo(zoom, 4);
    const scaled = await geometry();
    expect(scaled.width).toBe(original.width);
    expect(scaled.height).toBe(original.height);
    expect(scaled.clip).toBe(original.clip);
    expect(scaled.renderedWidth / scaled.width).toBeCloseTo(zoom, 4);
    const beforeFocus = await viewport.getAttribute("style");
    await card.hover();
    await card.getByRole("button", { name: "聚焦：缩放时卡片和操作保持完整", exact: true }).click();
    await expect(card).toHaveAttribute("data-focused", "true");
    await display.getByRole("button", { name: "恢复视图", exact: true }).click();
    await expect.poll(() => focusId(display)).toBeNull();
    await expect(viewport).toHaveAttribute("style", beforeFocus!);
    await display.screenshot({ path: info.outputPath(`hark-zoom-${zoom}.png`) });
  }
});
