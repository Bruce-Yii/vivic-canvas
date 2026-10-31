import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { activeCanvasId, sendCommand, openSpace } from "./helpers1";

// Synthetic microphone only: no employee conversations or physical device.
const toneFile = path.join(os.tmpdir(), "vivic-e2e-microphone-tone.wav");
const samples = 16000 * 2;
const wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 16000) * 6000), 44 + i * 2);
fs.writeFileSync(toneFile, wav);

test.use({ launchOptions: { ...(process.env.VIVIC_E2E_CHROMIUM ? { executablePath: process.env.VIVIC_E2E_CHROMIUM } : {}),
  args: ["--mute-audio", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${toneFile}`] }, permissions: ["microphone"] });

const hold = async (page: Page) => {
  await page.bringToFront();
  await page.locator('[data-vivic-ptt]').hover();
  await page.mouse.down();
  await expect(page.locator('[data-vivic-voice-input]')).toHaveAttribute("data-vivic-voice-status", "recording");
  await page.waitForTimeout(600);
};

test.beforeEach(async ({ page }) => {
  // Voice and text input live on the user page.
  await page.goto("/");
  await expect(page.locator('[data-vivic-control]')).toHaveAttribute("data-vivic-owner", "owner");
});

test("disabling automatic sending records WAV, transcribes into review, then uses the shared command engine", async ({ page, context }) => {
  await page.getByRole("button", { name: "添加内容", exact: true }).click();
  await page.locator('[data-vivic-voice-auto]').uncheck();
  await page.keyboard.press("Escape");
  let uploads = 0;
  await page.route("**/api/transcribe", async route => {
    const body = route.request().postDataBuffer()!;
    const at = body.indexOf(Buffer.from("RIFF"));
    expect(at).toBeGreaterThan(0);
    expect(body.readUInt32LE(at + 24)).toBe(16000);
    expect(body.readUInt16LE(at + 22)).toBe(1);
    uploads += 1;
    await route.fulfill({ json: { ok: true, text: "10分钟后提醒我喝水" } });
  });
  const display = await context.newPage(); await display.goto(`/display?canvasId=${await activeCanvasId(page)}`);
  await hold(page);
  await expect(display.locator('[data-vivic-ai-state="listening"]')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('[data-vivic-command-input]')).toHaveValue("10分钟后提醒我喝水");
  await expect(page.locator('[data-vivic-voice-note]')).toContainText("检查输入框");
  await expect(page.locator('[data-vivic-reminder]')).toHaveCount(0);
  expect(uploads).toBe(1);
  const dir = path.resolve(process.cwd(), "../../evidence/phase2-voice-input"); fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, "transcript-review.png"), fullPage: true });
  await page.locator('[data-vivic-command-send]').click();
  await openSpace(page, "提醒");
  await expect(page.locator('[data-vivic-reminder-text]')).toHaveText("喝水");
  await expect(display.locator('[data-card-id]')).toHaveCount(1);
  const reminder = display.locator('[data-vivic-reminder-row]');
  await expect(reminder).toHaveCount(1);
  await expect(reminder).toContainText("喝水");
  await expect(reminder.locator(".vivic-reminder-time")).toHaveText(/^\d{2}:\d{2}$/);
  await display.close();
});

test("permission denial leaves text commands usable and never uploads", async ({ page }) => {
  await page.evaluate(() => Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true,
    value: async () => { throw new DOMException("denied", "NotAllowedError"); } }));
  let uploads = 0; await page.route("**/api/transcribe", () => { uploads += 1; });
  await page.locator('[data-vivic-ptt]').hover(); await page.mouse.down();
  await expect(page.locator('[data-vivic-voice-note]')).toContainText("权限未开启");
  await page.mouse.up();
  expect(uploads).toBe(0);
  await sendCommand(page, "五分钟倒计时");
  await openSpace(page, "提醒");
  await expect(page.locator('[data-vivic-reminder]')).toHaveCount(1);
});

test("releasing during permission acquisition stops a late MediaStream and sends no audio", async ({ page }) => {
  await page.evaluate(() => {
    const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async (constraints: MediaStreamConstraints) => {
      const stream = await native(constraints);
      Object.assign(window, { __lateMic: stream });
      await new Promise<void>(resolve => { Object.assign(window, { __allowMic: resolve }); });
      return stream;
    } });
  });
  let uploads = 0; await page.route("**/api/transcribe", () => { uploads += 1; });
  await page.locator('[data-vivic-ptt]').hover(); await page.mouse.down();
  await expect(page.locator('[data-vivic-voice-input]')).toHaveAttribute("data-vivic-voice-status", "requesting");
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __allowMic?: unknown }).__allowMic))).toBe(true);
  await page.mouse.up();
  await page.evaluate(() => (window as unknown as { __allowMic: () => void }).__allowMic());
  await expect.poll(() => page.evaluate(() => (window as unknown as { __lateMic: MediaStream }).__lateMic.getTracks().every(t => t.readyState === "ended"))).toBe(true);
  await expect(page.locator('[data-vivic-voice-input]')).toHaveAttribute("data-vivic-voice-status", "idle");
  expect(uploads).toBe(0);
});

test("cancel discards late transcription and keeps the input intact", async ({ page }) => {
  let held: import("@playwright/test").Route | undefined;
  await page.route("**/api/transcribe", route => { held = route; });
  await page.locator('[data-vivic-command-input]').fill("已有文字");
  await hold(page); await page.mouse.up();
  await expect(page.locator('[data-vivic-voice-input]')).toHaveAttribute("data-vivic-voice-status", "transcribing");
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.locator('[data-vivic-voice-cancel]').click();
  await held!.fulfill({ json: { ok: true, text: "旧请求的文字" } }).catch(() => undefined);
  await expect(page.locator('[data-vivic-command-input]')).toHaveValue("已有文字");
  await expect(page.locator('[data-vivic-reminder]')).toHaveCount(0);
});

test("typing during transcription preserves the draft until the user chooses replacement", async ({ page }) => {
  let held: import("@playwright/test").Route | undefined;
  await page.route("**/api/transcribe", route => { held = route; });
  await hold(page); await page.mouse.up();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.locator('[data-vivic-command-input]').fill("我后来输入的文字");
  await held!.fulfill({ json: { ok: true, text: "10分钟后提醒我喝水" } });
  await expect(page.locator('[data-vivic-unapplied-voice]')).toContainText("10分钟后提醒我喝水");
  await expect(page.locator('[data-vivic-command-input]')).toHaveValue("我后来输入的文字");
  await page.getByRole("button", { name: "使用这段转写" }).click();
  await expect(page.locator('[data-vivic-command-input]')).toHaveValue("10分钟后提醒我喝水");
});

test("automatic mode is on by default and sends the recognized command on release", async ({ page }) => {
  await page.route("**/api/transcribe", route => route.fulfill({ json: { ok: true, text: "10分钟后提醒我喝水" } }));
  await expect(page.locator('[data-vivic-voice-auto]')).toBeChecked();
  await hold(page); await page.mouse.up();
  await openSpace(page, "提醒");
  await expect(page.locator('[data-vivic-reminder-text]')).toHaveText("喝水");
  await expect(page.locator('[data-vivic-command-input]')).toHaveValue("");
});
