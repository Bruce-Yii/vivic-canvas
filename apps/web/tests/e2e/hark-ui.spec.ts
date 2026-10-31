import { expect, test } from "@playwright/test";
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    if (["http:", "https:"].includes(location.protocol)) {
      localStorage.setItem("vivic.deviceLocation.v1", "off");
      localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", browserVoice: "" }));
    }
    HTMLMediaElement.prototype.play = async () => {};
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST disabled"); };
  });
});

test("Hark compact launcher retains source surfaces and opens the real chat without a draft", async ({ page }, info) => {
  let intentPosts = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/api\/intent/.test(request.url())) intentPosts++; });
  await page.route("**/api/decision/status", route => route.fulfill({ json: { phase: "cached", enabled: false, model: "TEST", mode: "managed", error: null } }));
  await page.goto("/launcher");
  await expect(page.getByRole("heading", { name: "本地服务", exact: true })).toBeVisible();
  await expect(page.locator("[data-vivic-control],[data-hark-task]")).toHaveCount(0);
  const panel = page.locator(".launcher-runtime").first();
  const shape = await panel.evaluate(node => {
    const style = getComputedStyle(node);
    return { radius: style.borderRadius, width: style.width, size: style.fontSize, line: style.lineHeight, family: style.fontFamily, corner: node.getAttribute("data-hark-corner"), clip: getComputedStyle(node.querySelector(".hark-surface-fill")!).clipPath };
  });
  expect(shape).toMatchObject({ radius: "24px", width: "512px", size: "15px", line: "19px", corner: "continuous" });
  expect(shape.family).toContain("GT Standard L");
  expect(shape.clip).toMatch(/^path\(/);
  expect(await page.locator(".aw,.tv-today,[data-today-source]").count()).toBe(0);
  await expect(panel.getByRole("button", { name: "启动模型", exact: true })).toBeEnabled();
  await expect(page.locator(".launcher-local-voice")).not.toHaveAttribute("open");
  await page.screenshot({ path: info.outputPath("hark-local-services.png") });
  await page.getByRole("link", { name: "打开 Vivic", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("[data-vivic-command-input]")).toBeVisible();
  await expect(page.locator("[data-vivic-command-input]")).toHaveValue("");
  expect(intentPosts).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem("vivic.pending-template.v1"))).toBeNull();
});

test("Hark launcher keeps controls reachable on a narrow screen", async ({ page }, info) => {
  await page.route("**/api/decision/status", route => route.fulfill({ json: { phase: "cached", enabled: false, model: "TEST", mode: "managed", error: null } }));
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/launcher");
  await expect(page.getByRole("link", { name: "打开 Vivic", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "启动模型", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "停止模型", exact: true })).toBeVisible();
  await expect(page.locator("[data-hark-task]")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("hark-launcher-narrow.png"), fullPage: true });
});

test("Hark confirmation retains source corners and focus, cancelling never clears model data", async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: "light" });
  let clearPosts = 0;
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/api/decision/clear")) clearPosts++; });
  await page.route("**/api/decision/status", route => route.fulfill({ json: { phase: "cached", enabled: false, model: "TEST", mode: "managed", error: null } }));
  await page.goto("/launcher");
  const trigger = page.getByRole("button", { name: "清理缓存", exact: true });
  await expect(trigger).toBeEnabled(); await trigger.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("清理本地模型文件？");
  await expect(dialog).toHaveAttribute("data-appearance", "light");
  await expect(dialog).toHaveAttribute("data-hark-corner", "continuous");
  await page.screenshot({ path: info.outputPath("hark-confirm-cancel.png") });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  expect(clearPosts).toBe(0);
});
