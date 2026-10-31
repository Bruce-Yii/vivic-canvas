import { expect, test, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { activeCanvasId, sendCommand, openVoice } from "./helpers1";

interface TestAudio {
  currentTime: number; paused: boolean; volume: number;
  onended: (() => void) | null; ontimeupdate: (() => void) | null;
  onplaying: (() => void) | null; onwaiting: (() => void) | null;
  start: () => void;
}
declare global { interface Window { __voiceTest: { audios: TestAudio[]; plays: number; pauses: number; utterances: SpeechSynthesisUtterance[]; cancels: number } } }

const root = path.resolve(process.cwd(), "../../evidence/voice-feedback");
// Video is evidence only. Constrained Windows/Android co-verification can omit
// encoding while retaining every audio, timing, sync and cancellation assertion.
test.use({ video: process.env.VIVIC_E2E_VIDEO === "off" ? "off" : { mode: "on", size: { width: 1440, height: 900 } } });
test.beforeEach(async ({ context, page }) => {
  // No real Audio.play, speaker graph, speech synthesis, or physical mic.
  // OfflineAudioContext may decode samples without creating an output graph.
  await context.addInitScript(() => {
    window.__voiceTest = { audios: [], plays: 0, pauses: 0, utterances: [], cancels: 0 };
    HTMLMediaElement.prototype.play = async () => { throw new Error("TEST real playback disabled"); };
    navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST mic disabled"); };
    class SilentAudio {
      currentTime = 0; paused = true; volume = 0;
      onended = null; onerror = null; ontimeupdate = null; onplaying = null; onwaiting = null; onpause = null;
      start = () => {};
      constructor() { window.__voiceTest.audios.push(this); }
      play() { window.__voiceTest.plays++; return new Promise<void>(resolve => { this.start = () => { this.paused = false; resolve(); }; }); }
      pause() { this.paused = true; window.__voiceTest.pauses++; }
      removeAttribute() {}
      load() {}
    }
    Object.defineProperty(window, "Audio", { value: SilentAudio });
    const voiceEvents = new EventTarget();
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
      getVoices: () => [{ voiceURI: "TEST-local", name: "TEST local voice", lang: "zh-CN", localService: true, default: true }],
      speak: (utterance: SpeechSynthesisUtterance) => { window.__voiceTest.utterances.push(utterance); },
      cancel: () => { window.__voiceTest.cancels++; },
      addEventListener: voiceEvents.addEventListener.bind(voiceEvents), removeEventListener: voiceEvents.removeEventListener.bind(voiceEvents),
    } });
    class SilentUtterance {
      text: string; onstart = null; onboundary = null; onend = null; onerror = null;
      constructor(text: string) { this.text = text; }
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: SilentUtterance });
  });
  await page.goto("/control");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  await openVoice(page, true);
});

