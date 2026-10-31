import { expect, test, type Page } from "@playwright/test";

async function start(page: Page) {
  await page.addInitScript(() => {
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error("Physical media disabled in fixture acceptance"); };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "查看示例", exact: true }).click();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByLabel("StepFun API Key", { exact: true }).fill("TEST-FIXTURE-stepfun-no-real-credential");
  await page.getByRole("button", { name: "验证并连接", exact: true }).click();
  await expect(page.locator(".vo-connected")).toContainText("StepFun");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "开始聊天", exact: true }).click();
  await expect(page.locator('[data-vivic-control="ready"]')).toBeVisible();
}
async function connect(page: Page, label: "飞书" | "麦当劳") {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const section = page.locator('[data-settings-extra="services"]');
  if (await section.getAttribute("open") === null) await section.locator("summary").click();
  await section.getByRole("button", { name: new RegExp(`^${label}\\s*连接$`) }).click();
  await section.getByLabel(label === "飞书" ? "用户访问令牌" : "访问令牌", { exact: true }).fill(`TEST-FIXTURE-${label === "飞书" ? "feishu" : "mcd"}-no-real-credential`);
  await section.getByRole("button", { name: "连接", exact: true }).click();
  await expect(section.getByRole("status")).toContainText("已连接，可以在聊天页查询资料");
  await expect(section.locator('input[type="password"]')).toHaveValue("");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
}
async function lookup(page: Page, question: string) {
  if (!await page.getByRole("button", { name: "查询资料", exact: true }).isVisible()) await page.getByRole("button", { name: "添加内容", exact: true }).click();
  const toggle = page.getByRole("button", { name: "查询资料", exact: true });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await page.getByLabel("资料查询问题", { exact: true }).fill(question);
  await page.getByRole("button", { name: "查询", exact: true }).click();
}

test("real online backend fixture: configure, natural lookup, durable sourced card, scope and disconnect", async ({ page, context }, info) => {
  await start(page); await connect(page, "飞书");
  await lookup(page, "找一下杭州旅行计划");
  await expect(page.locator(".vc-result")).toContainText("TEST FIXTURE · 杭州旅行计划");
  await expect(page.locator(".vc-result .vc-source-links a")).toHaveAttribute("href", "https://example.com/fixture-hangzhou");
  await page.screenshot({ path: info.outputPath("01-fixture-natural-query.png"), fullPage: true });
  await page.getByRole("button", { name: "保存为卡片", exact: true }).click();
  await expect(page.getByRole("button", { name: "已加入 Space", exact: true })).toBeDisabled();
  const before = await page.evaluate(() => window.__vivic!.getState().cards.map(card => card.record));
  expect(before).toHaveLength(1); expect(before[0]!.sources[0]).toMatchObject({ kind: "service", provider: "飞书", readFullPage: false });
  expect(before[0]!.sourceData.connectedSource).toMatchObject({ provider: "feishu", tool: "search-doc" });
  await page.getByRole("dialog", { name: "查询资料", exact: true }).getByRole("button", { name: "关闭窗口", exact: true }).click();
  const popup = page.waitForEvent("popup"); await page.getByRole("button", { name: "展示窗口", exact: true }).click(); const display = await popup;
  await expect(display.locator(".vivic-card")).toHaveCount(1);
  await expect(display.locator(".vivic-card")).toContainText("杭州旅行计划");
  await display.screenshot({ path: info.outputPath("02-fixture-card-in-space.png"), fullPage: true });
  await page.reload(); await expect(page.locator('[data-vivic-control="ready"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__vivic!.getState().cards.map(card => card.record.id))).toEqual([before[0]!.id]);
  await lookup(page, "找一下杭州旅行计划"); await expect(page.locator(".vc-result")).toContainText("TEST FIXTURE");
  await page.getByRole("button", { name: "再次查询", exact: true }).click(); await expect(page.locator(".vc-result")).toContainText("TEST FIXTURE");
  const originalId = await page.evaluate(() => (window.__vivicControl!.snapshot() as { activeCanvasId: string }).activeCanvasId);
  await page.getByRole("dialog", { name: "查询资料", exact: true }).getByRole("button", { name: "关闭窗口", exact: true }).click();
  await page.getByRole("button", { name: "管理 Vivic Space", exact: true }).click();
  const space = page.locator("[data-vivic-space-management]");
  await space.getByRole("button", { name: "新建画布", exact: true }).click();
  await space.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await expect(page.locator(".vc-result")).toHaveCount(0);
  expect(await page.evaluate(() => window.__vivic!.getState().cards.length)).toBe(0);
  await page.getByRole("button", { name: "管理 Vivic Space", exact: true }).click();
  await space.locator(`[data-vivic-canvas-item="${originalId}"]`).click(); await space.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__vivic!.getState().cards.length)).toBe(1);
  await lookup(page, "删除文档"); await expect(page.locator(".vc-query-error[role=alert]")).toContainText("只读查询范围");
  expect(await page.evaluate(() => window.__vivic!.getState().cards.length)).toBe(1);
  await page.getByRole("dialog", { name: "查询资料", exact: true }).getByRole("button", { name: "关闭窗口", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const section = page.locator('[data-settings-extra="services"]');
  if (await section.getAttribute("open") === null) await section.locator("summary").click();
  if (!(await section.getByRole("button", { name: "断开", exact: true }).isVisible())) await section.getByRole("button", { name: /^飞书\s*已连接$/ }).click();
  await section.getByRole("button", { name: "测试连接", exact: true }).click(); await expect(section.getByRole("status")).toContainText("已连接");
  await section.getByRole("button", { name: "断开", exact: true }).click(); await expect(section.getByRole("status")).toContainText("已断开");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  if (!await page.getByRole("button", { name: "查询资料", exact: true }).isVisible()) await page.getByRole("button", { name: "添加内容", exact: true }).click();
  await page.getByRole("button", { name: "查询资料", exact: true }).click();
  await expect(page.getByRole("heading", { name: "连接你的资料来源", exact: true })).toBeVisible();
  const separate = await context.browser()!.newContext();
  const unrelated = await separate.newPage(); await unrelated.goto("/");
  await expect(unrelated.getByRole("heading", { name: "聊天与 Space", exact: true })).toBeVisible();
  const isolated = await unrelated.evaluate(async () => (await fetch("/api/connections/status")).json());
  expect(isolated.connections.every((connection: { configured: boolean }) => !connection.configured)).toBe(true);
  await separate.close();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("no-real-credential");
  const upstream = await (await page.request.get("http://127.0.0.1:17895/__fixture/calls")).json();
  expect(upstream.calls.some((call: { method: string }) => call.method === "model.plan")).toBe(true);
  expect(upstream.calls.filter((call: { method: string; name?: string }) => call.method === "tools/call").every((call: { name?: string }) => call.name === "search-doc")).toBe(true);
  await display.close();
});

test("McDonald fixture exposes read-only calendar and natural lookup without coupon claiming", async ({ page }, info) => {
  await start(page); await connect(page, "麦当劳");
  await lookup(page, "这个月有什么活动");
  await expect(page.locator(".vc-result")).toContainText("不代表真实优惠");
  await expect(page.getByLabel("查询内容", { exact: true }).locator("option")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("03-fixture-mcd-calendar.png"), fullPage: true });
  await page.getByRole("button", { name: "保存为卡片", exact: true }).click(); await expect(page.getByRole("button", { name: "已加入 Space", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.__vivic!.getState().cards[0]?.record.sources[0]?.provider)).toBe("麦当劳");
});
