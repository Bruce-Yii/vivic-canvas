import { expect, test, type Page, type Route } from "@playwright/test";
import { sendCommand, openVoice } from "./helpers1";

const connected = async (page: Page) => {
  await page.route("**/api/providers/status", route => route.fulfill({ json: {
    providers: [{ name: "stepfun", connected: true, models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", capabilities: ["text"] }],
    degradations: [],
  } }));
  await page.goto("/control");
  await page.waitForSelector('[data-vivic-control="ready"]');
  await expect(page.locator('[data-vivic-ai-badge]')).toContainText("已连接");
  await openVoice(page, true);
};

const result = (route: Route) => route.fulfill({ json: {
  kind: "envelope", usedProvider: "stepfun", envelope: {
    schemaVersion: "0.6", requestId: `speech-${Date.now()}`,
    canvasId: route.request().postDataJSON().canvasContext.canvasId,
    spokenText: "已显示全部", actions: [{ type: "canvas.fit" }],
  },
} });

test("TTS is opt-in and an unavailable Plan voice reports failure without blocking actions", async ({ page }) => {
  await page.addInitScript(() => {
    class SilentAudio {
      volume = 0;
      play() { return Promise.resolve(); }
      pause() {}
      removeAttribute() {}
      load() {}
    }
    Object.defineProperty(window, "Audio", { value: SilentAudio });
  });
  let calls = 0;
  await page.route("**/api/speech", route => {
    calls += 1;
    return route.fulfill({ status: 503, json: { error: "语音不可用：Plan 语音请求被拒绝（HTTP 403）" } });
  });
  await page.route("**/api/intent", result);
  await connected(page);
  await expect(page.getByRole("switch", { name: "语音回复", exact: true })).not.toBeChecked();
  await sendCommand(page, "显示全部");
  await expect(page.locator('[data-vivic-command-feedback]')).toHaveText("已显示全部");
  expect(calls).toBe(0);
  await openVoice(page, true);
  await page.getByRole("switch", { name: "语音回复", exact: true }).check();
  await sendCommand(page, "显示全部");
  await expect(page.locator('[data-vivic-tts-note]')).toContainText("HTTP 403");
  await expect(page.locator('[data-vivic-command-feedback]')).toHaveText("已显示全部");
  expect(calls).toBe(1);
});

test("new commands interrupt audio and displays never duplicate playback", async ({ page, context }) => {
  await page.addInitScript(() => {
    const stats = { plays: 0, pauses: 0 };
    Object.assign(window, { __speechStats: stats });
    class FakeAudio {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      play() { stats.plays += 1; return Promise.resolve(); }
      pause() { stats.pauses += 1; }
      removeAttribute() {}
      load() {}
    }
    Object.defineProperty(window, "Audio", { value: FakeAudio });
  });
  let calls = 0;
  let held: Route | undefined;
  await page.route("**/api/intent", route => {
    if (route.request().postDataJSON().text === "下一条复杂指令") { held = route; return; }
    return result(route);
  });
  await context.route("**/api/speech", route => {
    calls += 1;
    return route.fulfill({ contentType: "audio/mpeg", body: Buffer.from("ID3-test-audio") });
  });
  await connected(page);
  await page.getByRole("switch", { name: "语音回复", exact: true }).check();
  await sendCommand(page, "显示全部");
  const stats = () => page.evaluate(() => (window as unknown as { __speechStats: { plays: number; pauses: number } }).__speechStats);
  await expect.poll(async () => (await stats()).plays).toBe(1);
  const display = await context.newPage();
  await display.goto("/display");
  await sendCommand(page, "下一条复杂指令");
  await expect(page.locator('[data-vivic-command-cancel]')).toBeVisible();
  await expect.poll(async () => (await stats()).pauses).toBe(1);
  expect(calls).toBe(1);
  await page.locator('[data-vivic-command-cancel]').click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await result(held!).catch(() => undefined);
  expect(calls).toBe(1);
  await display.close();
});