test("browser boundary callbacks highlight words and never claim PCM amplitude", async ({ page, context }) => {
  let cloud = 0;
  await page.route("**/api/speech", route => { cloud++; return route.fulfill({ status: 503, json: { error: "TEST unexpected cloud call" } }); });
  await page.route("**/api/intent", route => finish(route, "你好世界"));
  const display = await context.newPage(); await display.goto(`/display?canvasId=${await activeCanvasId(page)}`);
  await page.getByLabel("语音输出服务").click();
  await page.getByRole("option", { name: "系统音色", exact: true }).click();
  await page.getByRole("switch", { name: "语音回复", exact: true }).check();
  await sendCommand(page, "TEST 浏览器语音边界");
  await expect.poll(() => page.evaluate(() => window.__voiceTest.utterances.length)).toBe(1);
  await expect(display.locator("[data-vivic-speaking]")).toHaveCount(0);
  await page.evaluate(() => {
    const u = window.__voiceTest.utterances[0]!;
    u.onstart?.call(u, {} as SpeechSynthesisEvent);
    u.onboundary?.call(u, { charIndex: 0, charLength: 2 } as SpeechSynthesisEvent);
  });
  await expect(display.locator("[data-vivic-spoken-word]")).toHaveText("你好");
  const amplitude = await page.evaluate(() => (window.__vivic!.getState() as { activity: { speech: { amplitude: number } } }).activity.speech.amplitude);
  expect(amplitude).toBe(0);
  await page.evaluate(() => {
    const u = window.__voiceTest.utterances[0]!;
    u.onboundary?.call(u, { charIndex: 2, charLength: 0 } as SpeechSynthesisEvent);
  });
  await expect(display.locator("[data-vivic-spoken-word]")).toHaveCount(0);
  await page.evaluate(() => {
    const u = window.__voiceTest.utterances[0]!;
    u.onboundary?.call(u, { charIndex: 2, charLength: 2 } as SpeechSynthesisEvent);
  });
  await expect(display.locator("[data-vivic-spoken-word]")).toHaveText("世界");
  await page.evaluate(() => { const u = window.__voiceTest.utterances[0]!; u.onend?.call(u, {} as SpeechSynthesisEvent); });
  await expect(display.locator("[data-vivic-speaking]")).toHaveCount(0);
  expect(cloud).toBe(0); expect(await display.evaluate(() => window.__voiceTest.plays)).toBe(0);
  await page.reload();
  await openVoice(page, true);
  await expect(page.getByRole("switch", { name: "语音回复", exact: true })).not.toBeChecked();
  await display.close();
});

const finish = async (route: Route, text = "我看看。") => {
  const { canvasContext } = route.request().postDataJSON();
  await route.fulfill({ json: { kind: "envelope", envelope: { schemaVersion: "0.6", requestId: "TEST-timed-response", canvasId: canvasContext.canvasId,
    spokenText: text, actions: [{ type: "canvas.fit" }] } } }).catch(() => undefined);
};

test("fixed cues are opt-in, restore thinking, and cancel with their owning request", async ({ page, context }) => {
  let assets = 0, cloud = 0, held: Route | undefined;
  page.on("request", request => { if (request.url().includes("/voice-feedback/") && request.url().endsWith(".mp3")) assets++; });
  await page.route("**/api/speech", route => { cloud++; return route.fulfill({ status: 503, json: { error: "TEST must stay offline" } }); });
  await page.route("**/api/intent", route => { held = route; });
  const display = await context.newPage(); await display.goto(`/display?canvasId=${await activeCanvasId(page)}`);
  await sendCommand(page, "TEST 尚未启用语音");
  await page.waitForTimeout(600);
  expect(assets).toBe(0); expect(cloud).toBe(0);
  await page.locator("[data-vivic-command-cancel]").click();
  await openVoice(page, true);
  await page.getByRole("switch", { name: "语音回复", exact: true }).check();
  await sendCommand(page, "TEST 等待复杂规划");
  await expect.poll(() => assets).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__voiceTest.audios.length)).toBe(1);
  await expect(display.locator("[data-vivic-thinking]")).toHaveText("让我想想…");
  await page.evaluate(() => window.__voiceTest.audios[0]!.start());
  await expect(display.locator("[data-vivic-speaking]")).toHaveText("我看看");
  await page.evaluate(() => window.__voiceTest.audios[0]!.onended?.());
  await expect(display.locator("[data-vivic-thinking]")).toHaveText("让我想想…");
  await page.locator("[data-vivic-command-cancel]").click();
  await finish(held!, "TEST late cue result");
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText("已取消本次请求");
  await expect(display.locator("[data-vivic-speaking]")).toHaveCount(0);
  expect(cloud).toBe(0); expect(await display.evaluate(() => window.__voiceTest.plays)).toBe(0);
  const video = display.video(); await display.close();
  if (video) await video.saveAs(path.join(root, test.info().project.name || "chromium", "TEST-short-cues.webm"));
});

