import { expect, test, type Page } from "@playwright/test";
import { activeCanvasId, controlDispatch, gotoControl, gotoDisplay, todoCardRecord } from "./helpers1";

// Main thread runs this file against its own managed server. This file never
// requests microphone permission or starts audio.
const layout = (page: Page, cardId: string) => page.evaluate(id => {
  const state = (window as unknown as { __vivic?: { getState: () => {
    cards: Array<{ record: { id: string; layout: { x: number; y: number; pinned: boolean } } }>;
  } } }).__vivic?.getState();
  return state?.cards.find(c => c.record.id === id)?.record.layout;
}, cardId);
const drag = async (page: Page, cardId: string) => {
  const box = await page.locator(`[data-card-id="${cardId}"]`).boundingBox(); expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width - 14, box!.y + 14);
  await page.mouse.down(); await page.mouse.move(box!.x + box!.width + 90, box!.y + 95, { steps: 15 }); await page.mouse.up();
};

test("display drag persists through refresh; owner pin prevents movement and survives undo", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const control = await gotoControl(context), canvasId = await activeCanvasId(control);
    const display = await gotoDisplay(context, canvasId);
    await controlDispatch(control, "drag-seed", canvasId, [{ type: "stage.awaken" },
      { type: "card.create", card: todoCardRecord("drag-a", ["交互验证"]) }]);
    await expect(display.locator('[data-card-id="drag-a"]')).toBeVisible();
    const before = await layout(display, "drag-a");
    await drag(display, "drag-a");
    await expect.poll(() => layout(control, "drag-a")).not.toEqual(before);
    const moved = await layout(control, "drag-a");
    await expect.poll(() => layout(display, "drag-a")).toEqual(moved);
    await display.reload(); await expect.poll(() => layout(display, "drag-a")).toEqual(moved);
    const result = await control.evaluate(async () => {
      const modulePath = "/src/sync/browserRuntime.ts";
      const { getControlHost } = await import(/* @vite-ignore */ modulePath);
      return (await getControlHost()).setCardPinned("drag-a", true);
    });
    expect(result.ok).toBe(true);
    await expect.poll(async () => (await layout(display, "drag-a"))?.pinned).toBe(true);
    const pinned = await layout(display, "drag-a"); await drag(display, "drag-a");
    expect(await layout(control, "drag-a")).toEqual(pinned);
    await controlDispatch(control, "delete-drag", canvasId, [{ type: "card.delete", targetId: "drag-a" }]);
    // Observe the deletion before checking undo; the old card position can
    // otherwise satisfy the undo assertion before either patch has arrived.
    await expect(display.locator('[data-card-id="drag-a"]')).toHaveCount(0);
    await control.evaluate(async () => {
      const modulePath = "/src/sync/browserRuntime.ts";
      const { getControlHost } = await import(/* @vite-ignore */ modulePath);
      (await getControlHost()).undo();
    });
    await expect.poll(() => layout(display, "drag-a")).toEqual(pinned);
    await expect(display.locator('[data-vivic-canvas-settings]')).toHaveCount(0);
    await control.close(); await display.reload();
    await expect.poll(() => layout(display, "drag-a")).toEqual(pinned);
  } finally { await context.close(); }
});

test("60 cards fit an 800×600 display while a pinned card keeps its world coordinates", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  try {
    const control = await gotoControl(context), canvasId = await activeCanvasId(control);
    const display = await gotoDisplay(context, canvasId);
    await controlDispatch(control, "wake-sixty", canvasId, [{ type: "stage.awaken" }]);
    for (let offset = 0; offset < 60; offset += 10) {
      await controlDispatch(control, `sixty-${offset}`, canvasId, Array.from({ length: 10 }, (_, index) => {
        const card = todoCardRecord(`load-${offset + index}`, [`任务 ${offset + index + 1}`]);
        if (offset + index === 0) card.layout = { ...card.layout, x: -100, y: -100, pinned: true };
        return { type: "card.create", card };
      }));
    }
    await expect(display.locator("[data-card-id]")).toHaveCount(60, { timeout: 15000 });
    await controlDispatch(control, "fit-sixty", canvasId, [{ type: "canvas.fit" }]);
    await expect.poll(async () => display.locator("[data-card-id]").evaluateAll(nodes => nodes.every(node => {
      const box = node.getBoundingClientRect();
      return box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
    }))).toBe(true);
    expect(await layout(display, "load-0")).toMatchObject({ x: -100, y: -100, pinned: true });
  } finally { await context.close(); }
});
