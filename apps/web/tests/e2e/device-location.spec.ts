import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { createDataClient, weatherCardFields } from "../../../local-api/src/data/index";
import { runIntent } from "../../../local-api/src/intent/pipeline";
import { CredentialStore } from "../../../local-api/src/credentials";
import { activeCanvasId, sendCommand, openLocation } from "./helpers1";
import { waitForDisplayRuntime } from "./helpers";

// TEST network fixtures run the real intent/data code. The browser position is
// Playwright's emulated geolocation; no real device position, model, mic or audio.
const HANGZHOU = { latitude: 30.274123, longitude: 120.155187, accuracy: 20 };
const BEIJING = { latitude: 39.908712, longitude: 116.397481, accuracy: 20 };
const providerCalls: URL[] = [];

test.use({ permissions: ["geolocation"], geolocation: HANGZHOU });

test.beforeEach(async ({ page, context }) => {
  providerCalls.length = 0;
  await context.addInitScript(() => {
    HTMLMediaElement.prototype.play = async () => { throw new Error("TEST audio is disabled"); };
    navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST microphone is disabled"); };
  });
  const data = createDataClient({ fetchImpl: (async input => {
    const url = new URL(String(input)); providerCalls.push(url);
    const north = Number(url.searchParams.get("lat") ?? url.searchParams.get("latitude")) > 35;
    const value = url.hostname === "photon.komoot.io"
      ? { features: [{ properties: { name: "TEST 酒店", city: north ? "北京市" : "杭州市", state: north ? undefined : "浙江省", country: "中国", countrycode: "CN" } }] }
      : { latitude: 30.25, longitude: 120.125, utc_offset_seconds: 0, current_units: { time: "unixtime", temperature_2m: "°C" },
        current: { time: Math.floor(Date.now() / 1000), interval: 900, temperature_2m: north ? 9.5 : 18.5, weather_code: north ? 61 : 2, is_day: 1 } };
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  }) as typeof fetch });
  await page.route("**/api/intent", async route => {
    const result = await runIntent(route.request().postDataJSON(), { data, credentials: new CredentialStore(),
      stepfun: { baseUrl: "https://unit.test", fetchImpl: async () => { throw new Error("TEST must not use a model"); } } });
    await route.fulfill({ json: result });
  });
  await page.route("**/api/weather/here", async route => {
    const weather = await data.weatherHere(route.request().postDataJSON().deviceLocation);
    if (weather.kind !== "weather") return route.fulfill({ json: { kind: "clarify", message: weather.message } });
    const { spokenText: _spoken, ...fields } = weatherCardFields(weather);
    await route.fulfill({ json: { kind: "weather", ...fields } });
  });
  await page.goto("/control");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
});

const weatherRecord = (page: Page) => page.evaluate(() => {
  const state = (window as unknown as { __vivic: { getState: () => { cards: Array<{ record: Record<string, any> }> } } }).__vivic.getState();
  const card = state.cards.find(entry => entry.record.type === "WeatherCard")?.record;
  return card && { id: card.id, layout: card.layout, displayProps: card.displayProps, aliases: card.metadata.aliases,
    location: card.sourceData.location, basis: card.sourceData.locationBasis };
});

