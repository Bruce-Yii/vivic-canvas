import { expect, test } from "@playwright/test";
import { testCards } from "../../src/cards/__tests__/fixtures";
import { activeCanvasId, controlDispatch } from "./helpers1";

// TEST / DEMO only: these cards are dispatched fixtures, not fetched weather or data.
test("TEST data cards: all seven registry types, real charts, row highlight, and reconnect", async ({ page, context }) => {
  await page.goto("/control");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  const canvasId = await activeCanvasId(page);
  const display = await context.newPage();
  const sizeWarnings: string[] = [];
  const errors: string[] = [];
  display.on("console", message => {
    if (/width.*height.*chart|greater than 0|NaN.*attribute/i.test(message.text())) sizeWarnings.push(message.text());
  });
  display.on("pageerror", error => errors.push(error.message));
  await display.goto(`/display?canvasId=${encodeURIComponent(canvasId)}`);
  const cards = [
    // The missing-definition fixture belongs to the import-host tests. These
    // seven classic cards must remain creatable without installing a package.
    ...Object.values(testCards).filter(card => card.type !== "ExtensionCard"),
    ...(["bar", "pie"] as const).map(chartKind => ({
      ...testCards.ChartCard,
      id: `TEST-chart-${chartKind}`,
      displayProps: {
        ...testCards.ChartCard.displayProps,
        chartKind,
        points: [{ x: "TEST A", y: 2 }, { x: "TEST B", y: 6 }],
      },
    })),
  ];
  await controlDispatch(page, "TEST-data-cards", canvasId, [
    { type: "stage.awaken" },
    ...cards.map(card => ({ type: "card.create", card })),
    { type: "canvas.fit" },
  ]);
  await expect(display.locator("[data-card-id]")).toHaveCount(9);
  const weather = display.locator('[data-card-id="TEST-weather"]');
  await expect(weather.locator('[data-aui="text"]')).toHaveText("-3.5°C");
  await expect(weather.locator("svg.lucide[aria-label]")).toHaveCount(1);
  const table = display.locator('[data-card-id="TEST-table"]');
  await expect(table.locator('[data-aui="table"] tbody tr')).toHaveCount(3);
  await expect(table.locator("tbody tr").nth(0).locator("td").nth(2)).toHaveText("false");
  await expect(table.locator("tbody tr").nth(1).locator("td").nth(1)).toHaveText("-5.25");
  await expect(display.locator(".recharts-line-curve")).toHaveCount(1);
  await expect(display.locator(".recharts-bar-rectangle")).toHaveCount(2);
  await expect(display.locator(".recharts-pie-sector")).toHaveCount(2);
  await expect(display.locator("[data-card-id] button:not(.vivic-display-card-actions button)")).toHaveCount(0);
  await expect(display.locator(".vivic-display-card-actions button")).toHaveCount(18);
  await expect(display.locator("[data-card-id]").filter({ hasText: "TEST hidden location" })).toHaveCount(0);

  await controlDispatch(page, "TEST-row-highlight", canvasId, [
    { type: "card.highlight", targetId: "TEST-table", itemId: "row:2", durationMs: 10000 },
  ]);
  await expect(table.locator("tbody [data-vivic-highlighted]")).toHaveCount(1);
  await expect(table.locator('[data-vivic-row-id="row:2"]')).toHaveAttribute("data-vivic-highlighted", "true");
  await controlDispatch(page, "TEST-row-highlight-move", canvasId, [
    { type: "card.highlight", targetId: "TEST-table", itemId: "row:3", durationMs: 10000 },
  ]);
  await expect(table.locator('[data-vivic-row-id="row:2"]')).not.toHaveAttribute("data-vivic-highlighted");
  await expect(table.locator('[data-vivic-row-id="row:3"]')).toHaveAttribute("data-vivic-highlighted", "true");

  const line = display.locator('[data-card-id="TEST-chart"] [data-vivic-chart]');
  await line.evaluate(element => { element.style.width = "128px"; });
  await expect(line.locator("svg.recharts-surface")).toHaveAttribute("width", "128");
  await line.evaluate(element => { element.style.width = "0px"; });
  await line.evaluate(element => { element.style.width = "256px"; });
  await expect(line.locator("svg.recharts-surface")).toHaveAttribute("width", "256");

  await controlDispatch(page, "TEST-negative-pie", canvasId, [
    { type: "card.update", targetId: "TEST-chart-pie", displayProps: { points: [{ x: "TEST A", y: -2 }, { x: "TEST B", y: 6 }] } },
  ]);
  const pie = display.locator('[data-card-id="TEST-chart-pie"]');
  await expect(pie.locator(".recharts-pie-sector")).toHaveCount(0);
  await expect(pie.locator("tbody tr").nth(0).locator("td").nth(1)).toHaveText("-2");
  await expect(pie.locator("tbody tr").nth(1).locator("td").nth(1)).toHaveText("6");

  await display.reload();
  await expect(display.locator("[data-card-id]")).toHaveCount(9);
  await expect(pie.locator('[data-vivic-chart-fallback="negative-pie"]')).toBeVisible();
  await expect(weather.locator('[data-aui="text"]')).toHaveText("-3.5°C");
  expect(sizeWarnings).toEqual([]);
  expect(errors).toEqual([]);
  await display.close();
});
