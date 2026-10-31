import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { readIntentResult, activeCanvasId, controlDispatch, sendCommand, openSpace, showChat, todoCardRecord } from "./helpers1";

const stamp = "2026-10-16T00:00:00.000Z";
test.use({ actionTimeout: 10000 });
const note = (id: string) => ({ ...todoCardRecord(id, []), type: "NoteCard", variant: "expanded", displayProps: { text: "TEST 第一行\nTEST 第二行：一项需要补充细节的工作\nTEST 第三行" } });
const reminder = (id: string, text: string) => ({ ...todoCardRecord(id, []), type: "CountdownCard", displayProps: {}, sourceData: { targetAt: new Date(Date.now() + 3600000).toISOString(), reminderText: text } });
const boot = async (page: Page) => {
  await page.goto("/control"); await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  await sendCommand(page, "唤醒");
  return activeCanvasId(page);
};
const inspect = (page: Page, id: string) => page.locator(`[data-vivic-inspect-card="${id}"]`);
const openInspector = async (page: Page, id: string) => { await openSpace(page, "卡片"); await inspect(page, id).locator("[data-vivic-inspect-toggle]").click(); };
const popup = (page: Page) => page.locator("[data-vivic-subcard-popover]");
const addChild = async (page: Page, id: string, itemId: string, text: string) => {
  const row = inspect(page, id); await row.locator(`[data-vivic-subcard-trigger="${itemId}"]`).click();
  await popup(page).locator("textarea").fill(text); await popup(page).getByRole("button", { name: "保存子卡片" }).click();
  await expect(popup(page).locator("[data-vivic-subcard]")).toContainText(text.replace(/\*/g, ""));
};
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    HTMLMediaElement.prototype.play = async () => { throw new Error("TEST no audio"); };
    navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST no microphone"); };
  });
});
test.afterEach(async ({ context }, info) => {
  if (info.status === info.expectedStatus) return;
  for (const [index, page] of context.pages().entries()) await page.screenshot({ path: info.outputPath(`TEST-failure-page-${index}.png`) }).catch(() => undefined);
});

test("four merged reminders get matching frozen numbers, hover preview, local named highlight/delete, and undo", async ({ page, context }, info) => {
  const canvasId = await boot(page); const display = await context.newPage(); await display.goto(`/display?canvasId=${canvasId}`);
  const names = ["TEST喝水", "TEST休息", "TEST开会", "TEST吃药"];
  await controlDispatch(page, "seed", canvasId, names.map((name, i) => ({ type: "card.create", card: reminder(`TEST-r${i + 1}`, name) })));
  await expect(display.locator("[data-vivic-reminder-row]")).toHaveCount(4); await expect(display.locator(".vivic-card")).toHaveCount(1);
  let remote = 0; page.on("response", async response => { if (response.url().endsWith("/api/intent")) { const result = await readIntentResult(response); if (result.usedProvider === "stepfun" || result.usedProvider === "gpt") remote++; } });
  await sendCommand(page, "删除提醒"); await expect(page.locator("[data-vivic-clarify-candidate]")).toHaveCount(4);
  for (let i = 1; i <= 4; i++) await expect(display.locator(`[data-vivic-target-number="${i}"]`)).toHaveAttribute("data-target-card-id", `TEST-r${i}`);
  await page.locator("[data-vivic-clarify-candidate]").nth(1).hover();
  await expect(display.locator('[data-vivic-reminder-row="TEST-r2"]')).toHaveAttribute("data-vivic-highlighted", "true");
  await expect(display.locator("[data-vivic-reminder-row][data-vivic-highlighted]")).toHaveCount(1);
  await display.screenshot({ path: path.resolve(process.cwd(), "../../evidence/interaction-details", info.project.name || "chromium", "TEST-numbered-reminders.png") });
  await sendCommand(page, "二号"); await expect(display.locator("[data-vivic-reminder-row]")).toHaveCount(3);
  await expect(display.locator('[data-vivic-reminder-row="TEST-r2"]')).toHaveCount(0); await expect(display.locator("[data-vivic-target-number]")).toHaveCount(0);
  await sendCommand(page, "撤销"); await expect(display.locator("[data-vivic-reminder-row]")).toHaveCount(4);
  await sendCommand(page, "高亮TEST开会提醒"); await expect(display.locator('[data-vivic-reminder-row="TEST-r3"]')).toHaveAttribute("data-vivic-highlighted", "true");
  await sendCommand(page, "删除TEST喝水提醒"); await expect(display.locator('[data-vivic-reminder-row="TEST-r1"]')).toHaveCount(0);
  await expect(display.locator(".vivic-card")).toHaveCount(1); expect(remote).toBe(0);
});

