import { expect, test, type BrowserContext } from "@playwright/test";
import { testCards } from "../../src/cards/__tests__/fixtures";
import type { CardRecord } from "../../src/contracts";
import { activeCanvasId, controlDispatch, showChat, openPreferences } from "./helpers1";

const runtimeErrors = new WeakMap<BrowserContext, string[]>();
test.beforeEach(({ context }) => {
  const errors: string[] = []; runtimeErrors.set(context, errors);
  const watch = (page: import("@playwright/test").Page) => {
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error" && /Cannot update a component|ResizeObserver loop|trying to drag a node that is not initialized|NaN.*attribute/i.test(message.text())) errors.push(message.text());
    });
  };
  context.pages().forEach(watch); context.on("page", watch);
});
test.afterEach(({ context }) => { expect(runtimeErrors.get(context)).toEqual([]); });

// TEST fixtures only: verifies cross-window controls, real renderer geometry,
// and attribution without contacting a model, playing audio or taking a mic.
test("TEST weather source attribution is available on demand without adding a footer", async ({ page, context }) => {
  await page.goto("/control");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  const canvasId = await activeCanvasId(page);
  const display = await context.newPage();
  await display.goto(`/display?canvasId=${canvasId}`);
  await controlDispatch(page, "TEST-weather-attribution", canvasId, [
    { type: "stage.awaken" },
    { type: "card.create", card: { ...testCards.WeatherCard, sources: [{ title: "TEST GeoNames", url: "https://geocoding-api.open-meteo.com/v1/search", fetchedAt: "2026-10-15T08:00:00.000Z", provider: "open-meteo/geocoding", readFullPage: false }, { title: "TEST Open-Meteo", url: "https://api.open-meteo.com/v1/forecast", fetchedAt: "2026-10-15T08:00:00.000Z", provider: "open-meteo/forecast", readFullPage: false }] } },
  ]);
  const card = display.locator('[data-card-id="TEST-weather"]');
  await expect(card.locator('[data-aui="text"]')).toHaveText("-3.5°C");
  await expect(display.locator("[data-vivic-weather-attribution]")).toHaveCount(0);
  const source = card.locator("[data-vivic-weather-source]");
  await expect(source).toHaveAttribute("href", "https://open-meteo.com/en/licence");
  await source.hover();
  const detail = display.locator("[data-vivic-weather-attribution]");
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("link", { name: "Open-Meteo", exact: true })).toHaveAttribute("href", "https://open-meteo.com/");
  await expect(detail.getByRole("link", { name: "GeoNames", exact: true })).toHaveAttribute("href", "https://www.geonames.org/");
  await expect(detail.getByRole("link", { name: "CC BY 4.0", exact: true })).toHaveAttribute("href", "https://creativecommons.org/licenses/by/4.0/");
  await expect(detail).toContainText("映射为图标");
  await display.mouse.move(1, 1);
  await expect(detail).toHaveCount(0);
  await expect(card.locator('[data-aui="text"]')).toHaveText("-3.5°C");
  await display.close();
});

