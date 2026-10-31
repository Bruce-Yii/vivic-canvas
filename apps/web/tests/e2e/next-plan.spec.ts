import { test, expect } from "@playwright/test";
import path from "node:path";
import { readIntentResult, activeCanvasId, controlDispatch, sendCommand, openNotifications, openSpace, openVoice, todoCardRecord } from "./helpers1";
// Existing audio-routing tests model an already-authorized microphone; startup
// permission prompting is covered separately with synthetic streams.
test.use({ video: { mode: "on", size: { width: 1440, height: 900 } }, permissions: ["microphone"] });
test("dated, recurring and canvas-condition reminders persist without model requests, and only owner notifies silently", async ({ page, context }, info) => {
  await context.addInitScript(() => {
    Object.assign(window, { __testNotifications: [] });
    class SilentNotification {
      static permission = "granted";
      static async requestPermission() { return "granted"; }
      constructor(_title: string, options: NotificationOptions) { (window as unknown as { __testNotifications: NotificationOptions[] }).__testNotifications.push(options); }
      close() {}
    }
    Object.defineProperty(window, "Notification", { value: SilentNotification });
    HTMLMediaElement.prototype.play = async () => { throw new Error("TEST audio forbidden"); };
    navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST mic forbidden"); };
  });
  const providers: string[] = [];
  page.on("response", async response => {
    if (!response.url().endsWith("/api/intent")) return;
    const task = response.request().postDataJSON().task;
    // Receipt/cancel traffic settles a task; it does not generate a new plan.
    if (task?.receipt || task?.cancel) return;
    const result = await readIntentResult(response);
    providers.push(result.usedProvider ?? "missing-provider");
  });
  await page.goto("/control"); await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  const id = await activeCanvasId(page);
  await controlDispatch(page, "TEST-conditions", id, [{ type: "stage.awaken" }, { type: "card.create", card: todoCardRecord("TEST-condition-todo", ["TEST 完成项"]) }]);
  await sendCommand(page, "每天09:00提醒我TEST每日");
  await openSpace(page, "提醒"); await expect(page.locator("[data-vivic-reminder-schedule]")).toContainText("09:00");
  await sendCommand(page, "明天上午9点提醒我TEST明天"); await openSpace(page, "提醒"); await expect(page.locator("[data-vivic-reminder]")).toHaveCount(2);
  await sendCommand(page, "当待办第1项完成后提醒我TEST完成条件");
  await openSpace(page, "提醒");
  const condition = page.locator("[data-vivic-reminder]").filter({ hasText: "TEST完成条件" });
  await expect(condition).toContainText("等待条件");
  await openNotifications(page); await page.getByRole("switch", { name: "系统通知", exact: true }).check(); await expect(page.getByRole("switch", { name: "系统通知", exact: true })).toBeChecked();
  const reader = await context.newPage(); await reader.goto("/control");
  await expect(reader.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "readonly");
  await sendCommand(page, "把待办第一项标记为完成");
  await openSpace(page, "提醒"); await expect(page.locator("[data-vivic-reminder-notice]")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __testNotifications: NotificationOptions[] }).__testNotifications.length)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { __testNotifications: NotificationOptions[] }).__testNotifications)).toEqual([expect.objectContaining({ silent: true, body: "TEST完成条件" })]);
  expect(await reader.evaluate(() => (window as unknown as { __testNotifications: NotificationOptions[] }).__testNotifications)).toEqual([]);
  await reader.close();
  await sendCommand(page, "每隔5秒提醒我TEST循环");
  await openSpace(page, "提醒");
  const recurring = page.locator("[data-vivic-reminder]").filter({ hasText: "TEST循环" });
  await expect(recurring).toHaveCount(1); await openSpace(page, "提醒"); await recurring.getByRole("button", { name: "暂停TEST循环" }).click();
  await expect(recurring).toContainText("已暂停"); await recurring.getByRole("button", { name: "继续TEST循环" }).click();
  await expect.poll(async () => page.locator("[data-vivic-reminder-notice]").filter({ hasText: "TEST循环" }).count(), { timeout: 14000 }).toBe(2);
  await recurring.getByRole("button", { name: "暂停TEST循环" }).click();
  await page.reload(); await openSpace(page, "提醒"); await expect(page.locator("[data-vivic-reminder]")).toHaveCount(4);
  await expect(page.locator("[data-vivic-reminder-notice]")).toHaveCount(3);
  // The recovered exact Todo edit is explicitly labelled rules-offline.
  // All five planning requests must still avoid StepFun/GPT generation.
  expect(providers).toEqual(["rules", "rules", "rules", "rules-offline", "rules"]);
  await page.locator("[data-vivic-reminders]").screenshot({ path: path.resolve(process.cwd(), "../../evidence/next-plan", info.project.name || "chromium", "TEST-reminders.png") });
});
test("optional model settings expose explicit lifecycle and never enable automatically", async ({ page }) => {
  let phase = "cached", enabled = false; const calls: string[] = [];
  await page.route("**/api/decision/*", async route => {
    const action = route.request().url().split("/").at(-1)!;
    if (action !== "status") { calls.push(action); phase = action === "enable" ? "ready" : action === "clear" ? "absent" : "cached"; enabled = action === "enable"; }
    await route.fulfill({ json: { phase, enabled, model: "Kev-0.8B", bytes: 1825383500, gpuBytes: enabled ? 1504791242 : 0, lastMs: null, error: null } });
  });
  await page.goto("/control#settings-local"); await expect(page.locator("[data-vivic-decision-status]")).toContainText("已准备，未启用"); expect(calls).toEqual([]);
  await page.locator("[data-vivic-decision-enable]").click(); await expect(page.locator("[data-vivic-decision-status]")).toContainText("已启用");
  await page.locator("[data-vivic-decision-stop]").click(); await expect(page.locator("[data-vivic-decision-status]")).toContainText("未启用");
  await page.locator("[data-vivic-decision-clear]").click(); expect(calls).toEqual(["enable", "stop"]);
  await page.getByRole("button", { name: "清理模型", exact: true }).click(); await expect(page.locator("[data-vivic-decision-status]")).toContainText("尚未准备");
});
test("model Blob cache survives native writes or byte fallback, while reset invalidates stale leases", async ({ page }) => {
  await page.goto("/control");
  const result = await page.evaluate(async () => {
    const { IndexedDbModelStorage } = await import("/src/ai/localSpeech/storage.ts");
    const storage = new IndexedDbModelStorage(); const record = { id: "vad" as const, sha256: "TEST", bytes: 4, blob: new Blob([new Uint8Array([1, 2, 3, 4])]) };
    const lease = await storage.begin("vad"); await storage.put(record, lease);
    const first = Array.from(new Uint8Array(await (await storage.get("vad"))!.blob.arrayBuffer()));
    // Exercise the fallback deterministically as well as native WebKit behavior.
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
      if (this.name === "models" && value && typeof value === "object" && "blob" in value) throw new DOMException("TEST Blob backing failure", "UnknownError");
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
    try { await storage.put(record, await storage.begin("vad")); } finally { IDBObjectStore.prototype.put = original; }
    const fallback = Array.from(new Uint8Array(await (await storage.get("vad"))!.blob.arrayBuffer()));
    const stale = await storage.begin("vad"); await storage.delete(); let rejected = false;
    try { await storage.put(record, stale); } catch { rejected = true; }
    return { first, fallback, rejected, empty: !await storage.get("vad") };
  });
  expect(result).toEqual({ first: [1, 2, 3, 4], fallback: [1, 2, 3, 4], rejected: true, empty: true });
});
test("output selection uses official voices despite legacy clone preferences and never touches microphone", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("vivic.speech.preferences.v1", JSON.stringify({
      voice: "wenrounvsheng", speed: 1.2, volume: 0.5, clonedVoiceId: "voice-tone-TEST",
    }));
    const state = { picks: 0, microphone: 0, plays: 0, sink: "", unavailable: false };
    Object.assign(window, { __audioDeviceTest: state });
    const devices = Object.assign(new EventTarget(), { selectAudioOutput: async () => { state.picks++; return { deviceId: "TEST-headset", label: "TEST headphones" }; },
      enumerateDevices: async () => [], getUserMedia: async () => { state.microphone++; throw new Error("Mic forbidden"); } });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: devices });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: async () => {} });
    class SilentAudio {
      volume = 0; onended: (() => void) | null = null;
      async setSinkId(id: string) { if (state.unavailable) throw new Error("TEST unplugged"); state.sink = id; }
      async play() { if (state.sink !== "TEST-headset") throw new Error("Wrong sink order"); state.plays++; setTimeout(() => this.onended?.(), 20); }
      pause() {} removeAttribute() {} load() {}
    }
    Object.defineProperty(window, "Audio", { value: SilentAudio });
  });
  await page.route("**/api/providers/status", route => route.fulfill({ json: { providers: [{ name: "stepfun", connected: true, defaultModel: "step-3.5-flash", capabilities: ["text"] }], degradations: [] } }));
  let cloneRequests = 0;
  await page.route("**/api/speech/cloned-voices", route => {
    cloneRequests++;
    return route.fulfill({ status: 404, body: "Not Found" });
  });
  await page.route("**/api/speech", route => {
    expect(route.request().postDataJSON()).toEqual({
      text: "你好，我是 Vivic。这是当前音色的试听，你可以调整语速和音量。", voice: "wenrounvsheng", speed: 1.2,
    });
    return route.fulfill({ contentType: "audio/mpeg", body: Buffer.from("ID3-TEST") });
  });
  await page.goto("/control"); await openVoice(page, true); await expect(page.locator("[data-vivic-output-choose]")).toBeEnabled();
  await expect(page.getByRole("switch", { name: "语音回复", exact: true })).not.toBeChecked();
  await page.getByRole("switch", { name: "语音回复", exact: true }).check();
  await expect(page.locator("[data-vivic-voice-clone]")).toHaveCount(0);
  await expect(page.getByText("复刻音色", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("音色", { exact: true })).toContainText("温柔女声");
  expect(cloneRequests).toBe(0);
  await page.locator("[data-vivic-output-choose]").click(); await expect(page.locator("[data-vivic-audio-output]")).toContainText("已指定设备");
  await page.getByRole("region", { name: "语音偏好", exact: true }).screenshot({ path: path.resolve(process.cwd(), "../../evidence/settings/voice-cloning-removed.png") });
  await expect(page.getByRole("switch", { name: "语音回复", exact: true })).toBeChecked();
  await page.locator("[data-vivic-tts-preview]").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __audioDeviceTest: { plays: number } }).__audioDeviceTest.plays)).toBe(1);
  await page.evaluate(() => { (window as unknown as { __audioDeviceTest: { unavailable: boolean } }).__audioDeviceTest.unavailable = true; });
  await page.locator("[data-vivic-tts-preview]").click(); await expect(page.locator("[data-vivic-tts-note]")).toContainText("本次没有播放");
  expect(cloneRequests).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __audioDeviceTest: { plays: number; microphone: number; picks: number } }).__audioDeviceTest)).toMatchObject({ plays: 1, microphone: 0, picks: 1 });
});