test("a live choice never renumbers on addition; deletion, Escape, IME, and a canvas switch invalidate it safely", async ({ page, context }) => {
  const canvasId = await boot(page); const display = await context.newPage(); await display.goto("/display");
  await controlDispatch(page, "seed", canvasId, [1, 2, 3, 4].map(i => ({ type: "card.create", card: todoCardRecord(`TEST-t${i}`, [`TEST待办${i}`]) })));
  await sendCommand(page, "删除待办"); await expect(display.locator("[data-vivic-target-number]")).toHaveCount(4);
  await controlDispatch(page, "extra", canvasId, [{ type: "card.create", card: todoCardRecord("TEST-extra", ["TEST 新加入"]) }]);
  await expect(display.locator('[data-vivic-target-number="2"]')).toHaveAttribute("data-target-card-id", "TEST-t2");
  await sendCommand(page, "第2个"); await expect(display.locator('[data-card-id="TEST-t2"]')).toHaveCount(0); await expect(display.locator(".vivic-card")).toHaveCount(4);
  await sendCommand(page, "删除待办"); await expect(page.locator("[data-vivic-clarify]")).toBeVisible();
  const input = page.locator("[data-vivic-command-input]");
  await input.fill("3"); await input.dispatchEvent("compositionstart", { data: "3" });
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
  // Explicitly exercise native form submission too; untrusted key events do
  // not perform the browser's default submit action.
  await input.evaluate(el => el.closest("form")!.requestSubmit());
  await expect(display.locator(".vivic-card")).toHaveCount(4); await expect(page.locator("[data-vivic-clarify]")).toBeVisible();
  await input.dispatchEvent("compositionend"); await input.press("Escape"); await expect(display.locator("[data-vivic-target-number]")).toHaveCount(0);
  await sendCommand(page, "删除待办");
  await controlDispatch(page, "remove-candidate", canvasId, [{ type: "card.delete", targetId: "TEST-t3" }]);
  await expect(page.locator("[data-vivic-clarify]")).toHaveCount(0); await expect(display.locator("[data-vivic-target-number]")).toHaveCount(0);
  await sendCommand(page, "删除待办"); await expect(page.locator("[data-vivic-clarify]")).toBeVisible();
  await page.evaluate(() => { const id = window.__vivicControl!.createCanvas("TEST 新画布"); window.__vivicControl!.switchCanvas(id); });
  await expect(page.locator("[data-vivic-clarify]")).toHaveCount(0); await expect(display.locator(".vivic-card")).toHaveCount(0);
});

