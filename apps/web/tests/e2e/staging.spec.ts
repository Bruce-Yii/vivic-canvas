import { expect, test } from "@playwright/test";
import path from "node:path";
import {
  EVIDENCE,
  awaken,
  createDemoCards,
  fire,
  newEvidencePage,
  setTheme,
} from "./helpers";

test("A02: standby shows the user page's background with only the orb — no veil, no text", async ({
  page,
}) => {
  await page.goto("/display");
  await page.waitForSelector(".siri-orb");
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "关闭全屏提示", exact: true }).click();
  // Same frozen Hark background as the user page from the very first frame.
  await expect(page.locator('[data-vivic-layer="background"]')).toBeVisible();
  await expect(page.locator('[data-vivic-layer="veil"]')).toHaveCount(0);
  const visibleText = await page.evaluate(() =>
    document.body.innerText.trim(),
  );
  expect(visibleText).toBe("");
  await expect(page.locator('[data-vivic-stage]')).toHaveAttribute(
    "data-vivic-stage",
    "STANDBY",
  );
  await page.screenshot({ path: path.join(EVIDENCE, "standby-orb.png") });
});

test("A03: awakening keeps the same background, workspace follows", async ({
  page,
}) => {
  await page.goto("/display");
  await page.waitForSelector(".siri-orb");
  await fire(page, "awaken", [{ type: "stage.awaken" }]);
  // Mid-awakening: still the shared background, no black layer anywhere.
  await page.waitForTimeout(420);
  await expect(page.locator('[data-vivic-layer="veil"]')).toHaveCount(0);
  await expect(page.locator('[data-vivic-stage]')).toHaveAttribute(
    "data-vivic-stage",
    "AWAKENING",
  );
  await page.screenshot({ path: path.join(EVIDENCE, "wake-mid.png") });
  await page.waitForSelector('[data-vivic-stage="WORKSPACE"]', {
    timeout: 6000,
  });
  // A03 tail: no resident orb in workspace.
  await page.waitForTimeout(600);
  await expect(page.locator(".siri-orb")).toHaveCount(0);
});

test("A05/A07: workspace light + dark with three minimal cards", async ({
  page,
}) => {
  await page.goto("/display");
  await setTheme(page, "light");
  await awaken(page);
  await createDemoCards(page);
  await expect(page.locator(".vivic-card")).toHaveCount(3);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(EVIDENCE, "workspace-light.png") });

  await setTheme(page, "dark");
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(EVIDENCE, "workspace-dark.png") });
});

test("A08: prefers-reduced-motion reaches the workspace without any mask", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/display");
  await page.waitForSelector(".siri-orb");
  await fire(page, "awaken", [{ type: "stage.awaken" }]);
  // Reduced-motion path: no veil and no circular mask at all.
  await expect(page.locator('[data-vivic-layer="veil"]')).toHaveCount(0);
  await page.waitForSelector('[data-vivic-stage="WORKSPACE"]', {
    timeout: 6000,
  });
  // Subtitles remain readable (information is never motion-gated).
  await fire(page, "rm-sub", [
    { type: "subtitle.show", text: "Reduced motion check.", durationMs: 900 },
  ]);
  await expect(page.locator("[data-vivic-subtitle]")).toHaveText(
    "Reduced motion check.",
  );
  await expect(page.locator("[data-vivic-subtitle]")).toHaveCount(0, {
    timeout: 900 + 1500,
  });
});

test("rec-a: standby → awaken → workspace video", async ({ browser }) => {
  const { page, finish } = await newEvidencePage(
    browser,
    "rec-a-standby-awaken-workspace.webm",
  );
  await page.goto("/display");
  await page.waitForSelector(".siri-orb");
  await page.waitForTimeout(1600);
  await fire(page, "awaken", [{ type: "stage.awaken" }]);
  await page.waitForSelector('[data-vivic-stage="WORKSPACE"]', {
    timeout: 6000,
  });
  await createDemoCards(page);
  await page.waitForTimeout(2500);
  await finish();
});
