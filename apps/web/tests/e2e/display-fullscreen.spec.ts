import { expect, test } from "@playwright/test";

test("Vivic Space fills its window and hides browser controls after the fullscreen hint is clicked", async ({ page }) => {
  await page.goto("/display");
  const hint = page.locator("[data-vivic-fullscreen-hint]");
  await expect(hint).toBeVisible();
  expect(await page.locator("[data-vivic-stage]").evaluate(el => {
    const rect = el.getBoundingClientRect();
    return rect.x === 0 && rect.y === 0 && rect.width === innerWidth && rect.height === innerHeight;
  })).toBe(true);
  expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await page.screenshot({ path: "../../evidence/settings/display-fullscreen-hint.png" });
  await page.getByRole("button", { name: "点击隐藏顶部栏", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(true);
  await expect(hint).toHaveCount(0);
  await page.screenshot({ path: "../../evidence/settings/display-fullscreen-active.png" });
  await page.evaluate(() => document.exitFullscreen());
  await expect(hint).toBeVisible();
  await page.getByRole("button", { name: "关闭全屏提示", exact: true }).click();
  await expect(hint).toHaveCount(0);
});

test("a rejected fullscreen request does not falsely hide the hint or stop the canvas", async ({ page }) => {
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = async () => { throw new Error("TEST fullscreen blocked"); };
  });
  await page.goto("/display");
  await page.getByRole("button", { name: "点击隐藏顶部栏", exact: true }).click();
  await expect(page.locator("[data-vivic-fullscreen-error]")).toContainText("暂时无法隐藏顶部栏");
  await expect(page.locator("[data-vivic-stage]")).toBeVisible();
  expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
});