test("actual decoded PCM and the media clock drive word highlights in both displays", async ({ page, context }, testInfo) => {
  // This scenario simulates a connected cloud TTS service. The separate fixed
  // cue scenario deliberately stays disconnected to exercise offline assets.
  await page.route("**/api/providers/status", route => route.fulfill({ json: {
    activeProvider: "stepfun", instance: "TEST-timed-speech", degradations: [],
    providers: [{ name: "stepfun", connected: true, defaultModel: "step-3.5-flash", models: ["step-3.5-flash"], capabilities: ["chat", "structured"] }],
  } }));
  await page.reload();
  await expect(page.locator("[data-vivic-ai-badge]")).toContainText("已连接");
  await openVoice(page, true);
  const audio = readFileSync(path.resolve(process.cwd(), "public/voice-feedback/checking.mp3"));
  let calls = 0;
  await page.route("**/api/speech", route => {
    calls++;
    expect(route.request().postDataJSON()).toMatchObject({ text: "我看看。", timestamps: true });
    return route.fulfill({ json: { audioBase64: audio.toString("base64"), words: [
      { startMs: 0, endMs: 250, charStart: 0, charEnd: 1 }, { startMs: 250, endMs: 500, charStart: 1, charEnd: 2 },
      { startMs: 500, endMs: 800, charStart: 2, charEnd: 4 },
    ] } });
  });
  await page.route("**/api/intent", route => finish(route));
  const one = await context.newPage(), two = await context.newPage();
  const canvasId = await activeCanvasId(page);
  await one.goto(`/display?canvasId=${canvasId}`); await two.goto(`/display?canvasId=${canvasId}`);
  await page.getByRole("switch", { name: "语音回复", exact: true }).check();
  await page.getByRole("switch", { name: "逐词字幕", exact: true }).check();
  await sendCommand(page, "TEST 合成一条带时间戳的短句");
  await expect.poll(() => page.evaluate(() => window.__voiceTest.audios.length)).toBe(1);
  await expect(one.locator("[data-vivic-speaking]")).toHaveCount(0);
  await page.evaluate(() => { const audio = window.__voiceTest.audios[0]!; audio.currentTime = 0.35; audio.start(); });
  await expect(one.locator("[data-vivic-spoken-word]")).toHaveText("看");
  await expect(two.locator("[data-vivic-spoken-word]")).toHaveText("看");
  await expect.poll(() => page.evaluate(() => {
    const state = window.__vivic!.getState() as { activity: { speech?: { amplitude: number } } | null };
    return state.activity?.speech?.amplitude ?? 0;
  })).toBeGreaterThan(0);
  await one.screenshot({ path: path.join(root, testInfo.project.name || "chromium", "TEST-word-amplitude.png") });
  await page.evaluate(() => { const audio = window.__voiceTest.audios[0]!; audio.currentTime = 1.2; audio.ontimeupdate?.(); });
  await expect(one.locator("[data-vivic-spoken-word]")).toHaveCount(0);
  await page.evaluate(() => window.__voiceTest.audios[0]!.onwaiting?.());
  await expect(one.locator("[data-vivic-speaking]")).toHaveCount(0);
  await page.evaluate(() => window.__voiceTest.audios[0]!.onplaying?.());
  await expect(one.locator("[data-vivic-speaking]")).toHaveCount(1);
  await page.evaluate(() => window.__voiceTest.audios[0]!.onended?.());
  await expect(one.locator("[data-vivic-speaking]")).toHaveCount(0);
  expect(calls).toBe(1);
  expect(await one.evaluate(() => window.__voiceTest.plays)).toBe(0);
  expect(await two.evaluate(() => window.__voiceTest.plays)).toBe(0);
  const video = one.video(); await one.close(); await two.close();
  if (video) await video.saveAs(path.join(root, testInfo.project.name || "chromium", "TEST-word-amplitude.webm"));
});
