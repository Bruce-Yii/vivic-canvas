import { expect, test } from "@playwright/test";
import path from "node:path";
import {
  EVIDENCE1,
  activeCanvasId,
  controlDispatch,
  gotoControl,
  gotoDisplay,
} from "./helpers1";
import { countdownCard } from "./helpers";

/**
 * Phase 1.1 (BUG 1): cards created outside the visible viewport trigger a
 * one-shot smooth fit — three countdowns on an 800×600 display all become
 * visible without manual zoom. Runs in its own file before control.spec's
 * canvas-state reuse (fresh context regardless).
 */
test("P1.1: third countdown auto-fits into view on /display", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
  });
  const A = await gotoControl(context);
  const canvasId = await activeCanvasId(A);
  const B = await gotoDisplay(context, canvasId);

  // Direct command responses intentionally focus their newest card. Exercise
  // the separate overflow-fit path with owner creates that contain no focus.
  for (const [index, minutes] of [5, 6, 7].entries()) {
    const card = countdownCard();
    await controlDispatch(A, `auto-fit-${index}`, canvasId, [{ type: "stage.awaken" },
      { type: "card.create", card: { ...card, id: `auto-fit-timer-${index}`,
        sourceData: { ...card.sourceData, targetAt: new Date(Date.now() + minutes * 60_000).toISOString() } } }]);
    await expect(B.locator(".vivic-card")).toHaveCount(index + 1);
    // Auto-fit uses this Display's measured viewport rather than owner size.
    await expect.poll(() => B.evaluate(() => (window.__vivic!.getState() as {
      viewportSize: { width: number; height: number } | null;
    }).viewportSize)).toEqual({ width: 800, height: 600 });
  }
  expect(await B.evaluate(() => (window.__vivic!.getState() as { focus: unknown }).focus)).toBeNull();
  await expect(B.locator(".vivic-card")).toHaveCount(3, { timeout: 8000 });
  // fitView animation is 450ms; give it slack.
  await B.waitForTimeout(1200);

  const boxes = await Promise.all(
    [0, 1, 2].map((i) => B.locator(".vivic-card").nth(i).boundingBox()),
  );
  for (const box of boxes) {
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(800);
    expect(box!.y + box!.height).toBeLessThanOrEqual(600);
  }
  // The auto-fit genuinely zoomed out (3 × 264px cards cannot fit 800px at z=1).
  const zoom = await B.evaluate(
    () =>
      (window as unknown as {
        __vivic: { getState: () => { viewport: { zoom: number } } };
      }).__vivic.getState().viewport.zoom,
  );
  expect(zoom).toBeLessThan(1);
  await B.screenshot({ path: path.join(EVIDENCE1, "display-auto-fit-3-countdowns.png") });
  await context.close();
});
