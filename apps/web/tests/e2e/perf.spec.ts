import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  EVIDENCE,
  awaken,
  createDemoCards,
  setTheme,
} from "./helpers";

interface Sample {
  frames: number;
  seconds: number;
  avgFps: number;
  p5Fps: number;
  droppedOver50ms: number;
}

const sampleFps = async (
  page: import("@playwright/test").Page,
  seconds: number,
): Promise<Sample> =>
  page.evaluate(async (secs) => {
    // rAF delta sampler: one frame per callback, records long gaps as drops.
    const deltas: number[] = [];
    await new Promise<void>((resolve) => {
      let last = 0;
      let first = 0;
      const tick = (now: number) => {
        if (!first) first = now;
        if (last) deltas.push(now - last);
        last = now;
        if (now - first >= secs * 1000) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const avg =
      deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
    const sorted = [...deltas].sort((a, b) => b - a);
    const p5 = sorted[Math.floor(sorted.length * 0.05)] ?? avg;
    return {
      frames: deltas.length,
      seconds: secs,
      avgFps: Math.round((1000 / avg) * 10) / 10,
      p5Fps: Math.round((1000 / p5) * 10) / 10,
      droppedOver50ms: deltas.filter((d) => d > 50).length,
    };
  }, seconds);

test("perf: FPS budget for standby and 3-card workspace", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/display");
  await page.waitForSelector(".siri-orb");
  await page.waitForTimeout(1000);
  const standby = await sampleFps(page, 10);

  await setTheme(page, "auto");
  await awaken(page);
  await createDemoCards(page);
  await expect(page.locator(".vivic-card")).toHaveCount(3);
  await page.waitForTimeout(600);
  const workspace3 = await sampleFps(page, 10);

  const env = await page.evaluate(() => ({
    dpr: window.devicePixelRatio,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    userAgent: navigator.userAgent,
    at: new Date().toISOString(),
  }));

  fs.writeFileSync(
    path.join(EVIDENCE, "perf.json"),
    JSON.stringify({ env, standby, workspace3 }, null, 2),
  );

  // Budget as a sanity gate (target reports, not fake numbers).
  expect(workspace3.avgFps).toBeGreaterThan(20);
  expect(standby.avgFps).toBeGreaterThan(20);
});
