import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { activeCanvasId, controlDispatch, sendCommand, todoCardRecord } from "./helpers1";

test.use({ video: { mode: "on", size: { width: 1440, height: 900 } } });

const ready = async (page: Page) => {
  await page.goto("/control");
  await page.waitForSelector('[data-vivic-control="ready"]');
  await expect(page.locator('[data-vivic-control]')).toHaveAttribute("data-vivic-owner", "owner");
};

const respond = async (route: Route, text: string) => {
  const { canvasContext } = route.request().postDataJSON();
  await route.fulfill({
    json: { kind: "envelope", usedProvider: "stepfun", envelope: {
      schemaVersion: "0.6", requestId: `result-${text}`, canvasId: canvasContext.canvasId,
      spokenText: text, actions: [{ type: "canvas.fit" }],
    } },
  }).catch(() => undefined); // a superseded request may already be aborted
};

test("pending feedback reaches both windows, escalates, then clears on completion", async ({ page, context }) => {
  await ready(page);
  const canvasId = await activeCanvasId(page);
  await controlDispatch(page, "initial", canvasId, [
    { type: "stage.awaken" },
    { type: "card.create", card: todoCardRecord("thinking-todo", ["等待时保持画布可见"]) },
  ]);
  const display = await context.newPage();
  await display.goto(`/display?canvasId=${canvasId}`);
  await expect(display.locator('[data-vivic-stage]')).toHaveAttribute("data-vivic-stage", "WORKSPACE");
  let held: Route | undefined;
  await page.route("**/api/intent", route => { held = route; });
  await sendCommand(page, "请仔细考虑如何整理这一页");
  await expect(page.locator('[data-vivic-command-feedback]')).toHaveText("正在理解你的指令…");
  await expect(display.locator('[data-vivic-ai-state="thinking"] .siri-orb')).toBeVisible();
  await expect(page.locator('[data-vivic-command-progress]')).toContainText("正在处理…");
  const orb = await display.locator('[data-vivic-ai-state="thinking"] .siri-orb').boundingBox();
  expect(orb!.width).toBeGreaterThanOrEqual(90);
  await expect(display.locator('[data-vivic-thinking]')).toHaveText("让我想想…");

  // Snapshot, not just an already-open subscriber, must retain live feedback.
  const late = await context.newPage();
  await late.goto(`/display?canvasId=${canvasId}`);
  await expect.poll(async () => {
    const current = await page.locator('[data-vivic-command-feedback]').textContent();
    const observed = await late.locator('[data-vivic-thinking]').textContent().catch(() => null);
    return (current === "让我想想…" || current === "响应较慢，仍在处理…") && observed === current;
  }).toBe(true);
  await expect(page.locator('[data-vivic-command-feedback]')).toHaveText("响应较慢，仍在处理…", { timeout: 7000 });
  await expect(display.locator('[data-vivic-thinking]')).toHaveText("响应较慢，仍在处理…");
  const dir = path.resolve(process.cwd(), "../../evidence/voice-feedback/regression/thinking");
  fs.mkdirSync(dir, { recursive: true });
  await display.screenshot({ path: path.join(dir, "thinking-display.png") });
  await page.screenshot({ path: path.join(dir, "thinking-control.png") });
  await expect.poll(() => Boolean(held)).toBe(true);
  await respond(held!, "整理完成");
  await expect(page.locator('[data-vivic-command-feedback]')).toHaveText("整理完成");
  await expect(page.locator('[data-vivic-command-cancel]')).toHaveCount(0);
  await expect(display.locator('[data-vivic-thinking]')).toHaveCount(0);
  await expect(late.locator('[data-vivic-thinking]')).toHaveCount(0);
  const video = display.video();
  await late.close(); await display.close();
  if (video) await video.saveAs(path.join(dir, "rec-thinking-feedback.webm"));
});

test("cancel and a newer command discard late model responses", async ({ page }) => {
  await ready(page);
  const held: Route[] = [];
  const cancelled: string[] = [];
  await page.route("**/api/intent", async route => {
    const body = route.request().postDataJSON();
    if (body.task?.cancel === true) {
      cancelled.push(body.task.id);
      await route.continue();
    } else held.push(route);
  });
  await sendCommand(page, "第一条复杂指令");
  await expect.poll(() => held.length).toBe(1);
  await sendCommand(page, "第二条复杂指令");
  await expect.poll(() => held.length).toBe(2);
  await respond(held[0]!, "过期的结果");
  await expect(page.locator('[data-vivic-command-feedback]')).toHaveText("正在理解你的指令…");
  await page.locator('[data-vivic-command-cancel]').click();
  await expect(page.locator('[data-vivic-command-feedback]')).toHaveText("已取消本次请求");
  await respond(held[1]!, "取消后的结果");
  await expect(page.locator('[data-vivic-command-feedback]')).toHaveText("已取消本次请求");
  await expect.poll(() => cancelled).toEqual(held.map(route => route.request().postDataJSON().task.id));
  expect(held).toHaveLength(2);
  const ids = await page.evaluate(() => window.__vivic!.getState() as { processedRequestIds: string[] });
  expect(ids.processedRequestIds).not.toContain("result-过期的结果");
  expect(ids.processedRequestIds).not.toContain("result-取消后的结果");
});

test("switching canvases cancels the request and cannot apply its late envelope", async ({ page }) => {
  await ready(page);
  let held: Route | undefined;
  await page.route("**/api/intent", route => { held = route; });
  await sendCommand(page, "帮我仔细规划");
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.evaluate(() => {
    const id = window.__vivicControl!.createCanvas("切换测试");
    window.__vivicControl!.switchCanvas(id);
  });
  await expect(page.locator('[data-vivic-command-feedback]')).toHaveText("已取消本次请求");
  await respond(held!, "错误画布的结果");
  await expect(page.locator('[data-vivic-command-feedback]')).toHaveText("已取消本次请求");
  const state = await page.evaluate(() => window.__vivic!.getState() as { activity: unknown; processedRequestIds: string[] });
  expect(state.activity).toBeNull();
  expect(state.processedRequestIds).not.toContain("result-错误画布的结果");
});

test("provider failure clears waiting state and reports the actual error", async ({ page }) => {
  await ready(page);
  let held: Route | undefined;
  await page.route("**/api/intent", route => { held = route; });
  await sendCommand(page, "一条需要模型的新指令");
  await expect(page.locator('[data-vivic-command-cancel]')).toBeVisible();
  await expect.poll(() => Boolean(held)).toBe(true);
  await held!.fulfill({ json: { kind: "error", message: "模型服务返回 HTTP 429" } });
  await expect(page.locator('[data-vivic-command-feedback]')).toHaveText("模型服务返回 HTTP 429");
  await expect(page.locator('[data-vivic-command-cancel]')).toHaveCount(0);
});

test("a stalled request times out and clears its waiting state", async ({ page }) => {
  await ready(page);
  await page.clock.install();
  await page.route("**/api/intent", () => undefined);
  await sendCommand(page, "一个一直没有响应的复杂指令");
  await expect(page.locator('[data-vivic-command-cancel]')).toBeVisible();
  await page.clock.fastForward(101_000);
  await expect(page.locator('[data-vivic-command-feedback]')).toHaveText("本次请求超时，请重试。");
  await expect(page.locator('[data-vivic-command-cancel]')).toHaveCount(0);
  const activity = await page.evaluate(() => (window.__vivic!.getState() as { activity: unknown }).activity);
  expect(activity).toBeNull();
});
