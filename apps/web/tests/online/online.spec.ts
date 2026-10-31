import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { microphoneCalls: number }).microphoneCalls = 0;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
      (window as unknown as { microphoneCalls: number }).microphoneCalls++;
      throw new Error("Microphone disabled in automated verification");
    };
  });
});

test("online cookie bootstrap, guide, verified connection UI and first real basic card", async ({ page, context }, info) => {
  // UI validation responses are simulated. Production server session creation and
  // the basic card/owner/display/persistence below are real; no live provider key.
  let connected = false, intents = 0;
  await page.route("**/api/providers/status", route => route.fulfill({ json: { activeProvider: "stepfun", instance: "ui-fixture",
    providers: [{ name: "stepfun", connected, models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", capabilities: ["chat", "structured"] }], degradations: [] } }));
  await page.route("**/api/credentials/stepfun/validate", async route => {
    connected = route.request().postDataJSON().apiKey === "sk-online-ui-fixture";
    await route.fulfill({ json: { ok: connected, connected, ...(connected ? {} : { error: "测试连接失败，请重试" }) } });
  });
  page.on("request", request => { if (/\/api\/intent(?:\/stream)?$/.test(request.url())) intents++; });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "聊天与 Space" })).toBeVisible();
  const cookies = await context.cookies();
  expect(cookies.some(cookie => cookie.name === "__Host-vivic_online" && cookie.httpOnly && cookie.secure && cookie.sameSite === "Strict")).toBe(true);
  await expect(page.locator("[data-vivic-control]")).toHaveCount(0);
  await page.getByRole("button", { name: "查看示例" }).click();
  await expect(page.getByLabel("示例卡片")).toBeVisible();
  await page.screenshot({ path: info.outputPath("01-desktop-guide.png"), fullPage: true });
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByLabel("StepFun API Key").fill("sk-rejected-ui-fixture");
  await page.getByRole("button", { name: "验证并连接" }).click();
  await expect(page.getByRole("alert")).toContainText("连接验证未通过");
  await expect(page.getByLabel("StepFun API Key")).toHaveValue("");
  await page.getByLabel("StepFun API Key").fill("sk-online-ui-fixture");
  await page.getByRole("button", { name: "验证并连接" }).click();
  await expect(page.locator(".vo-connected")).toContainText("StepFun");
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("sk-online-ui-fixture");
  await page.screenshot({ path: info.outputPath("02-connected.png"), fullPage: true });
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "开始聊天" }).click();
  await expect(page.getByLabel("指令输入")).toHaveValue("创建一个便笺，内容是：今天完成一件要事，留出休息时间。");
  expect(intents).toBe(0);
  await page.getByLabel("指令输入").fill("新建便笺：线上引导验收");
  await page.getByLabel("指令输入").press("Enter");
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "展示窗口", exact: true }).click();
  const display = await popup;
  await expect(display.getByText("线上引导验收", { exact: true })).toBeVisible();
  await display.screenshot({ path: info.outputPath("03-real-space.png"), fullPage: true });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.locator(".se-nav [data-settings-nav]")).toHaveCount(3);
  await expect(page.getByText("高级：本地能力", { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-vivic-settings]")).not.toContainText("Pi 登录");
  const draft = page.getByLabel("StepFun API Key");
  connected = false;
  await expect(draft).toBeEnabled();
  await draft.fill("unsubmitted-settings-draft");
  await page.locator('[data-settings-nav="data"]').click();
  await page.getByRole("button", { name: "重新查看新手引导", exact: true }).click();
  await expect(page.getByRole("heading", { name: "聊天与 Space" })).toBeVisible();
  await page.getByRole("button", { name: "关闭新手引导" }).click();
  await page.locator('[data-settings-nav="connections"]').click();
  await expect(draft).toHaveValue("unsubmitted-settings-draft");
  await page.locator('[data-settings-nav="preferences"]').click();
  await page.getByRole("radio", { name: "深色", exact: true }).click();
  await page.locator('[data-settings-nav="data"]').click();
  await page.getByRole("button", { name: "重新查看新手引导", exact: true }).click();
  await expect(page.locator("[data-vivic-online-onboarding]")).toHaveAttribute("data-appearance", "dark");
  await page.screenshot({ path: info.outputPath("04-dark-guide.png"), fullPage: true });
  expect(await page.evaluate(() => (window as unknown as { microphoneCalls: number }).microphoneCalls)).toBe(0);
  await display.close();
});

test("390px basic experience and reduced motion do not require a download or key", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "聊天与 Space" })).toBeVisible();
  await page.getByRole("button", { name: "查看示例" }).click();
  await page.screenshot({ path: info.outputPath("05-narrow-guide.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByRole("button", { name: "先体验基础功能" }).click();
  await expect(page.locator(".vo-description")).toContainText("内置文字指令");
  await page.getByRole("button", { name: "开始聊天" }).click();
  await expect(page.getByLabel("指令输入")).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const top = await page.locator(".se-topbar").boundingBox();
  const nav = await page.locator(".se-nav").boundingBox();
  expect(top && nav && nav.y >= top.y + top.height - 1).toBeTruthy();
  await expect(page.getByRole("button", { name: "关闭设置" })).toBeVisible();
  await expect(page.locator("[data-vivic-available-cards]")).toHaveCount(0);
  await expect(page.locator("[data-vivic-store-link]")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("06-narrow-settings.png"), fullPage: true });
  expect(await page.evaluate(() => (window as unknown as { microphoneCalls: number }).microphoneCalls)).toBe(0);
});

test("failed bootstrap cannot show a connection form and can be retried", async ({ page }) => {
  let fail = true;
  await page.route("**/api/online/session", route => fail ? route.fulfill({ status: 503, json: { ok: false } }) : route.continue());
  await page.goto("/");
  await expect(page.getByRole("button", { name: "重新连接", exact: true })).toBeVisible();
  await expect(page.getByLabel("StepFun API Key")).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page.getByRole("heading", { name: "聊天与 Space" })).toBeVisible();
});
