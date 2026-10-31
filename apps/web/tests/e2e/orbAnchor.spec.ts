import { expect, test } from "@playwright/test";
import path from "node:path";
import { EVIDENCE, fire } from "./helpers";

/**
 * User feedback 2026-10-16: keep transient feedback at a fixed screen anchor,
 * independently of card positions and focus/camera movement.
 */
test("feedback orb keeps its top-centre position when cards and camera move", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/display");
  await page.waitForSelector(".siri-orb");
  await fire(page, "boot", [
    { type: "stage.awaken" },
    { type: "card.create", card: {
      id: "p2a1-todo",
      type: "TodoCard",
      variant: "minimal",
      displayProps: {
        items: [
          { id: "p2a1-i1", text: "占位任务甲", done: false },
          { id: "p2a1-i2", text: "占位任务乙", done: false },
        ],
      },
      sourceData: {},
      sources: [],
      layout: { x: 0, y: 0, width: 288, height: 160, pinned: false },
      metadata: { createdAt: "2026-10-15T08:00:00.000Z", updatedAt: "2026-10-15T08:00:00.000Z" },
    } },
  ]);
  await page.waitForSelector('[data-vivic-stage="WORKSPACE"]', { timeout: 6000 });
  await fire(page, "fit", [{ type: "canvas.fit" }]);
  await page.waitForTimeout(900); // camera settles, store.viewport authoritative

  const spot = { x: 400, y: 48 };
  const vp = await page.evaluate(
    () =>
      (window as unknown as {
        __vivic: { getState: () => { viewport: { x: number; y: number; zoom: number } } };
      }).__vivic.getState().viewport,
  );
  const z = vp.zoom || 1;
  // Layout is now owner-controlled. Recreate this explicitly pinned TEST card
  // through the validated engine instead of a removed internal mutation hook.
  const record = await page.evaluate(() => (window.__vivic!.getState() as {
    cards: Array<{ record: Record<string, unknown> }>;
  }).cards.find(entry => entry.record.id === "p2a1-todo")!.record);
  await fire(page, "remove-old-test-position", [{ type: "card.delete", targetId: "p2a1-todo" }]);
  await expect(page.locator('[data-card-id="p2a1-todo"]')).toHaveCount(0);
  await fire(page, "park-test-card", [{ type: "card.create", card: { ...record,
    layout: { x: (spot.x - vp.x) / z - 144, y: (spot.y - vp.y) / z - 80, width: 288, height: 160, pinned: true },
  } }]);
  await page.waitForTimeout(600);

  // Trigger the transient feedback orb.
  await fire(page, "speak", [
    { type: "subtitle.show", text: "找到它了", durationMs: 4000 },
  ]);
  const orb = page.locator("[data-vivic-orb-anchor]");
  await expect(orb).toBeVisible({ timeout: 3000 });
  await page.waitForTimeout(700);

  const orbBox = await orb.boundingBox();
  expect(orbBox).not.toBeNull();
  await expect(orb).toHaveAttribute("data-vivic-orb-anchor", "top-center");
  expect(orbBox!.x + orbBox!.width / 2).toBeCloseTo(400, 0);
  expect(orbBox!.y).toBeCloseTo(16, 0);
  await fire(page, "move-camera", [{ type: "card.focus", targetId: "p2a1-todo" }]);
  await expect.poll(async () => (await orb.boundingBox())?.x).toBeCloseTo(orbBox!.x, 0);
  await expect.poll(async () => (await orb.boundingBox())?.y).toBeCloseTo(orbBox!.y, 0);
  // And the orb stays fully on screen.
  expect(orbBox!.x).toBeGreaterThanOrEqual(0);
  expect(orbBox!.y).toBeGreaterThanOrEqual(0);
  expect(orbBox!.x + orbBox!.width).toBeLessThanOrEqual(800);
  expect(orbBox!.y + orbBox!.height).toBeLessThanOrEqual(600);
  await page.screenshot({ path: path.join(EVIDENCE, "../phase2a/orb-fixed-anchor.png") });
});

/**
 * User feedback 2026-10-16 (round 2): the orb must appear in place — no
 * slide in from the left, and no glide between centre and top anchor.
 * Samples the on-screen box on every animation frame while it appears.
 */
const sampleOrb = (page: import("@playwright/test").Page, selector: string, frames: number) =>
  page.evaluate(([sel, count]) => new Promise<Array<{ cx: number; cy: number }>>(resolve => {
    const out: Array<{ cx: number; cy: number }> = [];
    const tick = () => {
      const el = document.querySelector(sel as string);
      if (el) { const r = el.getBoundingClientRect(); out.push({ cx: r.x + r.width / 2, cy: r.y + r.height / 2 }); }
      if (out.length >= (count as number)) resolve(out); else requestAnimationFrame(tick);
    };
    tick();
  }), [selector, frames] as const);

test("orb appears in place without sliding (standby and feedback)", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  // Arm sampling before the orb mounts, so frame 1 is its birth position.
  await page.goto("/display");
  const standby = await sampleOrb(page, ".siri-orb", 20);
  for (const s of standby) {
    expect(s.cx).toBeCloseTo(600, 0);
    expect(s.cy).toBeCloseTo(350, 0);
  }

  await fire(page, "wake", [{ type: "stage.awaken" }]);
  await page.waitForSelector('[data-vivic-stage="WORKSPACE"]', { timeout: 6000 });
  await expect(page.locator("[data-vivic-orb-anchor]")).toHaveCount(0, { timeout: 3000 });

  const pending = sampleOrb(page, "[data-vivic-orb-anchor] .siri-orb", 20);
  await fire(page, "speak", [{ type: "subtitle.show", text: "在原地出现", durationMs: 4000 }]);
  const feedback = await pending;
  expect(feedback.length).toBe(20);
  for (const s of feedback) {
    expect(s.cx).toBeCloseTo(600, 0);
    expect(s.cy).toBeCloseTo(16 + 32, 0); // EDGE + 64px feedback orb / 2
  }
});