test("Todo row subcards support keyboard, arrow, refresh, stable ID reorder and parent delete/undo without layout mutations", async ({ page, context }, info) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const canvasId = await boot(page); const display = await context.newPage(); display.on("pageerror", e => errors.push(e.message)); await display.goto(`/display?canvasId=${canvasId}`);
  await controlDispatch(page, "seed", canvasId, [{ type: "card.create", card: { ...todoCardRecord("TEST-todo", ["TEST 买菜", "TEST 写报告"]), layout: { x: 83, y: 91, width: 320, height: 160, pinned: true } } }]);
  await expect(display.locator(".vivic-card")).toHaveCount(1); const layout = await page.evaluate(() => window.__vivic!.getState().cards[0].record.layout);
  await openInspector(page, "TEST-todo"); const trigger = inspect(page, "TEST-todo").locator('[data-vivic-subcard-trigger="TEST-todo-i2"]');
  await trigger.focus(); await trigger.press("Enter"); await expect(popup(page)).toBeVisible();
  await popup(page).locator("textarea").fill("TEST 报告补充 **说明**：先整理今天的测试反馈，再记录结论。");
  await popup(page).getByRole("button", { name: "保存子卡片" }).click();
  await expect(popup(page).locator("[data-vivic-subcard] strong")).toHaveText("说明");
  await popup(page).press("Escape"); await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => window.__vivic!.getState().cards[0].record.layout)).toEqual(layout);
  const displayTrigger = display.locator('[data-vivic-subcard-trigger="TEST-todo-i2"]'); await displayTrigger.click();
  await expect(popup(display)).toHaveAttribute("data-item-id", "TEST-todo-i2"); await expect(popup(display).locator("[data-vivic-subcard-arrow]")).toBeVisible();
  await expect(popup(display)).toContainText("报告补充");
  // A Control camera action can pan/zoom the source while its reader stays open.
  await display.mouse.move(700, 400); await display.mouse.wheel(0, -150);
  await expect.poll(() => display.evaluate(() => window.__vivic!.getState().viewport.zoom)).toBeGreaterThan(1.05);
  await sendCommand(page, "聚焦待办");
  await expect(display.locator('.vivic-card[data-focused]')).toHaveCount(1);
  await expect(popup(display).locator("[data-vivic-subcard-arrow]")).toBeVisible();
  await expect.poll(async () => {
    const origin = await displayTrigger.boundingBox(), arrow = await popup(display).locator("[data-vivic-subcard-arrow]").boundingBox();
    return Boolean(origin && arrow && Math.abs(origin.y + origin.height / 2 - arrow.y - arrow.height / 2) < 20);
  }).toBe(true);
  await display.screenshot({ path: path.resolve(process.cwd(), "../../evidence/interaction-details", info.project.name || "chromium", "TEST-row-subcard.png") });
  await popup(display).press("Escape"); await expect(displayTrigger).toBeFocused();
  await controlDispatch(page, "reorder", canvasId, [{ type: "card.update", targetId: "TEST-todo", displayProps: { items: [{ id: "TEST-todo-i2", text: "TEST 写报告（已整理）", done: false }, { id: "TEST-todo-i1", text: "TEST 买菜", done: false }] } }]);
  await displayTrigger.click(); await expect(popup(display)).toContainText("已整理"); await popup(display).press("Escape");
  await page.reload(); await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  await display.reload(); await display.locator('[data-vivic-subcard-trigger="TEST-todo-i2"]').click(); await expect(popup(display)).toContainText("报告补充");
  await sendCommand(page, "删除待办"); await expect(popup(display)).toHaveCount(0);
  await sendCommand(page, "撤销"); await display.locator('[data-vivic-subcard-trigger="TEST-todo-i2"]').click(); await expect(popup(display)).toContainText("报告补充"); expect(errors).toEqual([]);
});

test("duplicate table rows expand independently; edited source rows detach safely and can move to the parent", async ({ page, context }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const canvasId = await boot(page); const display = await context.newPage(); display.on("pageerror", e => errors.push(e.message)); await display.goto(`/display?canvasId=${canvasId}`);
  await controlDispatch(page, "table", canvasId, [{ type: "card.create", card: { ...todoCardRecord("TEST-table", []), type: "TableCard", displayProps: { columns: ["TEST 名称", "数量"], rows: [["TEST 重复", 2], ["TEST 重复", 2], ["TEST 另一项", 4]] }, layout: { x: 0, y: 0, width: 380, height: 240, pinned: false }, metadata: { createdAt: stamp, updatedAt: stamp } } }]);
  await openInspector(page, "TEST-table"); await addChild(page, "TEST-table", "row:2", "TEST 只有第二行的扩充"); await popup(page).press("Escape");
  await expect(display.locator('[data-vivic-subcard-trigger="row:1"]')).toHaveCount(0);
  await display.locator('[data-vivic-subcard-trigger="row:2"]').click(); await expect(popup(display)).toContainText("只有第二行");
  await controlDispatch(page, "edit-row", canvasId, [{ type: "card.update", targetId: "TEST-table", displayProps: { rows: [["TEST 重复", 2], ["TEST 已替换", 3], ["TEST 另一项", 4]] } }]);
  await expect(popup(display)).toHaveCount(0); await expect(display.locator('[data-vivic-subcard-trigger="row:2"]')).toHaveCount(0);
  const detached = inspect(page, "TEST-table").locator("[data-vivic-detached-subcards]"); await expect(detached).toContainText("只有第二行");
  await detached.getByRole("button", { name: "移到整张卡片" }).click(); await expect(detached).toHaveCount(0);
  await display.locator('.vivic-card-expansion [data-vivic-subcard-trigger="card"]').click(); await expect(popup(display)).toContainText("只有第二行"); expect(errors).toEqual([]);
});

