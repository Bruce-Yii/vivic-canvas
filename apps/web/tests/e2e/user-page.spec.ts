import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { activeCanvasId, openPreferences, sendCommand, showChat, showSettings } from "./helpers1";

// TEST context only: local rules, no model, no microphone, no audio.
const evidence = path.resolve(process.cwd(), "../../evidence/user-page-20261017");
test.beforeEach(async ({ context }) => {
  // The dedicated local test API is shared across files; release a previous mock model login.
  await context.request.post("/api/credentials/stepfun/disconnect");
  await context.addInitScript(() => {
    HTMLMediaElement.prototype.play = async () => { throw new Error("TEST audio disabled"); };
    navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST microphone disabled"); };
  });
});
const root = (page: Page) => page.locator("[data-vivic-control]");
const atmosphere = (page: Page) => page.locator("[data-vivic-atmosphere]");

test("user page keeps useful controls and one composer; small settings leaves the chat mounted and inert", async ({ page }, info) => {
  await page.goto("/");
  await expect(root(page)).toHaveAttribute("data-vivic-owner", "owner");
  await expect(root(page)).toHaveAttribute("data-vivic-view", "chat");
  // No conversation, welcome bubble or card list: the rest of the page is background.
  await expect(page.locator("[data-vivic-chat-log], .vivic-bubble, [data-vivic-user-card]")).toHaveCount(0);
  await expect(page.locator("[data-vivic-command-feedback]")).toBeHidden();
  const settings = page.getByRole("button", { name: "设置", exact: true });
  await expect(page.getByRole("img", { name: "我的头像" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "管理 Vivic Space", exact: true })).toBeVisible();
  const viewport = page.viewportSize()!;
  const s = (await settings.boundingBox())!;
  expect(s.x).toBeLessThan(80); expect(s.y).toBeLessThan(80);
  const input = page.locator("[data-vivic-command-input]");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("placeholder", "给 Vivic 发消息");
  const bar = (await page.locator(".vivic-composer-bar").boundingBox())!;
  expect(bar.y + bar.height).toBeGreaterThan(viewport.height - 120);
  await expect(page.locator("[data-vivic-command-send]")).toBeHidden();
  for (const control of [page.getByRole("button", { name: "添加内容" }), page.locator("[data-vivic-ptt]")]) {
    const box = (await control.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(bar.y); expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height);
  }
  // Settings-only controls are not part of the user page.
  await expect(page.locator("[data-vivic-ai-connect]")).toBeHidden();
  await expect(page.locator("[data-vivic-canvas-list]")).toBeHidden();
  await page.screenshot({ path: path.join(evidence, info.project.name || "edge", "TEST-user-page.png") });

  await settings.click();
  await expect(page).toHaveURL(/\/control$/);
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await expect(page.locator("[data-vivic-ai-connect]")).toBeVisible();
  const panel = page.locator("dialog[data-vivic-settings]");
  expect(await panel.evaluate(node => node.matches(":modal"))).toBe(true);
  await expect(input).toBeVisible();
  await expect(page.locator("[data-vivic-ptt]")).toBeVisible();
  // Native modal inertness blocks focus in the still-mounted chat.
  await input.focus(); await expect(input).not.toBeFocused();
  await page.keyboard.press("Tab");
  expect(await panel.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await page.goBack();
  await expect(root(page)).toHaveAttribute("data-vivic-view", "chat");
  await expect(panel).toBeHidden();
  await expect(input).toBeVisible();
  await page.goForward();
  await expect(root(page)).toHaveAttribute("data-vivic-view", "settings");
  await page.locator("[data-vivic-open-chat]").click();
  await expect(page).toHaveURL(/\/$/);
});

test("the user page keeps no history: one status line per command, and drafts survive a trip to settings", async ({ page, context }) => {
  await page.goto("/");
  await expect(root(page)).toHaveAttribute("data-vivic-owner", "owner");
  const feedback = page.locator("[data-vivic-command-feedback]");
  const display = await context.newPage(); await display.goto(`/display?canvasId=${await activeCanvasId(page)}`);
  await sendCommand(page, "十分钟倒计时");
  await expect(feedback).toHaveText("10分倒计时已就位");
  await expect(display.locator(".vivic-card")).toHaveCount(1);
  await page.locator("[data-vivic-command-input]").fill("TEST 尚未发送的草稿");
  await showSettings(page);
  await expect(page.locator("dialog[data-vivic-settings]")).toBeVisible();
  await showChat(page);
  await page.getByRole("button", { name: "管理 Vivic Space", exact: true }).click();
  const space = page.getByRole("dialog", { name: "Vivic Space", exact: true });
  await space.getByRole("navigation", { name: "Space 管理", exact: true }).getByRole("button", { name: "提醒", exact: true }).click();
  await expect(space.locator("[data-vivic-reminder]")).toHaveCount(1);
  await expect(space.locator("[data-vivic-reminder]")).toBeVisible();
  await space.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await expect(space).toBeHidden();
  await showChat(page);
  await expect(page.locator("[data-vivic-command-input]")).toHaveValue("TEST 尚未发送的草稿");
  await sendCommand(page, "加待办：买菜");
  await expect(feedback).toHaveText("已记下 1 条待办");
  // Only the latest status is shown; earlier commands and replies are not kept.
  await expect(page.getByText("10分倒计时已就位")).toHaveCount(0);
  await expect(page.locator(".vivic-bubble")).toHaveCount(0);
  await expect(display.locator(".vivic-card")).toHaveCount(2);
  await display.close();
});

test("a numbered choice can be tapped or cancelled from the input area", async ({ page }) => {
  await page.goto("/");
  await expect(root(page)).toHaveAttribute("data-vivic-owner", "owner");
  const added = async (text: string) => { await sendCommand(page, text); await expect(page.locator("[data-vivic-command-feedback]")).toHaveText("已记下 1 条待办"); };
  await added("加待办：合同初审");
  await added("添加待办：周报大纲");
  await sendCommand(page, "删除那个卡片");
  const candidates = page.locator("[data-vivic-clarify-candidate]");
  await expect(candidates).toHaveCount(2);
  const question = (await page.locator("[data-vivic-command-feedback]").textContent())!;
  expect(question).toContain("请回复几号");
  await candidates.first().click();
  await expect(page.locator("[data-vivic-command-feedback]")).toContainText("可撤销");
  await expect(page.locator("[data-vivic-clarify]")).toHaveCount(0);
  await added("加待办：第三项");
  await sendCommand(page, "删除那个卡片");
  await expect(candidates).toHaveCount(2);
  await page.locator("[data-vivic-clarify]").getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText("已取消选择");
});

test("a palette choice changes the shared Hark sky tint on Display, user page and settings at once", async ({ page, context }, info) => {
  await page.goto("/control");
  await expect(root(page)).toHaveAttribute("data-vivic-owner", "owner");
  // Auto follows local time; select a fixed theme before checking the palette.
  await openPreferences(page);
  await page.getByRole("radio", { name: "深色", exact: true }).click();
  const display = await context.newPage(); await display.goto(`/display?canvasId=${await activeCanvasId(page)}`);
  const displayBackground = display.locator('[data-vivic-layer="background"]');
  // Default dark palette everywhere; source sky snapshots require no WebGL.
  await expect(atmosphere(page)).toHaveAttribute("data-vivic-atmosphere", "midnight");
  await expect(displayBackground).toHaveAttribute("data-vivic-atmosphere", "midnight");
  await expect(root(page)).toHaveAttribute("data-appearance", "dark");
  await expect(atmosphere(page).locator("canvas")).toHaveCount(0);
  await expect(displayBackground.locator("canvas")).toHaveCount(0);
  await expect(displayBackground.locator("[data-hark-sky=source-shader-frozen]")).toHaveCount(1);
  const settings = page.locator("[data-vivic-background-settings]");
  const backgroundOptions = settings.locator(":scope > details").first();
  await backgroundOptions.locator(":scope > summary").click();
  await expect(settings.locator("[data-vivic-palette]")).toHaveCount(12);
  await expect(backgroundOptions.locator(":scope > summary")).toContainText("背景");
  await expect(settings.locator('[data-vivic-palette="midnight"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/云雾光晕|丝绸柔光|漫游烟雾|晨曦极光|柔粒渐变/)).toHaveCount(0);

  await settings.locator('[data-vivic-palette="peach"]').click();
  await expect(atmosphere(page)).toHaveAttribute("data-vivic-atmosphere", "peach");
  await expect(root(page)).toHaveAttribute("data-appearance", "light");
  await expect(displayBackground).toHaveAttribute("data-vivic-atmosphere", "peach");
  await expect(display.locator("[data-vivic-stage]")).toHaveAttribute("data-vivic-theme", "light");
  await expect(settings.locator('[data-vivic-palette="peach"]')).toHaveAttribute("aria-pressed", "true");
  await expect(settings.locator('[data-vivic-palette="peach"]')).toHaveAttribute("data-vivic-palette-shown", "true");
  await expect(backgroundOptions.locator(":scope > summary")).toContainText("奶油蜜桃");
  await settings.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidence, info.project.name || "edge", "TEST-settings-peach.png") });

  await settings.locator('[data-vivic-palette="ocean"]').click();
  await expect(displayBackground).toHaveAttribute("data-vivic-atmosphere", "ocean");
  await showChat(page);
  await expect(atmosphere(page)).toHaveAttribute("data-vivic-atmosphere", "ocean");
  await expect(root(page)).toHaveAttribute("data-appearance", "dark");
  await display.reload();
  await expect(display.locator('[data-vivic-layer="background"]')).toHaveAttribute("data-vivic-atmosphere", "ocean");
  await page.reload();
  await expect(atmosphere(page)).toHaveAttribute("data-vivic-atmosphere", "ocean");
  await display.close();
});
