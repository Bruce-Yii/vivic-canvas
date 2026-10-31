import { expect, test } from "@playwright/test";
import { activeCanvasId, sendCommand } from "./helpers1";

test("search fixture sources become minimal linked cards and survive refresh", async ({ page, context }) => {
  await page.goto("/control");
  await expect(page.locator('[data-vivic-control]')).toHaveAttribute("data-vivic-owner", "owner");
  await page.route("**/api/intent", async route => {
    const payload = route.request().postDataJSON();
    const stamp = new Date().toISOString();
    const cards = ["React Flow", "tldraw", "Excalidraw"].map((title, i) => ({
      id: `search-fixture-${i}`, type: "SearchResultCard", variant: "minimal",
      displayProps: { title: `TEST · ${title}`, summary: "测试检索摘要。", sourceLabel: "TEST · example.com" },
      sourceData: { query: payload.text, fixture: true },
      sources: [{ title, url: `https://example.com/project/${i}`, fetchedAt: stamp, provider: "test-fixture", readFullPage: false }],
      layout: { x: i * 308, y: 0, width: 288, height: 180, pinned: false },
      metadata: { createdAt: stamp, updatedAt: stamp },
    }));
    await route.fulfill({ json: { kind: "envelope", usedProvider: "search", envelope: {
      schemaVersion: "0.6", requestId: "search-fixture-request", canvasId: payload.canvasContext.canvasId,
      spokenText: "找到3条来源", actions: [{ type: "stage.awaken" }, ...cards.map(card => ({ type: "card.create", card })), { type: "canvas.fit" }],
    } } });
  });
  const id = await activeCanvasId(page);
  const display = await context.newPage(); await display.goto(`/display?canvasId=${id}`);
  await sendCommand(page, "查三个开源画布库");
  await expect(display.locator('[data-vivic-source-link]')).toHaveCount(3);
  await expect(display.locator('[data-vivic-source-link]').nth(1)).toHaveAttribute("href", "https://example.com/project/1");
  await expect(display.locator('[data-card-id]')).toHaveCount(3);
  await display.reload();
  await expect(display.locator('[data-vivic-source-link]')).toHaveCount(3);
  const sources = await display.evaluate(() => (window.__vivic!.getState() as { cards: Array<{ record: { sources: unknown[] } }> }).cards.map(c => c.record.sources));
  expect(sources.every(list => list.length === 1)).toBe(true);
  await display.close();
});

test("unavailable search leaves the canvas empty and reports the failure", async ({ page }) => {
  await page.goto("/control");
  await expect(page.locator('[data-vivic-control]')).toHaveAttribute("data-vivic-owner", "owner");
  await page.route("**/api/intent", route => route.fulfill({ json: {
    kind: "error", usedProvider: "search", message: "联网查询暂不可用：搜索源免费额度暂时受限，请稍后重试。",
  } }));
  await sendCommand(page, "搜索React画布库");
  await expect(page.locator('[data-vivic-command-feedback]')).toContainText("免费额度暂时受限");
  const count = await page.evaluate(() => (window.__vivic!.getState() as { cards: unknown[] }).cards.length);
  expect(count).toBe(0);
});