test("Note row expansion fits a narrow reduced-motion viewport, scrolls, and closes across same-ID canvas changes", async ({ page, context }, info) => {
  const canvasId = await boot(page); const record = note("TEST-note"); await controlDispatch(page, "note", canvasId, [{ type: "card.create", card: record }]);
  await openInspector(page, "TEST-note"); await addChild(page, "TEST-note", "line:2", "TEST 长扩充内容\n\n" + "这是独立于原文的补充说明。".repeat(90)); await popup(page).press("Escape");
  const display = await context.newPage(); await display.setViewportSize({ width: 390, height: 720 }); await display.emulateMedia({ reducedMotion: "reduce" }); await display.goto("/display");
  await display.locator('[data-vivic-subcard-trigger="line:2"]').click(); await expect(popup(display)).toBeVisible();
  await expect.poll(async () => { const box = await popup(display).boundingBox(); return Boolean(box && box.x >= 0 && box.x + box.width <= 390); }).toBe(true);
  expect(await popup(display).locator(".vivic-subcard-scroll").evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await display.screenshot({ path: path.resolve(process.cwd(), "../../evidence/interaction-details", info.project.name || "chromium", "TEST-narrow-subcard.png") });
  // Prepare another canvas with the same record ID, then open the first popup.
  const persisted = await page.evaluate(() => window.__vivic!.getState().cards[0].record);
  const second = await page.evaluate(() => { const id = window.__vivicControl!.createCanvas("TEST 第二画布"); window.__vivicControl!.switchCanvas(id); return id; });
  await controlDispatch(page, "same-id", second, [{ type: "card.create", card: persisted }]);
  await expect(popup(display)).toHaveCount(0);
  await page.evaluate(id => window.__vivicControl!.switchCanvas(id), canvasId);
  await display.locator('[data-vivic-subcard-trigger="line:2"]').click(); await expect(popup(display)).toContainText("长扩充");
  await page.evaluate(id => window.__vivicControl!.switchCanvas(id), second); await expect(popup(display)).toHaveCount(0);
});

test("losing ownership closes editors and pending choices without modifying cards", async ({ page, context }) => {
  const canvasId = await boot(page); await controlDispatch(page, "seed", canvasId, [{ type: "card.create", card: { ...todoCardRecord("TEST-one", ["TEST 第一项"]), metadata: { createdAt: stamp, updatedAt: stamp, subcards: [{ id: "TEST-saved", itemId: "TEST-one-i1", text: "TEST 已保存扩充" }] } } }, { type: "card.create", card: todoCardRecord("TEST-two", ["TEST 第二项"]) }]);
  await openInspector(page, "TEST-one"); await inspect(page, "TEST-one").locator('[data-vivic-subcard-trigger="TEST-one-i1"]').click(); await popup(page).locator("textarea").fill("TEST 尚未保存");
  const display = await context.newPage(); await display.goto(`/display?canvasId=${canvasId}`); await display.locator('[data-vivic-subcard-trigger="TEST-one-i1"]').click(); await expect(popup(display)).toBeVisible();
  const other = await context.newPage(); await other.goto("/control"); await expect(other.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "readonly");
  await other.locator("[data-vivic-takeover]").click(); await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "readonly"); await expect(popup(page)).toHaveCount(0);
  await expect(popup(display)).toHaveCount(0);
  await sendCommand(other, "删除待办"); await expect(other.locator("[data-vivic-clarify]")).toBeVisible();
  await showChat(page); await page.locator("[data-vivic-takeover]").click(); await expect(other.locator("[data-vivic-clarify]")).toHaveCount(0);
  const cards = await page.evaluate(() => window.__vivic!.getState().cards); expect(cards).toHaveLength(2); expect(JSON.stringify(cards)).not.toContain("尚未保存");
  expect(cards.find(c => c.record.id === "TEST-one")?.record.metadata.subcards?.[0]?.text).toBe("TEST 已保存扩充");
});
