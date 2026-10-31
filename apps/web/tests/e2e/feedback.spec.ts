import { expect, test } from "@playwright/test";
import {
  awaken,
  createDemoCards,
  fire,
  newEvidencePage,
  setTheme,
} from "./helpers";

const feedbackSequence = async (page: import("@playwright/test").Page) => {
  await fire(page, "feedback", [
    {
      type: "subtitle.show",
      text: "Found it — the second one is worth a look.",
      durationMs: 2600,
    },
    {
      type: "card.highlight",
      targetId: "e2e-todo",
      itemId: "e2e-t2",
      durationMs: 2400,
    },
  ]);
};

test("A06: subtitle is transient plain text — no bubble, avatar or timestamp", async ({
  page,
}) => {
  await page.goto("/display");
  await setTheme(page, "light");
  await awaken(page);
  await createDemoCards(page);

  await feedbackSequence(page);
  const subtitle = page.locator("[data-vivic-subtitle]");
  await expect(subtitle).toBeVisible();
  await expect(subtitle).toHaveText(
    "Found it — the second one is worth a look.",
  );
  // Pure text node: no child chrome at all (no bubble content, img, svg).
  expect(await subtitle.evaluate((el) => el.childElementCount)).toBe(0);
  const styles = await subtitle.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, radius: cs.borderRadius };
  });
  expect(styles.bg).toBe("rgba(0, 0, 0, 0)");
  expect(styles.radius).toBe("0px");

  // Feedback orb appears briefly below centre, then leaves with the line.
  await expect(page.locator(".siri-orb")).toHaveCount(1);

  // Auto-dismiss within the confirmed duration (2600ms) plus slack.
  await expect(subtitle).toHaveCount(0, { timeout: 2600 + 1200 });
  await expect(page.locator(".siri-orb")).toHaveCount(0, { timeout: 2000 });

  // Consecutive shows replace, never stack.
  await fire(page, "sub1", [
    { type: "subtitle.show", text: "First line.", durationMs: 800 },
  ]);
  await fire(page, "sub2", [
    { type: "subtitle.show", text: "Second line.", durationMs: 800 },
  ]);
  await expect(page.locator("[data-vivic-subtitle]")).toHaveCount(1);
  await expect(page.locator("[data-vivic-subtitle]")).toHaveText(
    "Second line.",
  );
  await expect(page.locator("[data-vivic-subtitle]")).toHaveCount(0, {
    timeout: 800 + 1200,
  });
});

test("rec-c: orb feedback + subtitle + item highlight video", async ({
  browser,
}) => {
  const { page, finish } = await newEvidencePage(
    browser,
    "rec-c-orb-feedback-subtitle-highlight.webm",
  );
  await page.goto("/display");
  await setTheme(page, "light");
  await awaken(page);
  await createDemoCards(page);
  await page.waitForTimeout(800);
  await feedbackSequence(page);
  await page.waitForTimeout(3400);
  await finish();
});
