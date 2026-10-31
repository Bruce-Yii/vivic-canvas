const { test, expect } = require("../../../apps/web/node_modules/@playwright/test");
const path = require("node:path");
const fs = require("node:fs");
const screenshots = path.resolve(__dirname, "../test-results/visual");
const generate = async page => {
  await page.getByRole("button", { name: "生成旅行卡片" }).click();
  await expect(page.getByRole("heading", { name: "杭州，3 天的可能性" })).toBeVisible();
};
test("generate, edit, select, compare, budget, reload and browser isolation", async ({ page, browser }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/"); await generate(page);
  await page.getByRole("button", { name: "编辑行程" }).first().click();
  await page.getByRole("textbox", { name: "第1天安排2" }).fill("TEST · 下午在街区慢慢散步");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "选择", exact: true }).first().click();
  await page.getByRole("textbox", { name: "旅游备注" }).fill("TEST · 希望安静一点");
  await page.getByRole("button", { name: "设为推荐：留白慢游" }).filter({ visible: true }).click();
  await page.reload();
  await expect(page.getByText("TEST · 下午在街区慢慢散步")).toBeVisible();
  await expect(page.getByRole("button", { name: "已选择", exact: true })).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "旅游备注" })).toHaveValue("TEST · 希望安静一点");
  await page.getByRole("spinbutton", { name: "总预算" }).fill("3600");
  await expect(page.getByText(/条件已调整/)).toBeVisible();
  await page.getByRole("button", { name: "重新规划", exact: true }).click();
  await expect(page.locator(".travel-budget-total")).toContainText("3,600");
  await expect(page.getByRole("button", { name: "已选择", exact: true })).toHaveCount(1);
  const independent = await browser.newContext(); const other = await independent.newPage();
  await other.goto("http://127.0.0.1:5196/"); await expect(other.getByRole("button", { name: "生成旅行卡片" })).toBeVisible(); await independent.close();
  expect(errors).toEqual([]);
});
test("cancel/error preserve old plan; empty refresh clears invalid selection", async ({ page }) => {
  await page.goto("/"); await generate(page);
  await page.getByRole("textbox", { name: "目的地", exact: true }).fill("北京");
  await page.getByRole("button", { name: "重新规划", exact: true }).click(); await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("heading", { name: "杭州，3 天的可能性" })).toBeVisible();
  await page.getByText("演示状态与数据说明").click();
  await page.getByLabel("演示查询状态").selectOption("error");
  await page.getByRole("button", { name: "重新规划", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("已有卡片已保留");
  await page.getByLabel("演示查询状态").selectOption("empty");
  await page.getByRole("button", { name: "刷新结果", exact: true }).click();
  await expect(page.getByText("没有符合条件的结果，可调整条件重新查询。")).toBeVisible();
  await expect(page.getByRole("heading", { name: "杭州，3 天的可能性" })).toBeVisible();
  await page.getByLabel("演示查询状态").selectOption("ok"); await page.getByRole("button", { name: "刷新结果", exact: true }).click();
  await expect(page.getByRole("button", { name: "选择", exact: true })).toHaveCount(3);
});
test("12 palettes, desktop and mobile have no horizontal overflow or runtime errors", async ({ page }) => {
  fs.mkdirSync(screenshots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1080 }); await page.goto("/"); await generate(page);
  for (const palette of ["milk", "peach", "lilac", "mint", "dawn", "berry"]) {
    await page.getByLabel("背景配色").selectOption(palette); await expect(page.locator("[data-vivic-atmosphere]")).toHaveAttribute("data-vivic-atmosphere", palette);
  }
  await page.getByLabel("背景配色").selectOption("milk"); await page.screenshot({ path: path.join(screenshots, "desktop-light.png"), fullPage: true });
  await page.getByRole("button", { name: "切换深色" }).click();
  for (const palette of ["graphite", "midnight", "ocean", "velvet", "ember", "forest"]) { await page.getByLabel("背景配色").selectOption(palette); }
  await page.getByLabel("背景配色").selectOption("midnight"); await page.screenshot({ path: path.join(screenshots, "desktop-dark.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(screenshots, "mobile-dark.png"), fullPage: true });
  await page.getByRole("button", { name: "切换浅色" }).click(); await page.screenshot({ path: path.join(screenshots, "mobile-light.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("export and clear touch only the independent namespace", async ({ page }) => {
  await page.goto("/"); await page.evaluate(() => localStorage.setItem("TEST.main-owner-sentinel", "untouched")); await generate(page);
  const downloaded = page.waitForEvent("download"); await page.getByRole("button", { name: "导出计划" }).click(); expect((await downloaded).suggestedFilename()).toBe("travel-vivic-plan.md");
  await page.getByRole("button", { name: "清空旅行空间" }).click(); await page.reload();
  await expect(page.getByRole("button", { name: "生成旅行卡片" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("TEST.main-owner-sentinel"))).toBe("untouched");
  expect(await page.evaluate(() => localStorage.getItem("vivic.travel-space.demo.v1"))).toBeNull();
});
