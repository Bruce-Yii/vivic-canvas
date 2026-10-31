import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { openVoice, showChat } from "./helpers1";

// Permission prompts and streams are synthetic; no physical microphone or
// actual device position is used in these browser checks.
const installDevices = async (context: BrowserContext, permission: "prompt" | "denied" = "prompt", off = false) => {
  await context.addInitScript(({ permission, off }) => {
    const state = { location: 0, microphone: 0, stopped: 0 };
    Object.assign(window, { __startupPermissions: state });
    if (off) {
      localStorage.setItem("vivic.deviceLocation.v1", "off");
      localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", browserVoice: "" }));
    }
    Object.defineProperty(navigator, "permissions", { configurable: true, value: {
      query: async () => ({ state: permission }),
    } });
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
      watchPosition: (success: PositionCallback) => {
        state.location++;
        queueMicrotask(() => success({ coords: { latitude: 30.27, longitude: 120.16, accuracy: 20 }, timestamp: Date.now() } as GeolocationPosition));
        return 1;
      }, clearWatch: () => {},
    } });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: async () => { state.microphone++; return { getTracks: () => [{ stop: () => state.stopped++ }] }; },
      enumerateDevices: async () => [],
    } });
    HTMLMediaElement.prototype.play = async () => { throw new Error("TEST playback disabled"); };
  }, { permission, off });
  await context.route("https://huggingface.co/**", route => route.abort());
  await context.route("**/api/providers/status", route => route.fulfill({ json: {
    providers: [{ name: "stepfun", connected: false, capabilities: [] }], degradations: [],
  } }));
};
const counts = (page: Page) => page.evaluate(() => (window as unknown as {
  __startupPermissions: { location: number; microphone: number; stopped: number };
}).__startupPermissions);

test("opening the owner requests both permissions once, releases the mic, and leaves read-only windows alone", async ({ page, context }) => {
  await installDevices(context);
  await page.goto("/");
  await expect.poll(() => counts(page)).toEqual({ location: 1, microphone: 1, stopped: 1 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await openVoice(page);
  await expect(page.getByRole("switch", { name: "语音输入", exact: true })).toBeChecked();
  await expect(page.locator("[data-vivic-location]")).toHaveAttribute("data-status", "watching");
  await expect(page.getByRole("switch", { name: "唤醒 Vivic", exact: true })).not.toBeChecked();
  expect(await counts(page)).toEqual({ location: 1, microphone: 1, stopped: 1 });
  const reader = await context.newPage(); await reader.goto("/control");
  await expect(reader.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "readonly");
  expect(await counts(reader)).toEqual({ location: 0, microphone: 0, stopped: 0 });
  await reader.close();
});

test("denied permissions show recovery controls without retry loops or blocking text", async ({ page, context }) => {
  await installDevices(context, "denied"); await page.goto("/control");
  await openVoice(page);
  await expect(page.getByRole("region", { name: "语音偏好" })).toContainText("麦克风权限未开启");
  await expect(page.locator("[data-vivic-location]")).toHaveAttribute("data-status", "denied");
  await expect(page.getByRole("button", { name: "重新检查", exact: true })).toBeEnabled();
  await showChat(page);
  await expect(page.getByRole("textbox", { name: "指令输入" })).toBeEnabled();
  expect(await counts(page)).toEqual({ location: 0, microphone: 0, stopped: 0 });
});

test("explicitly disabled location and text-only input keep their saved choices", async ({ page, context }) => {
  await installDevices(context, "prompt", true); await page.goto("/control");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  await expect(page.locator("[data-vivic-location]")).toHaveAttribute("data-status", "off");
  await openVoice(page, true);
  await expect(page.getByLabel("语音输入服务")).toContainText("关闭");
  expect(await counts(page)).toEqual({ location: 0, microphone: 0, stopped: 0 });
});
