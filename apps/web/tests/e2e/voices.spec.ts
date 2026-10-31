import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { openVoice } from "./helpers1";

// Office-safe: no real audio element or audio device is ever created.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { __silentAudio: { plays: 0, pauses: 0 } });
    class SilentAudio {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      volume = 0;
      play() { (window as unknown as { __silentAudio: { plays: number } }).__silentAudio.plays += 1; return Promise.resolve(); }
      pause() { (window as unknown as { __silentAudio: { pauses: number } }).__silentAudio.pauses += 1; }
      removeAttribute() {}
      load() {}
    }
    Object.defineProperty(window, "Audio", { value: SilentAudio });
  });
  await page.route("**/api/providers/status", route => route.fulfill({ json: {
    providers: [{ name: "stepfun", connected: true, defaultModel: "step-3.5-flash", models: ["step-3.5-flash"], capabilities: ["text"] }], degradations: [],
  } }));
  await page.goto("/control");
  await expect(page.locator('[data-vivic-ai-badge]')).toContainText("已连接");
  await openVoice(page, true);
});

test("voice and speed are used for preview, volume stays browser-only, preferences survive reload", async ({ page, context }) => {
  await expect(page.getByRole("switch", { name: "语音回复", exact: true })).not.toBeChecked();
  await page.getByRole("switch", { name: "语音回复", exact: true }).check();
  await expect(page.getByLabel("音色", { exact: true })).toHaveText("温柔女声");
  await expect(page.getByLabel("语速", { exact: true })).toHaveValue("1.3");
  let payload: Record<string, unknown> | undefined;
  await page.route("**/api/speech", route => {
    payload = route.request().postDataJSON();
    return route.fulfill({ contentType: "audio/mpeg", body: Buffer.from("ID3-silent-fixture") });
  });
  await page.getByLabel("音色", { exact: true }).click();
  await page.getByRole("option", { name: "磁性男声", exact: true }).click();
  await page.getByLabel("语速", { exact: true }).fill("1.1");
  await page.getByLabel("音量", { exact: true }).fill("0");
  await page.locator('[data-vivic-tts-preview]').click();
  await expect(page.getByRole("button", { name: "停止试听", exact: true })).toBeVisible();
  expect(payload).toMatchObject({ voice: "cixingnansheng", speed: 1.1 });
  expect(payload).not.toHaveProperty("volume");
  const display = await context.newPage(); await display.goto("/display");
  await expect(display.locator('[data-vivic-speaking]')).toContainText("你好", { timeout: 5000 });
  await expect(display.locator('[data-vivic-ai-state="speaking"]')).toHaveCount(1);
  const dir = path.resolve(process.cwd(), "../../evidence/voice-feedback/regression/voices"); fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, "voice-settings.png"), fullPage: true });
  await page.locator('[data-vivic-tts-preview]').click();
  await expect(page.getByRole("button", { name: "试听音色", exact: true })).toBeVisible();
  await expect(display.locator('[data-vivic-speaking]')).toHaveCount(0);
  await page.reload();
  await openVoice(page, true);
  await expect(page.getByRole("switch", { name: "语音回复", exact: true })).not.toBeChecked();
  await page.getByRole("switch", { name: "语音回复", exact: true }).check();
  await expect(page.getByLabel("音色", { exact: true })).toHaveText("磁性男声");
  await expect(page.getByLabel("语速", { exact: true })).toHaveValue("1.1");
  await expect(page.getByLabel("音量", { exact: true })).toHaveValue("0");
  await page.getByRole("switch", { name: "语音回复", exact: true }).uncheck();
  await display.close();
});
