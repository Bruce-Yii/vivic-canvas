import { expect, test } from "@playwright/test";
import { activeCanvasId, openPreferences, showChat, showSettings } from "./helpers1";

// Isolated browser storage; no model requests, microphone capture or playback.
test.beforeEach(async ({ page }) => {
  await page.route("https://huggingface.co/**", route => route.abort("blockedbyclient"));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", { value: {
      getUserMedia: () => Promise.reject(new DOMException("TEST microphone disabled", "NotAllowedError")),
      enumerateDevices: () => Promise.resolve([]), addEventListener() {}, removeEventListener() {},
    }, configurable: true });
  });
});

test("TEST small settings panel keeps owner, chat draft and mounted configuration", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  const canvas = await activeCanvasId(page);
  await page.locator("[data-vivic-command-input]").fill("TEST 尚未发送的想法");
  await showSettings(page);
  await expect(page.locator("[data-vivic-ai-section]")).toHaveCount(1);
  await expect(page.locator(".se-nav [data-settings-nav]")).toHaveCount(3);
  for (const id of ["connections", "preferences", "data"]) {
    const nav = page.locator('[data-settings-nav="' + id + '"]');
    await nav.focus(); await page.keyboard.press("Enter");
    await expect(nav).toHaveAttribute("aria-current", "page");
    await expect(page.locator('[data-settings-group="' + id + '"]')).toBeVisible();
    await expect(page.locator(".se-group:visible")).toHaveCount(1);
  }
  await expect(page.locator("[data-vivic-ai-section]")).toBeHidden();
  await page.locator('[data-settings-nav="connections"]').click();
  const local = page.locator('[data-settings-extra="local"]');
  await expect(local).not.toHaveAttribute("open", "");
  await local.locator("summary").click();
  await expect(page.locator("[data-settings-launcher]")).toBeVisible();
  await expect(page.locator("[data-settings-launcher]")).toHaveAttribute("target", "_blank");
  await local.locator("summary").click();
  await expect(page.locator("[data-settings-launcher]")).toBeHidden();
  await showChat(page);
  await expect(page.locator("[data-vivic-command-input]")).toHaveValue("TEST 尚未发送的想法");
  expect(await activeCanvasId(page)).toBe(canvas);
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  await showSettings(page);
  await expect(page.locator("[data-vivic-ai-section]")).toHaveCount(1);
  await expect(local).not.toHaveAttribute("open", "");
  expect(errors).toEqual([]);
});

for (const appearance of ["dark", "light"] as const) {
  test("TEST settings panel " + appearance + " and narrow navigation", async ({ page }, info) => {
    await page.goto("/control");
    await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
    await openPreferences(page);
    await page.getByRole("radio", { name: appearance === "dark" ? "深色" : "浅色", exact: true }).click();
    await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-appearance", appearance);
    await page.screenshot({ path: info.outputPath("settings-" + appearance + "-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const id of ["connections", "preferences", "data"]) {
      await page.locator('[data-settings-nav="' + id + '"]').click();
      await expect(page.locator('[data-settings-group="' + id + '"]')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator("[data-settings-scroll]").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect((await page.locator(".se-topbar").boundingBox())!.y).toBeGreaterThanOrEqual(0);
    }
    await openPreferences(page);
    await expect(page.getByRole("switch", { name: "语音回复", exact: true })).not.toBeChecked();
    await page.screenshot({ path: info.outputPath("settings-" + appearance + "-narrow.png") });
    await page.locator('[data-settings-nav="connections"]').click();
    await page.locator('[data-settings-extra="mobile"] > summary').click();
    await expect(page.locator("[data-vivic-mobile-control]")).toContainText("先在电脑连接模型");
    await expect(page.locator("[data-vivic-mobile-control]")).toContainText("查看当前画布的卡片内容");
  });
}
