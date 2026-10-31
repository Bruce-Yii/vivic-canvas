import { expect, test } from "@playwright/test";
import path from "node:path";
import {
  EVIDENCE,
  awaken,
  createDemoCards,
  fire,
  internal,
  newEvidencePage,
  setTheme,
  waitForDisplayRuntime,
} from "./helpers";

const boot = async (page: import("@playwright/test").Page) => {
  await page.goto("/display");
  await waitForDisplayRuntime(page);
  await setTheme(page, "light");
  await awaken(page);
  await createDemoCards(page);
  await expect(page.locator(".vivic-card")).toHaveCount(3);
};

test("A04: three minimal cards render via the styled registry", async ({
  page,
}) => {
  await boot(page);
  // Styled registry is real: aui data attributes are present and styled.
  await expect(
    page.locator('[data-card-id="e2e-countdown"] [data-aui="text"]'),
  ).toBeVisible();
  const cardBg = await page
    .locator('[data-card-id="e2e-todo"] > .hark-surface-fill')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(cardBg).not.toBe("rgba(0, 0, 0, 0)");
  // Pure countdown intentionally stays digit-only on the frozen Hark sky.
  await expect(page.locator('[data-card-id="e2e-countdown"] > .hark-surface-fill')).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  await page
    .locator('[data-card-id="e2e-countdown"]')
    .screenshot({ path: path.join(EVIDENCE, "cards-countdown-minimal.png") });
  await page
    .locator('[data-card-id="e2e-todo"]')
    .screenshot({ path: path.join(EVIDENCE, "cards-todo-minimal.png") });
  await page
    .locator('[data-card-id="e2e-search"]')
    .screenshot({ path: path.join(EVIDENCE, "cards-search-minimal.png") });
});

test("Scenario 1: countdown is only digits, focus changes the camera only", async ({
  page,
}) => {
  await boot(page);

  const countdown = page.locator('[data-card-id="e2e-countdown"]');
  const text = (await countdown.locator('[data-aui="text"]').textContent())?.trim() ?? "";
  expect(text).toMatch(/\d{1,2}:\d{2}/);
  // Nothing but digits, colons and whitespace — no labels, no footer.
  expect(text).toMatch(/^[\d:\s]+$/);

  const transform = () =>
    page
      .locator(".react-flow__viewport")
      .evaluate((el) => (el as HTMLElement).style.transform);
  const before = await transform();
  const countdownRecord = () => page.evaluate(() =>
    (window.__vivic!.getState() as {
      cards: Array<{ record: { id: string } }>;
    }).cards.find(c => c.record.id === "e2e-countdown")!.record,
  );
  const beforeRecord = await countdownRecord();

  await fire(page, "focus", [{ type: "card.focus", targetId: "e2e-todo" }]);
  await page.waitForTimeout(900);
  const afterFocus = await transform();
  expect(afterFocus).not.toBe(before);
  // The timer keeps ticking during camera motion; its underlying data and
  // density must stay intact, rather than its changing clock text.
  expect(await countdownRecord()).toEqual(beforeRecord);
  // Focus must not change variant/density: markup of the countdown is digit-only.
  expect(((await countdown.locator('[data-aui="text"]').textContent()) ?? "").trim()).toMatch(/^[\d:\s]+$/);
  await page.screenshot({ path: path.join(EVIDENCE, "focus.png") });

  await fire(page, "restore", [{ type: "canvas.restore" }]);
  await page.waitForTimeout(900);
  expect(await transform()).toBe(before);
});

test("rec-b: cards → focus → restore → delete → undo video", async ({
  browser,
}) => {
  const { page, finish } = await newEvidencePage(
    browser,
    "rec-b-cards-focus-delete-undo.webm",
  );
  await boot(page);
  await page.waitForTimeout(500);

  await fire(page, "focus", [{ type: "card.focus", targetId: "e2e-todo" }]);
  await page.waitForTimeout(1400);
  await fire(page, "restore", [{ type: "canvas.restore" }]);
  await page.waitForTimeout(1400);

  await fire(page, "delete", [{ type: "card.delete", targetId: "e2e-countdown" }]);
  await expect(page.locator(".vivic-card")).toHaveCount(2, {
    timeout: 2500,
  });
  await page.waitForTimeout(600);

  await internal(page, { type: "undo" });
  await expect(page.locator(".vivic-card")).toHaveCount(3);
  await page.waitForTimeout(900);
  await finish();
});
