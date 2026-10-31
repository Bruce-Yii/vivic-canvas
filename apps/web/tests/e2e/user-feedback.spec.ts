import { expect, test } from "@playwright/test";
import { activeCanvasId, sendCommand as submit, openSpace, openPreferences, openNotifications } from "./helpers1";
async function sendCommand(page: import("@playwright/test").Page, text: string) {
  await submit(page, text);
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveAttribute("aria-busy", "false");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/control");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
});

test("a failed schedule question cannot swallow weekly, conditional or countdown commands", async ({ page }) => {
  await sendCommand(page, "每天25:00提醒我休息");
  await expect(page.locator("[data-vivic-command-feedback]")).toContainText("请写明时间");
  await sendCommand(page, "每周一、三、五下午3点提醒我休息");
  await openSpace(page, "提醒");
  await expect(page.locator("[data-vivic-reminder]")).toHaveCount(1);
  await sendCommand(page, "添加待办：完成测试");
  await sendCommand(page, "当待办第1项完成后5秒提醒我检查");
  await openSpace(page, "提醒");
  await expect(page.locator("[data-vivic-reminder]")).toHaveCount(2);
  await sendCommand(page, "一分钟倒计时");
  await openSpace(page, "提醒");
  await expect(page.locator("[data-vivic-reminder]")).toHaveCount(3);
});

test("far plans stay in Control, pure timers and recurring reminders have separate presentation", async ({ page, context }) => {
  const display = await context.newPage(); await display.goto(`/display?canvasId=${await activeCanvasId(page)}`);
  await sendCommand(page, "两小时后提醒我检查报告");
  await openSpace(page, "提醒");
  await expect(page.locator("[data-vivic-reminder]")).toHaveCount(1);
  await expect(display.locator("[data-card-id]")).toHaveCount(0);
  await sendCommand(page, "十分钟倒计时");
  await sendCommand(page, "八分钟后提醒我喝水");
  await sendCommand(page, "每隔30分钟提醒我休息");
  await expect(display.locator("[data-card-id]")).toHaveCount(3);
  await expect(display.locator(".vivic-countdown")).toHaveCount(1);
  await expect(display.locator("[data-vivic-reminder-list]")).toHaveCount(2);
  await expect(display.locator("[data-vivic-plan-label]")).toHaveText("重复提醒");
  await display.reload(); await expect(display.locator("[data-card-id]")).toHaveCount(3);
  await display.close();
});

test("a due reminder stays clear with captions off and normal replies cannot replace it", async ({ page, context }) => {
  const display = await context.newPage(); await display.goto(`/display?canvasId=${await activeCanvasId(page)}`);
  await openPreferences(page, true);
  await page.getByRole("switch", { name: "字幕", exact: true }).uncheck();
  await sendCommand(page, "2秒后提醒我喝水");
  await expect(display.locator("[data-vivic-reminder-alert]")).toContainText("喝水", { timeout: 7000 });
  await expect(display.locator("[data-card-id]")).toHaveCount(0);
  await sendCommand(page, "添加待办：继续工作");
  await expect(display.locator("[data-vivic-reminder-alert]")).toContainText("喝水");
  await expect.poll(() => display.locator("[data-vivic-reminder-glow=true]").evaluate(el => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0.99);
  expect(await display.locator("[data-vivic-reminder-alert]").evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(24);
  await display.close();
});

test("reminder chime is independent of TTS and comes only from the owner (silent Web Audio fake)", async ({ page, context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("vivic.reminders.sound.v1", "1");
    const state = { notes: 0 }; Object.assign(window, { __testChime: state });
    class SilentContext {
      state = "running"; currentTime = 0; destination = {};
      resume = async () => undefined;
      createOscillator() { return { type: "sine", frequency: { value: 0 }, connect() {}, disconnect() {}, onended: null, start() { state.notes++; }, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    }
    Object.defineProperty(window, "AudioContext", { value: SilentContext });
  });
  await page.reload();
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  const readonly = await context.newPage(); await readonly.goto("/control");
  await expect(readonly.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "readonly");
  await sendCommand(page, "2秒后提醒我喝水");
  const notes = () => page.evaluate(() => (window as unknown as { __testChime: { notes: number } }).__testChime.notes);
  await expect.poll(notes).toBe(2);
  expect(await readonly.evaluate(() => (window as unknown as { __testChime: { notes: number } }).__testChime.notes)).toBe(0);
  await openNotifications(page);
  await page.getByRole("switch", { name: "到时提示音", exact: true }).uncheck();
  await sendCommand(page, "2秒后提醒我休息");
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveAttribute("aria-busy", "false");
  await openSpace(page, "提醒");
  await expect(page.locator("[data-vivic-reminder-notice]")).toHaveCount(2, { timeout: 7000 });
  expect(await notes()).toBe(2); await readonly.close();
});
