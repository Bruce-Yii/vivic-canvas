import { expect, test } from "@playwright/test";

// TEST context only: the landing makes no network calls of its own. Demo
// photos are remote sample images; they are blocked here and fall back to
// the cards' own placeholder.
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    HTMLMediaElement.prototype.play = async () => { throw new Error("TEST audio disabled"); };
    navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST microphone disabled"); };
  });
  await context.route("https://images.unsplash.com/**", route => route.abort());
});

test("landing: any valid email is accepted as a beta user and opens the user page", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", request => { if (request.method() === "POST") posts.push(request.url()); });
  await page.goto("/landing");
  await expect(page).toHaveURL(/\/landing\/$/);
  await expect(page.locator("h1")).toContainText("说出你的想法");

  const email = page.locator("#betaEmail");
  await email.fill("not-an-email");
  await page.locator("#betaSubmit").click();
  await page.waitForTimeout(900);
  await expect(page).toHaveURL(/\/landing\/$/);
  expect(await email.evaluate(input => (input as HTMLInputElement).validity.valid)).toBe(false);

  await email.fill("demo@example.com");
  await page.locator("#betaSubmit").click();
  await expect(page.locator("#betaStatus")).toContainText("你已成为 VIVIC 内测用户");
  await page.waitForURL(url => url.pathname === "/");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-view", "chat");
  // Demo signup: nothing is posted anywhere.
  expect(posts.filter(url => url.includes("waitlist"))).toEqual([]);
});

test("landing: any path under /landing (bare, or a link with trailing punctuation) shows the landing, not the user page", async ({ page }) => {
  for (const path of ["/landing", "/landing/**", "/landing/%EF%BC%89"]) {
    await page.goto(path);
    await page.waitForURL(url => url.pathname === "/landing/");
    await expect(page.locator("#betaEmail")).toBeVisible();
  }
});

test("landing: the closing link opens the user page in the same tab", async ({ page }) => {
  await page.goto("/landing/");
  await page.locator(".closing .local-link").click();
  await page.waitForURL(url => url.pathname === "/");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-view", "chat");
});

test("landing: demos render the product's own scene cards and never call the API", async ({ page }) => {
  const apiCalls: string[] = [];
  const errors: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) apiCalls.push(request.url()); });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/landing/");

  // The ring holds all 21 built-in scenes plus the classic cards.
  const ring = page.locator(".lp-ring");
  await ring.scrollIntoViewIfNeeded();
  await expect(ring.locator(".lp-ring-item")).toHaveCount(25);
  const types = await ring.locator(".lp-card-frame").evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute("data-card-type")))].sort());
  expect(types).toEqual([
    "ActivityFeedCard", "BookCard", "ChartCard", "ComparisonCard", "CountdownCard", "GalleryCard", "HabitHeatmapCard", "LinkPreviewCard",
    "MonthCalendarCard", "NewsCard", "NotificationCard", "PaperCard", "PhotoCoverCard", "ProgressRingCard", "QuoteCard", "RoadmapCard",
    "SearchResultCard", "StoryCarouselCard", "TableCard", "TimelineCard", "TodoCard", "TravelOffersCard", "WeatherCard", "WeeklyScheduleCard",
  ]);
  // Rendered by the real components, not pictures of them.
  await expect(ring.locator("[data-scene-card]")).toHaveCount(19);
  await expect(ring.locator('[data-scene-card="TravelOffersCard"]')).toContainText("DEMO");
  await expect(ring.locator("[data-vivic-todo-card]")).toHaveCount(1);
  await expect(ring.locator(".lp-ring-bubble").first()).not.toBeEmpty();

  // The hero types a sentence and a real card appears on the Display panel.
  await page.evaluate(() => scrollTo(0, 0));
  await expect(page.locator(".lp-hero-card .vivic-card")).toBeVisible({ timeout: 15_000 });

  // The pause control stops the ring for people who want it still.
  const pause = page.getByRole("button", { name: "暂停滚动" });
  await pause.click();
  await expect(page.getByRole("button", { name: "继续滚动" })).toHaveAttribute("aria-pressed", "true");

  expect(apiCalls).toEqual([]);
  expect(errors).toEqual([]);
});

test("landing: user-page cards in the hands-on demo are editable in memory only", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", request => { if (request.method() !== "GET") writes.push(request.url()); });
  await page.goto("/landing/");
  const demo = page.locator("#hands");
  await demo.scrollIntoViewIfNeeded();
  const toggle = demo.locator('[data-vivic-todo-toggle="t2"]');
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(demo.getByText("已重新校验，会同步到展示窗口")).toBeVisible();
  expect(writes).toEqual([]);
});

test("landing: with reduced motion the demos hold still and still show cards", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  await context.route("https://images.unsplash.com/**", route => route.abort());
  const page = await context.newPage();
  await page.goto("/landing/");
  await expect(page.locator(".lp-hero-card .vivic-card")).toBeVisible();
  await expect(page.getByRole("button", { name: "暂停滚动" })).toHaveCount(0);
  await context.close();
});
