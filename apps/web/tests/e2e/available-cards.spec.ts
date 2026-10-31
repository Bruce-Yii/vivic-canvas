import { expect, test } from "@playwright/test";
import type { ProvidersStatusResponse } from "../../src/ai/api";

test("compact connections follow the selected model and availability without restoring the removed catalog or creating cards", async ({ page, context }) => {
  // Isolated TEST status fixtures; no model calls, real location or microphone.
  await context.addInitScript(() => {
    localStorage.setItem("vivic.deviceLocation.v1", "off");
    localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", browserVoice: "" }));
  });
  await context.route("https://huggingface.co/**", route => route.abort());
  let offline = false, intents = 0;
  let status: ProvidersStatusResponse = { activeProvider: "stepfun", providers: [
    { name: "stepfun", connected: true, capabilities: ["structured", "chat"], defaultModel: "TEST-step-cards", models: ["TEST-step-cards"] },
    { name: "gpt", connected: true, capabilities: ["structured", "chat"], defaultModel: "TEST-gpt-cards", models: ["TEST-gpt-cards"] },
  ], degradations: [] };
  await page.route("**/api/providers/status", route => offline ? route.abort() : route.fulfill({ json: status }));
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/intent") intents++; });
  await page.goto("/control");
  await expect(page.locator("[data-vivic-available-cards],[data-vivic-store-link]")).toHaveCount(0);
  await expect(page.locator("[data-vivic-ai-badge]")).toHaveText("已连接");
  await page.locator("[data-vivic-connection-options] > summary").click();
  await expect(page.getByLabel("当前推理模型", { exact: true })).toHaveText("TEST-step-cards");

  status = { ...status, activeProvider: "gpt" };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByLabel("当前推理模型", { exact: true })).toHaveText("TEST-gpt-cards");
  status = { ...status, providers: status.providers.map(provider => provider.name === "gpt" ? { ...provider, connected: false } : provider) };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("[data-vivic-ai-badge]")).toHaveText("未连接");
  await expect(page.getByLabel("当前推理模型", { exact: true })).toHaveCount(0);
  offline = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("[data-vivic-ai-badge]")).toHaveText("服务不可用");
  await expect(page.locator("[data-vivic-ai-note]")).toContainText("内置文字指令仍可使用");
  expect(await page.evaluate(() => window.__vivic!.getState().cards.length)).toBe(0);
  expect(intents).toBe(0);
});
