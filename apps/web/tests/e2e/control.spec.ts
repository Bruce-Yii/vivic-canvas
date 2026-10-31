import { expect, test } from "@playwright/test";
import path from "node:path";
import {
  EVIDENCE1,
  activeCanvasId,
  controlDispatch,
  gotoControl,
  gotoDisplay,
  sendCommand,
  openSpace,
  todoCardRecord,
} from "./helpers1";

/**
 * Scenario 1 (ACCEPTANCE.md §E), driven end-to-end through /control text
 * commands: countdown is digit-only on /display, focus moves the camera only,
 * delete+undo restores without duplicates.
 */
test("Scenario 1: minimal countdown via text commands", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext();
  const A = await gotoControl(context);
  const canvasId = await activeCanvasId(A);
  const B = await gotoDisplay(context, canvasId);

  // Create "十分钟倒计时" from the command input.
  await sendCommand(A, "十分钟倒计时");
  await expect(B.locator(".vivic-card")).toHaveCount(1, { timeout: 8000 });
  const countdown = B.locator(".vivic-card").first();
  const digits = ((await countdown.locator('[data-aui="text"]').textContent()) ?? "").trim();
  expect(digits).toMatch(/^\d{1,2}:\d{2}$/);
  expect(digits).toMatch(/^[\d:\s]+$/); // no labels around the digits
  await B.screenshot({ path: path.join(EVIDENCE1, "display-countdown-command.png") });

  // Creating a card now auto-focuses it. End that focus chain before measuring
  // a fresh manual-pan → focus → restore sequence (restore preserves a chain's
  // original camera, rather than replacing it on every repeated focus).
  await sendCommand(A, "显示全部");
  await expect.poll(() => B.evaluate(() => window.__vivic!.getState().focus)).toBeNull();

  // A single card already at the center may legitimately keep its camera.
  // Pan the real viewport first so this scenario tests an actual focus move.
  const transform = () =>
    B.locator(".react-flow__viewport").evaluate(
      (el) => (el as HTMLElement).style.transform,
    );
  await expect.poll(async () => {
    const box = await countdown.boundingBox();
    return box ? Math.abs(box.x + box.width / 2 - B.viewportSize()!.width / 2) : Infinity;
  }).toBeLessThan(2);
  const centered = await transform();
  await B.mouse.move(80, 80);
  await B.mouse.down();
  await B.mouse.move(260, 200, { steps: 10 });
  await B.mouse.up();
  await expect.poll(transform).not.toBe(centered);
  const before = await transform();
  const record = await B.evaluate(() => window.__vivic!.getState().cards[0]!.record);
  await sendCommand(A, "放大倒计时");
  await expect(countdown).toHaveAttribute("data-focused", "true");
  await expect.poll(transform).not.toBe(before);
  await expect.poll(async () => {
    const box = await countdown.boundingBox();
    return box ? Math.abs(box.x + box.width / 2 - B.viewportSize()!.width / 2) : Infinity;
  }).toBeLessThan(2);
  expect(await B.evaluate(() => window.__vivic!.getState().cards[0]!.record)).toEqual(record);
  // Card text unchanged in kind (digit-only); the value keeps ticking.
  expect(((await countdown.locator('[data-aui="text"]').textContent()) ?? "").trim()).toMatch(/^[\d:\s]+$/);

  await sendCommand(A, "恢复原视图");
  await expect.poll(transform).toBe(before);

  // 删除这个 + confirm-free unique hit, then 撤销 restores. No duplicates.
  await sendCommand(A, "删除这个");
  await expect(B.locator(".vivic-card")).toHaveCount(0, { timeout: 5000 });
  await openSpace(A);
  await A.locator("[data-vivic-undo]").click();
  await expect(B.locator(".vivic-card")).toHaveCount(1, { timeout: 5000 });
  await expect(B.locator(".vivic-card")).toHaveCount(1);
  const restored = ((await B.locator(".vivic-card").first().locator('[data-aui="text"]').textContent()) ?? "").trim();
  expect(restored).toMatch(/^[\d:\s]+$/);
  await context.close();
});

