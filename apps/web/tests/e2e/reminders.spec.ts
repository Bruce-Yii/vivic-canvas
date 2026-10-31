import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { activeCanvasId, sendCommand, openSpace, openVoice } from "./helpers1";

test.use({ video: { mode: "on", size: { width: 1440, height: 900 } } });
const evidence = path.resolve(process.cwd(), "../../evidence/manual-feedback/reminders");
test.beforeEach(async ({ page }) => {
  await page.goto("/control");
  await expect(page.locator('[data-vivic-control]')).toHaveAttribute("data-vivic-owner", "owner");
});

test("one sentence creates three real reminders, all fire visually and survive reload without duplicate delivery", async ({ page, context }) => {
  const id = await activeCanvasId(page);
  const display = await context.newPage();
  await display.goto(`/display?canvasId=${id}`);
  await sendCommand(page, "6秒后提醒我喝水，8秒后提醒我休息，10秒后提醒我开会");
  await expect(page.locator('[data-vivic-command-feedback]')).toContainText("3 项提醒");
  await openSpace(page, "提醒");
  await expect(page.locator('[data-vivic-reminder]')).toHaveCount(3);
  await expect(display.locator('[data-card-id]')).toHaveCount(1);
  await expect(display.locator('[data-vivic-reminder-row]')).toHaveCount(3);
  await expect(display.locator('[data-vivic-reminder-list]')).toContainText("喝水");
  await expect(page.locator('[data-vivic-reminder-notice]')).toHaveCount(3, { timeout: 15000 });
  await expect(display.locator('[data-vivic-reminder-alert]')).toContainText("开会");
  await expect(display.locator('[data-card-id]')).toHaveCount(0);
  fs.mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, "three-reminders-control.png"), fullPage: true });
  await display.screenshot({ path: path.join(evidence, "due-reminder-display.png") });
  await page.reload();
  await openSpace(page, "提醒");
  await expect(page.locator('[data-vivic-reminder-notice]')).toHaveCount(3);
  await page.waitForTimeout(1200);
  await expect(page.locator('[data-vivic-reminder-notice]')).toHaveCount(3);
  const video = display.video(); await display.close();
  if (video) await video.saveAs(path.join(evidence, "rec-three-reminders.webm"));
});

test("pause freezes a timer; resume, edit and cancel keep Display minimal and consistent", async ({ page, context }) => {
  await sendCommand(page, "30秒后提醒我喝水");
  const row = page.locator('[data-vivic-reminder]');
  await openSpace(page, "提醒");
  await expect(row).toHaveCount(1);
  await openSpace(page, "提醒");
  const id = await activeCanvasId(page);
  const display = await context.newPage(); await display.goto(`/display?canvasId=${id}`);
  await row.getByRole("button", { name: "暂停喝水" }).click();
  await expect(row.locator('[data-vivic-reminder-status]')).toContainText("已暂停");
  const paused = await display.locator('[data-card-id]').textContent();
  await page.waitForTimeout(1300);
  expect(await display.locator('[data-card-id]').textContent()).toBe(paused);
  await row.getByRole("button", { name: "继续喝水" }).click();
  await expect(row.locator('[data-vivic-reminder-status]')).toContainText("剩余");
  await row.getByRole("button", { name: "修改", exact: true }).click();
  await row.getByLabel("提醒内容").fill("起身走动");
  await row.getByLabel("提醒延后分钟").fill("1");
  await row.getByRole("button", { name: "保存", exact: true }).click();
  await expect(row.locator('[data-vivic-reminder-text]')).toHaveText("起身走动");
  await row.getByRole("button", { name: "取消提醒" }).click();
  await expect(row).toHaveCount(0);
  await expect(display.locator('[data-card-id]')).toHaveCount(0);
  await expect(page.locator('[data-vivic-reminder-notice]')).toHaveCount(0);
  await openSpace(page); await page.locator('[data-vivic-undo]').click(); await openSpace(page, "提醒");
  await expect(row).toHaveCount(1);
  await expect(display.locator('[data-card-id]')).toHaveCount(1);
  await display.close();
});

test("an inactive canvas still triggers a reminder without switching the active canvas", async ({ page }) => {
  await sendCommand(page, "3秒后提醒我查看旧画布");
  await openSpace(page, "提醒");
  await expect(page.locator('[data-vivic-reminder]')).toHaveCount(1);
  const second = await page.evaluate(() => {
    const id = window.__vivicControl!.createCanvas("另一个画布");
    window.__vivicControl!.switchCanvas(id); return id;
  });
  await expect(page.locator('[data-vivic-reminder-notice]')).toContainText("查看旧画布", { timeout: 7000 });
  expect(await activeCanvasId(page)).toBe(second);
});

test("simultaneous reminders queue three speech requests without overlap (silent audio mock)", async ({ page }) => {
  await page.addInitScript(() => {
    const state = { active: 0, maximum: 0 };
    Object.assign(window, { __silentQueue: state });
    class SilentAudio {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      volume = 0;
      live = false;
      play() {
        this.live = true; state.active += 1; state.maximum = Math.max(state.maximum, state.active);
        setTimeout(() => this.onended?.(), 100);
        return Promise.resolve();
      }
      pause() { if (this.live) { this.live = false; state.active -= 1; } }
      removeAttribute() {}
      load() {}
    }
    Object.defineProperty(window, "Audio", { value: SilentAudio });
  });
  await page.route("**/api/providers/status", route => route.fulfill({ json: {
    providers: [{ name: "stepfun", connected: true, defaultModel: "step-3.5-flash", capabilities: ["text"] }], degradations: [],
  } }));
  const requests: string[] = [];
  await page.route("**/api/speech", route => {
    requests.push(route.request().postDataJSON().text);
    return route.fulfill({ contentType: "audio/mpeg", body: Buffer.from("ID3-silent-fixture") });
  });
  await page.reload();
  await openSpace(page, "提醒");
  await openVoice(page); await page.getByRole("switch", { name: "语音回复", exact: true }).check();
  await sendCommand(page, "2秒后提醒我喝水、休息、开会");
  await openSpace(page, "提醒");
  await expect(page.locator('[data-vivic-reminder-notice]')).toHaveCount(3, { timeout: 6000 });
  await expect.poll(() => requests.filter(text => text.startsWith("提醒：")).length).toBe(3);
  expect(requests.filter(text => text.startsWith("提醒："))).toEqual(["提醒：喝水", "提醒：休息", "提醒：开会"]);
  expect(await page.evaluate(() => (window as unknown as { __silentQueue: { maximum: number } }).__silentQueue.maximum)).toBe(1);
});