test.describe("TEST scheduled theme", () => {
  test.use({ timezoneId: "Asia/Shanghai" });
  test("configured local time range switches both background and cards at its minute boundary", async ({ page, context }) => {
    const fixed = new Date("2026-10-15T06:59:20+08:00");
    await page.clock.install({ time: fixed });
    await page.goto("/control");
    await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
    const canvasId = await activeCanvasId(page);
    const display = await context.newPage();
    await display.clock.install({ time: fixed });
    await display.goto(`/display?canvasId=${canvasId}`);
    await controlDispatch(page, "TEST-theme-clock", canvasId, [
      { type: "stage.awaken" }, { type: "card.create", card: testCards.NoteCard },
    ]);
    // New installs default to dark (2026-10-17); the day schedule belongs to 自动.
    await openPreferences(page, true);
    await page.getByRole("radio", { name: "自动", exact: true }).click();
    await page.getByLabel("白天开始时间", { exact: true }).fill("06:00");
    await page.getByLabel("白天结束时间", { exact: true }).fill("07:00");
    const stage = display.locator("[data-vivic-stage]");
    await expect(stage).toHaveAttribute("data-vivic-theme", "light");
    await expect(display.locator(".react-flow")).toHaveClass(/light/);
    await Promise.all([page.clock.fastForward(61_000), display.clock.fastForward(61_000)]);
    await expect(stage).toHaveAttribute("data-vivic-theme", "dark");
    await expect(display.locator(".react-flow")).toHaveClass(/dark/);
    await page.getByRole("radio", { name: "浅色", exact: true }).click();
    await expect(stage).toHaveAttribute("data-vivic-theme", "light");
    await page.reload();
    await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
    await openPreferences(page, true);
    await expect(page.getByRole("radio", { name: "浅色", exact: true })).toBeChecked();
    await openPreferences(page, true);
    await page.getByRole("radio", { name: "自动", exact: true }).click();
    await expect(page.getByLabel("白天开始时间", { exact: true })).toHaveValue("06:00");
    await expect(page.getByLabel("白天结束时间", { exact: true })).toHaveValue("07:00");
    await expect(stage).toHaveAttribute("data-vivic-theme", "dark");
    await display.close();
  });
});

test("TEST note expand/collapse preserves content, handles ambiguity, and stays separate from focus", async ({ page, context }) => {
  // Force the existing in-browser rule path, so this test needs no model or key.
  await page.route("**/api/intent", route => route.abort("failed"));
  await page.goto("/control");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  const canvasId = await activeCanvasId(page);
  const display = await context.newPage();
  await display.goto(`/display?canvasId=${canvasId}`);
  const text = Array.from({ length: 6 }, (_, i) => `TEST 第${i + 1}段：${"原文数据完整保留".repeat(6)}`).join("\n");
  const note = { ...testCards.NoteCard, id: "TEST-density-note", displayProps: { text }, sourceData: { original: text } };
  await controlDispatch(page, "TEST-note-density-seed", canvasId, [
    { type: "stage.awaken" }, { type: "card.create", card: note },
    { type: "card.create", card: testCards.ChartCard }, { type: "canvas.fit" },
  ]);
  const rendered = display.locator('[data-card-id="TEST-density-note"] [data-vivic-note-variant]');
  await expect(rendered).toHaveAttribute("data-vivic-note-variant", "minimal");
  const submit = async (text: string) => {
    await showChat(page);
    await page.locator("[data-vivic-command-input]").fill(text);
    await page.locator("[data-vivic-command-send]").click();
  };
  await submit("展开这张便笺");
  await expect(rendered).toHaveAttribute("data-vivic-note-variant", "expanded");
  await expect(rendered).toHaveText(text);
  const expanded = await display.locator('[data-card-id="TEST-density-note"]').boundingBox();
  await submit("收起便笺");
  await expect(rendered).toHaveAttribute("data-vivic-note-variant", "minimal");
  await expect.poll(async () => (await display.locator('[data-card-id="TEST-density-note"]').boundingBox())?.height ?? Infinity).toBeLessThan(expanded!.height);
  const state = await page.evaluate(() => (window as unknown as { __vivic: { getState: () => { cards: Array<{ record: CardRecord }> } } }).__vivic.getState());
  expect(state.cards.find(entry => entry.record.id === "TEST-density-note")!.record.sourceData).toEqual({ original: text });
  await controlDispatch(page, "TEST-note-density-second", canvasId, [
    { type: "card.create", card: { ...testCards.NoteCard, id: "TEST-second-note", displayProps: { text: "TEST second" } } },
  ]);
  await submit("展开便笺");
  await expect(page.locator("[data-vivic-clarify]")).toBeVisible();
  await expect(display.locator('[data-vivic-note-variant="expanded"]')).toHaveCount(0);
  await page.locator("[data-vivic-clarify-candidate]").first().click();
  await expect(display.locator('[data-vivic-note-variant="expanded"]')).toHaveCount(1);
  await expect(display.locator("[data-focused]")).toHaveCount(0);
  await display.reload();
  await expect(display.locator('[data-vivic-note-variant="expanded"]')).toHaveCount(1);
  await display.close();
});
