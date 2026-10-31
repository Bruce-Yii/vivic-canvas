import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    HTMLMediaElement.prototype.play = async () => { throw new Error("TEST no playback"); };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST no microphone"); };
    if (window.speechSynthesis) window.speechSynthesis.speak = () => { throw new Error("TEST no speech"); };
  });
  await context.route("**/api/**", route => route.fulfill({ status: 503, json: { error: "TEST backend offline" } }));
});

for (const url of ["/display", "/display?dev=1"]) {
  test(`production ${url} keeps the stage free of debug controls`, async ({ page }, info) => {
    await page.goto(url);
    await expect(page.locator(".siri-orb")).toBeVisible();
    await expect(page.locator("[data-vivic-devpanel]")).toHaveCount(0);
    await expect(page.getByText("DEV PANEL", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button")).toHaveCount(0);
    expect(await page.evaluate(() => typeof window.__vivic)).toBe("undefined");
    await page.screenshot({ path: info.outputPath("TEST-production-display.png") });
  });
}
