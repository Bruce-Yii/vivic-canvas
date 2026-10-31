import { expect, test, type Page } from "@playwright/test";

// Provider replies below are UI fixtures. Sessions, owner, drafts and card actions
// run against the real production online entry. No model, microphone or playback.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { microphoneCalls: number }).microphoneCalls = 0;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
      (window as unknown as { microphoneCalls: number }).microphoneCalls++;
      throw new Error("TEST microphone disabled");
    };
  });
});
async function enter(page: Page, connected = false) {
  await page.route("**/api/providers/status", route => route.fulfill({ json: {
    activeProvider: "stepfun", instance: "settings-test",
    providers: [{ name: "stepfun", connected, defaultModel: "step-3.5-flash", models: ["step-3.5-flash", "step-3.7-flash"], capabilities: [] }], degradations: [],
  } }));
  await page.goto("/");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  if (connected) await page.getByRole("button", { name: "继续", exact: true }).click();
  else await page.getByRole("button", { name: "先体验基础功能" }).click();
  await page.getByRole("button", { name: "开始聊天" }).click();
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
}
const panel = (page: Page) => page.locator("dialog[data-vivic-settings]");
const tab = (page: Page, id: string) => page.locator('[data-settings-nav="' + id + '"]');

test("small panel retains drafts, traps focus, closes by Escape and backdrop", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await enter(page);
  const owner = page.locator("[data-vivic-control]");
  const canvas = await owner.getAttribute("data-vivic-active-canvas");
  await page.getByLabel("指令输入").fill("尚未发送的想法");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(panel(page)).toBeVisible();
  expect(await panel(page).evaluate(node => node.matches(":modal"))).toBe(true);
  await expect(page.locator("[data-vivic-chat]")).toBeVisible();
  const box = await panel(page).boundingBox();
  expect(box!.width).toBeLessThanOrEqual(480); expect(box!.height).toBeLessThan(650);
  await page.getByLabel("StepFun API Key").fill("TEST unsubmitted draft");
  await page.screenshot({ path: info.outputPath("01-connection-panel.png") });
  await tab(page, "preferences").click();
  await expect(page.getByRole("switch", { name: "语音回复", exact: true })).not.toBeChecked();
  await expect(page.getByRole("combobox", { name: "语音输入服务" })).toHaveCount(0);
  await expect(page.locator("[data-vivic-voice-options]")).not.toHaveAttribute("open", "");
  await page.screenshot({ path: info.outputPath("02-preferences-panel.png") });
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    expect(await panel(page).evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(panel(page)).not.toBeVisible();
  await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();
  await expect(page.getByLabel("指令输入")).toHaveValue("尚未发送的想法");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await tab(page, "connections").click();
  await expect(page.getByLabel("StepFun API Key")).toHaveValue("TEST unsubmitted draft");
  await page.mouse.click(10, 10);
  await expect(panel(page)).not.toBeVisible();
  await expect(owner).toHaveAttribute("data-vivic-active-canvas", canvas!);
  expect(await page.evaluate(() => (window as unknown as { microphoneCalls: number }).microphoneCalls)).toBe(0);
  expect(errors).toEqual([]);
});

test("nested menus and destructive confirmation remain inside the panel", async ({ page }, info) => {
  await enter(page, true);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByLabel("StepFun API Key")).toHaveCount(0);
  await expect(page.locator("[data-vivic-ai-badge]")).toHaveText("已连接");
  await page.locator("[data-vivic-connection-options] > summary").click();
  await page.getByRole("combobox", { name: "当前推理模型" }).click();
  await expect(page.getByRole("option", { name: "step-3.7-flash" })).toBeVisible();
  expect(await page.getByRole("listbox").evaluate(node => Boolean(node.closest("dialog[open]")))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeVisible();
  await tab(page, "data").click();
  await page.locator(".se-data-danger > summary").click();
  await page.getByRole("button", { name: "清除全部本地数据", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  expect(await page.getByRole("alertdialog").evaluate(node => Boolean(node.closest("dialog[open]")))).toBe(true);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await page.screenshot({ path: info.outputPath("03-data-panel.png") });
  await tab(page, "preferences").click();
  await page.getByRole("radio", { name: "深色", exact: true }).click();
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-appearance", "dark");
  // Chromium serializes the source .618 alpha to .62 in computed styles.
  await expect(panel(page).locator(".se-shell > .hark-surface-fill")).toHaveCSS("background-color", "rgba(29, 29, 31, 0.62)");
  await panel(page).evaluate(node => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));
  await page.screenshot({ path: info.outputPath("04-dark-panel.png") });
});

test("Space owns card operations and the narrow panel stays within the viewport", async ({ page }, info) => {
  await enter(page);
  await page.getByLabel("指令输入").fill("新建便笺：小面板验收");
  await page.getByLabel("指令输入").press("Enter");
  await page.getByRole("button", { name: "管理 Vivic Space" }).click();
  const space = page.locator("[data-vivic-space-management]");
  await expect(space).toBeVisible();
  await page.getByRole("navigation", { name: "Space 管理" }).getByRole("button", { name: "卡片", exact: true }).click();
  await expect(space.locator("[data-vivic-pin]")).toHaveCount(1);
  await space.locator("[data-vivic-pin]").click();
  await expect(space.locator("[data-vivic-pin]")).toHaveAttribute("aria-pressed", "true");
  await expect(space.getByRole("button", { name: "重新排布", exact: true })).toBeVisible();
  await space.locator("summary").getByText("添加和管理卡片包").click();
  await expect(space.getByRole("button", { name: /导入.*卡片/ })).toBeVisible();
  await space.getByRole("button", { name: "关闭窗口" }).click();
  await page.getByRole("button", { name: "快速找卡", exact: true }).click();
  await expect(page.locator("[data-vivic-quick-find]")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await tab(page, "preferences").click();
  const box = await panel(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  expect(await panel(page).locator("[data-settings-scroll]").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("05-narrow-panel.png") });
  await tab(page, "data").click();
  await page.getByRole("button", { name: "重新查看新手引导" }).click();
  await expect(panel(page)).not.toBeVisible();
  await page.getByRole("button", { name: "关闭新手引导" }).click();
  await expect(panel(page)).toBeVisible();
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.getByRole("button", { name: "管理 Vivic Space" }).click();
  await page.getByRole("navigation", { name: "Space 管理" }).getByRole("button", { name: "卡片", exact: true }).click();
  await expect(space.locator("[data-vivic-pin]")).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => (window as unknown as { microphoneCalls: number }).microphoneCalls)).toBe(0);
});
