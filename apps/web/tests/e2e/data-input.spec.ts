import { expect, test } from "@playwright/test";
import path from "node:path";
import { createDataClient } from "../../../local-api/src/data/index";
import { runIntent } from "../../../local-api/src/intent/pipeline";
import { CredentialStore } from "../../../local-api/src/credentials";
import { activeCanvasId, sendCommand } from "./helpers1";

test.use({ video: { mode: "on", size: { width: 1440, height: 900 } } });

test.beforeEach(async ({ page, context }) => {
  // TEST network fixtures run the real intent/data code; no model, mic or playback.
  await context.addInitScript(() => {
    HTMLMediaElement.prototype.play = async () => { throw new Error("TEST audio is disabled"); };
    navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST microphone is disabled"); };
  });
  const location = { id: 1796236, name: "上海", latitude: 31.22, longitude: 121.46, country: "中国",
    country_code: "CN", admin1: "上海市", timezone: "Asia/Shanghai", feature_code: "PPLA" };
  const data = createDataClient({ fetchImpl: (async input => {
    const url = new URL(String(input));
    const value = url.hostname.startsWith("geocoding")
      ? { results: url.searchParams.get("name")!.includes(",") ? [location] : [location, { ...location, id: 42, admin1: "浙江" }] }
      : { latitude: 31.25, longitude: 121.5, utc_offset_seconds: 0,
        current_units: { time: "unixtime", temperature_2m: "°C" },
        current: { time: Math.floor(Date.now() / 1000), interval: 900, temperature_2m: 22.4, weather_code: 2, is_day: 1 } };
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  }) as typeof fetch });
  await page.route("**/api/intent", async route => {
    const result = await runIntent(route.request().postDataJSON(), { data, credentials: new CredentialStore(),
      stepfun: { baseUrl: "https://unit.test", fetchImpl: async () => { throw new Error("TEST must not use a model"); } } });
    await route.fulfill({ json: result });
  });
  await page.goto("/control");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
});

test("上海天气 directly selects the verified municipality and creates sourced weather", async ({ page, context }, testInfo) => {
  const evidence = path.resolve(process.cwd(), "../../evidence/manual-feedback/data-input", testInfo.project.name || "chromium");
  const display = await context.newPage();
  await display.goto(`/display?canvasId=${await activeCanvasId(page)}`);
  await sendCommand(page, "上海天气");
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText("已显示上海当前天气");
  await expect(display.locator(".vivic-card")).toHaveCount(1);
  await expect(display.locator('.vivic-card [data-aui="text"]')).toHaveText("22.4°C");
  await expect(page.locator("[data-vivic-data-suggestions]")).toHaveCount(0);
  await expect(display.locator("[data-vivic-weather-source]")).toHaveCount(1);
  await display.reload();
  await expect(display.locator('.vivic-card [data-aui="text"]')).toHaveText("22.4°C");
  await display.screenshot({ path: path.join(evidence, "TEST-weather-result.png") });
  const video = display.video(); await display.close();
  if (video) await video.saveAs(path.join(evidence, "TEST-weather-flow.webm"));
});

test("table request creates an empty table immediately and fills the same card from a bare numeric reply", async ({ page, context }, testInfo) => {
  const evidence = path.resolve(process.cwd(), "../../evidence/manual-feedback/data-input", testInfo.project.name || "chromium");
  const display = await context.newPage();
  await display.goto(`/display?canvasId=${await activeCanvasId(page)}`);
  await sendCommand(page, "给我创建一个表格");
  await expect(page.locator("[data-vivic-command-feedback]")).toContainText("已创建空表格");
  await expect(display.locator("[data-vivic-data-table]")).toHaveCount(1);
  await expect(display.locator("[data-vivic-data-table] tbody tr")).toHaveCount(0);
  await display.screenshot({ path: path.join(evidence, "TEST-empty-table.png") });
  const originalId = await display.locator("[data-card-id]").getAttribute("data-card-id");
  await sendCommand(page, "周一3，周二5，周三4");
  await expect(display.locator("[data-vivic-data-table] tbody tr")).toHaveCount(3);
  await expect(display.locator("[data-card-id]")).toHaveCount(1);
  expect(await display.locator("[data-card-id]").getAttribute("data-card-id")).toBe(originalId);
  await expect(display.locator("[data-vivic-data-table] tbody tr").nth(1)).toHaveText("周二5");
  await expect(page.locator("[data-vivic-command-cancel]")).toHaveCount(0);
  await display.screenshot({ path: path.join(evidence, "TEST-table-result.png") });
  const video = display.video(); await display.close();
  if (video) await video.saveAs(path.join(evidence, "TEST-table-flow.webm"));
});

test("a new command after a data question is independent; errors also reach Display", async ({ page, context }) => {
  const display = await context.newPage();
  await display.goto(`/display?canvasId=${await activeCanvasId(page)}`);
  await sendCommand(page, "天气");
  await expect(page.locator("[data-vivic-command-feedback]")).toContainText("请直接说城市名");
  await sendCommand(page, "加待办：TEST 完成测试");
  await expect(display.locator(".vivic-card")).toContainText("TEST 完成测试");
  await expect(page.locator("[data-vivic-data-suggestions]")).toHaveCount(0);
  await page.route("**/api/intent", route => route.fulfill({ json: { kind: "error", message: "TEST 天气查询暂时不可用，请稍后重试。" } }));
  await sendCommand(page, "上海,上海市天气");
  await expect(display.locator("[data-vivic-subtitle]")).toContainText("TEST 天气查询暂时不可用");
  await expect(display.locator("[data-vivic-thinking]")).toHaveCount(0);
  await display.close();
});