/** B05: ambiguous 删除那个 highlights candidates and deletes nothing until picked. */
test("B05: ambiguous delete clarifies, never deletes blindly", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const context = await browser.newContext();
  const A = await gotoControl(context);
  const canvasId = await activeCanvasId(A);
  const B = await gotoDisplay(context, canvasId);

  await sendCommand(A, "加待办：合同初审");
  await expect(B.locator(".vivic-card")).toHaveCount(1, { timeout: 8000 });
  await sendCommand(A, "添加待办：周报大纲");
  await expect(B.locator(".vivic-card")).toHaveCount(2, { timeout: 8000 });

  // Vague destructive intent: no deletion, clarification with 2 candidates.
  await sendCommand(A, "删除那个卡片");
  await expect(A.locator("[data-vivic-clarify]")).toBeVisible();
  await expect(A.locator("[data-vivic-clarify-candidate]")).toHaveCount(2);
  await A.screenshot({ path: path.join(EVIDENCE1, "control-clarification.png") });
  await expect(B.locator(".vivic-card")).toHaveCount(2);
  await B.screenshot({ path: path.join(EVIDENCE1, "display-clarify-highlight.png") });

  // Picking a candidate performs the real, undoable delete.
  await A.locator("[data-vivic-clarify-candidate]").first().click();
  await expect(B.locator(".vivic-card")).toHaveCount(1, { timeout: 5000 });
  await expect(A.locator("[data-vivic-clarify]")).toHaveCount(0);
  await openSpace(A);
  await A.locator("[data-vivic-undo]").click();
  await expect(B.locator(".vivic-card")).toHaveCount(2, { timeout: 5000 });
  await A.screenshot({ path: path.join(EVIDENCE1, "control-page.png") });
  await context.close();
});

/** B06: canvas create/rename/switch + restart restore from IndexedDB. */
test("B06: canvases persist across reload, switch keeps per-canvas state", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const context = await browser.newContext();
  const A = await gotoControl(context);
  await openSpace(A);
  await expect(A.locator("[data-vivic-canvas-list] li")).toHaveCount(1);

  // Create + switch to a new canvas, put a card on it.
  await A.locator("[data-vivic-canvas-create]").click();
  await expect(A.locator("[data-vivic-canvas-list] li")).toHaveCount(2);
  await sendCommand(A, "十分钟倒计时");
  await A.waitForTimeout(800);
  const secondCanvasId = await activeCanvasId(A);
  await openSpace(A);

  // Rename it. (Entering edit mode swaps the row contents, so re-locate.)
  const row = A.locator(`[data-vivic-canvas-item="${secondCanvasId}"]`).locator("..");
  await row.getByText("重命名", { exact: true }).click();
  await A.locator('input[aria-label="画布名称"]').fill("演示画布");
  await A.getByText("保存", { exact: true }).click();
  await expect(A.locator(`[data-vivic-canvas-item="${secondCanvasId}"]`)).toContainText(
    "演示画布",
  );

  // Browser restart (reload) restores: registry, active canvas, cards.
  await A.waitForTimeout(800); // debounced autosave
  await A.reload();
  await A.waitForSelector('[data-vivic-control="ready"]');
  await openSpace(A);
  await expect(A.locator(`[data-vivic-canvas-item="${secondCanvasId}"]`)).toContainText(
    "演示画布",
  );
  expect(await activeCanvasId(A)).toBe(secondCanvasId);
  const restored = await A.evaluate(
    () =>
      (window as unknown as { __vivic: { getState: () => { cards: unknown[] } } })
        .__vivic.getState().cards.length,
  );
  expect(restored).toBe(1);

  // Switching back to the other (original, still empty) canvas.
  const firstItem = A.locator(
    `[data-vivic-canvas-item]:not([data-vivic-canvas-item="${secondCanvasId}"])`,
  ).first();
  await firstItem.click();
  await A.waitForTimeout(500);
  const firstState = await A.evaluate(
    () =>
      (window as unknown as { __vivic: { getState: () => { cards: unknown[] } } })
        .__vivic.getState().cards.length,
  );
  expect(firstState).toBe(0);
  await context.close();
});

/** Display pinned to canvas A must not follow the owner to canvas B. */
test("pinned display stays on its canvas when the owner switches", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const context = await browser.newContext();
  const A = await gotoControl(context);
  const firstCanvas = await activeCanvasId(A);
  const B = await gotoDisplay(context, firstCanvas);
  await controlDispatch(A, "todo", firstCanvas, [
    { type: "stage.awaken" },
    { type: "card.create", card: todoCardRecord("pin-todo", ["固定画布任务"]) },
  ]);
  await expect(B.locator('[data-card-id="pin-todo"]')).toContainText("固定画布任务");

  await openSpace(A);
  await A.locator("[data-vivic-canvas-create]").click();
  const secondCanvas = await activeCanvasId(A);
  expect(secondCanvas).not.toBe(firstCanvas);
  await sendCommand(A, "加待办：别的画布任务");
  await A.waitForTimeout(1000);
  // B still shows the pinned canvas' card and nothing from the new canvas.
  await expect(B.locator('[data-card-id="pin-todo"]')).toContainText("固定画布任务");
  await expect(B.locator(".vivic-card")).toHaveCount(1);
  const text = await B.evaluate(() => document.body.innerText);
  expect(text).not.toContain("别的画布任务");
  await context.close();
});