test("weather follows the device: asked without a city, then refreshed in place after moving", async ({ page, context }, testInfo) => {
  const evidence = path.resolve(process.cwd(), "../../evidence/device-location", testInfo.project.name || "chromium");
  const display = await context.newPage();
  const canvasId = await activeCanvasId(page);
  await display.goto(`/display?canvasId=${canvasId}`);
  await waitForDisplayRuntime(display, canvasId);

  const asked = page.waitForRequest("**/api/intent");
  await sendCommand(page, "今天天气如何");
  // Only a fix rounded to ~1 km leaves the page.
  expect((await asked).postDataJSON().deviceLocation).toMatchObject({ latitude: 30.27, longitude: 120.16, accuracyM: 20 });
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText("已按当前位置显示杭州市天气");
  await expect(display.locator('.vivic-card [data-aui="text"]')).toHaveText("18.5°C", { timeout: 15_000 });
  await expect(page.locator("[data-vivic-location]")).toHaveAttribute("data-status", "watching");
  await expect(page.locator("[data-vivic-location-status]")).toContainText("精度约 20 米");
  const first = await weatherRecord(page);
  expect(first).toMatchObject({ basis: "device-geolocation", aliases: ["杭州市"], location: { name: "杭州市", latitude: 30.27 } });
  await display.screenshot({ path: path.join(evidence, "TEST-hangzhou.png") });

  // Moving ~1100 km: the open watch reports it and the same card updates.
  const refreshed = page.waitForRequest("**/api/weather/here");
  const refreshedResponse = page.waitForResponse("**/api/weather/here");
  await context.setGeolocation(BEIJING);
  expect((await refreshed).postDataJSON().deviceLocation).toMatchObject({ latitude: 39.91, longitude: 116.4 });
  expect(await (await refreshedResponse).json()).toMatchObject({ kind: "weather", displayProps: { tempC: 9.5 } });
  // A request event precedes JSON consumption, the owner's commit and its
  // persisted snapshot. Wait for each actual state under the WebGL workload.
  await expect.poll(() => weatherRecord(page), { timeout: 15_000 }).toMatchObject({ displayProps: { tempC: 9.5 } });
  await expect(display.locator('.vivic-card [data-aui="text"]')).toHaveText("9.5°C", { timeout: 15_000 });
  const second = await weatherRecord(page);
  expect(second).toMatchObject({ id: first!.id, layout: first!.layout, aliases: ["北京市"], location: { name: "北京市", latitude: 39.91 },
    displayProps: { tempC: 9.5, conditionIcon: "rain" } });
  // The card persists and Display keeps it after a reload.
  await display.reload();
  await waitForDisplayRuntime(display, canvasId);
  await expect(display.locator('.vivic-card [data-aui="text"]')).toHaveText("9.5°C", { timeout: 15_000 });
  await display.screenshot({ path: path.join(evidence, "TEST-beijing-refreshed.png") });
  expect(JSON.stringify(second)).not.toContain("TEST 酒店");
  expect(providerCalls.every(url => !/ipinfo/.test(url.hostname))).toBe(true);

  // Location refresh and Display reload must not prevent later card sync.
  const ownerVersion = () => page.evaluate(id => {
    const snapshot = window.__vivicControl!.snapshot() as { canvases: Array<{ id: string; version: number }> };
    return snapshot.canvases.find(canvas => canvas.id === id)!.version;
  }, canvasId);
  const beforeTodoVersion = await ownerVersion();
  await sendCommand(page, "加待办：TEST 定位后其他指令正常");
  await expect.poll(() => page.evaluate(() => (window.__vivic!.getState() as { cards: unknown[] }).cards.length), { timeout: 15_000 }).toBe(2);
  await expect.poll(ownerVersion, { timeout: 15_000 }).toBeGreaterThan(beforeTodoVersion);
  await expect(display.locator(".vivic-card")).toHaveCount(2, { timeout: 15_000 });
  const committedVersion = await ownerVersion();
  await expect.poll(() => display.evaluate(() => (window.__vivic!.status!() as { version: number }).version), { timeout: 15_000 }).toBeGreaterThanOrEqual(committedVersion);
});

test("我在哪里 answers from the device position and reaches Display", async ({ page, context }) => {
  const display = await context.newPage();
  await display.goto(`/display?canvasId=${await activeCanvasId(page)}`);
  const asked = page.waitForRequest("**/api/intent");
  await sendCommand(page, "我在哪里");
  expect((await asked).postDataJSON().deviceLocation).toMatchObject({ latitude: 30.27, longitude: 120.16 });
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText("你现在在杭州市，浙江省附近");
  // A place answer is spoken and shown on Display, never drawn as a card.
  await expect.poll(() => display.evaluate(() => {
    const state = (window as unknown as { __vivic: { getState: () => { subtitle: { text: string } | null } } }).__vivic.getState();
    return state.subtitle?.text ?? null;
  })).toBe("你现在在杭州市，浙江省附近");
  await expect(display.locator(".vivic-card")).toHaveCount(0);
});

test("turning location off falls back without prompting again", async ({ page }) => {
  await expect(page.locator("[data-vivic-location]")).toHaveAttribute("data-status", "watching");
  await openLocation(page);
  await page.locator("[data-vivic-location-toggle]").click();
  await expect(page.locator("[data-vivic-location]")).toHaveAttribute("data-status", "off");
  const asked = page.waitForRequest("**/api/intent");
  await sendCommand(page, "天气怎么样");
  expect((await asked).postDataJSON()).not.toHaveProperty("deviceLocation");
  await expect(page.locator("[data-vivic-location]")).toHaveAttribute("data-status", "off");
});
