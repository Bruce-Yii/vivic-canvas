import { expect, test } from "@playwright/test";
import path from "node:path";
import {
  EVIDENCE1,
  activeCanvasId,
  controlDispatch,
  gotoControl,
  gotoDisplay,
  showChat,
  todoCardRecord,
} from "./helpers1";

/**
 * Scenario 2 (ACCEPTANCE.md §E): A=/control, B=/display?canvasId=…, one patch,
 * update item 2, B refresh => snapshot, close A => B keeps last frame,
 * A reopens => B resyncs without duplicated actions.
 * Records the display side as rec-d-dual-window-sync.webm.
 */
test("Scenario 2: web dual-window sync", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: EVIDENCE1, size: { width: 1440, height: 900 } },
  });

  // 1. A=/control, B=/display?canvasId=…
  const A = await gotoControl(context);
  const canvasId = await activeCanvasId(A);
  const B = await gotoDisplay(context, canvasId);
  await B.waitForSelector('[data-vivic-stage]', { timeout: 8000 });

  // 2. A creates a 3-item todo; B receives exactly one patch.
  const createEnv = await controlDispatch(A, "todo", canvasId, [
    { type: "stage.awaken" },
    {
      type: "card.create",
      card: todoCardRecord("s2-todo", ["买牛奶", "写周报", "约牙医"]),
    },
  ]);
  await expect(B.locator('[data-card-id="s2-todo"]')).toHaveCount(1);
  await expect(B.locator('[data-card-id="s2-todo"]')).toContainText("买牛奶");
  await expect(B.locator('[data-card-id="s2-todo"]')).toContainText("写周报");
  await expect(B.locator('[data-card-id="s2-todo"]')).toContainText("约牙医");
  // The single patch ran exactly once on B (requestId idempotence).
  await expect
    .poll(async () =>
      B.evaluate(
        (rid) =>
          (
            window as unknown as {
              __vivic: { getState: () => { processedRequestIds: string[] } };
            }
          ).__vivic.getState().processedRequestIds.filter((id) => id === rid)
            .length,
        createEnv.requestId,
      ),
    )
    .toBe(1);
  await B.screenshot({ path: path.join(EVIDENCE1, "display-synced-todo.png") });

  //    A edits item 2; B updates correctly.
  await controlDispatch(A, "update", canvasId, [
    {
      type: "card.update",
      targetId: "s2-todo",
      displayProps: {
        items: [
          { id: "s2-todo-i1", text: "买牛奶", done: false },
          { id: "s2-todo-i2", text: "写周报（已改）", done: false },
          { id: "s2-todo-i3", text: "约牙医", done: false },
        ],
      },
    },
  ]);
  await expect(B.locator('[data-card-id="s2-todo"]')).toContainText(
    "写周报（已改）",
  );

  // 3. B refreshes => snapshot; same three items.
  await B.reload();
  await expect(B.locator('[data-card-id="s2-todo"]')).toContainText("买牛奶");
  await expect(B.locator('[data-card-id="s2-todo"]')).toContainText(
    "写周报（已改）",
  );
  await expect(B.locator('[data-card-id="s2-todo"]')).toContainText("约牙医");
  await expect(B.locator(".vivic-card")).toHaveCount(1);

  // 4. Close A (owner gone) => B keeps the last frame, no error chrome.
  await A.close();
  await B.waitForTimeout(1200);
  await expect(B.locator('[data-card-id="s2-todo"]')).toContainText("约牙医");
  const bodyText = await B.evaluate(() => document.body.innerText);
  expect(bodyText).not.toMatch(/错误|error|disconnected|断线|失去连接/i);

  //    A reopens => B resyncs; no replayed duplicates.
  const A2 = await gotoControl(context);
  await B.waitForTimeout(1500);
  await expect(B.locator(".vivic-card")).toHaveCount(1);
  await expect(B.locator('[data-card-id="s2-todo"]')).toHaveCount(1);

  //    New owner keeps driving B.
  await controlDispatch(A2, "update2", canvasId, [
    {
      type: "card.update",
      targetId: "s2-todo",
      displayProps: {
        items: [
          { id: "s2-todo-i1", text: "买牛奶", done: true },
          { id: "s2-todo-i2", text: "写周报（已改）", done: false },
          { id: "s2-todo-i3", text: "约牙医", done: false },
        ],
      },
    },
  ]);
  await A2.waitForTimeout(600);
  await B.screenshot({ path: path.join(EVIDENCE1, "display-after-reopen.png") });
  await expect(B.locator('[data-card-id="s2-todo"]')).toContainText("约牙医");
  await expect(B.locator(".vivic-card")).toHaveCount(1);

  await B.close();
  await A2.close();
  await context.close();
  const video = B.video();
  if (video) await video.saveAs(path.join(EVIDENCE1, "rec-d-dual-window-sync.webm"));
});

/** B01: the open-display button opens /display pinned to the active canvas. */
test("B01: 打开 Vivic 展示窗口 opens a pinned display window", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem("vivic.deviceLocation.v1", "off");
    localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", browserVoice: "" }));
  });
  await context.route("https://huggingface.co/**", route => route.abort());
  const A = await gotoControl(context);
  const canvasId = await activeCanvasId(A);
  await showChat(A);
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    A.getByRole("button", { name: "展示窗口", exact: true }).click(),
  ]);
  await popup.waitForLoadState("domcontentloaded");
  expect(popup.url()).toContain("/display");
  expect(popup.url()).toContain(`canvasId=${encodeURIComponent(canvasId)}`);
  await expect(popup.getByRole("button", { name: "点击隐藏顶部栏", exact: true })).toBeVisible();
  await expect(popup.locator("[data-vivic-stage]")).toBeVisible();
  await popup.close();
  await context.close();
});

/** B02: standby stays empty; workspace exposes only the explicitly requested canvas controls. */
test("B02: /display exposes portal/view controls without settings or debug chrome", async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem("vivic.deviceLocation.v1", "off");
    localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", browserVoice: "" }));
  });
  await context.route("https://huggingface.co/**", route => route.abort());
  // Standby: only the temporary entry hint is allowed; dismissing it leaves no text.
  const standby = await context.newPage();
  await standby.goto("/display");
  await standby.waitForSelector(".siri-orb");
  await standby.getByRole("button", { name: "关闭全屏提示", exact: true }).click();
  await standby.waitForTimeout(800);
  expect((await standby.evaluate(() => document.body.innerText.trim()))).toBe("");
  await standby.close();

  // Workspace permits the portal, fit/restore and two per-card actions.
  // Exact counts still reject additional persistent settings/debug controls.
  const A = await gotoControl(context);
  const canvasId = await activeCanvasId(A);
  const B = await gotoDisplay(context, canvasId);
  await B.getByRole("button", { name: "关闭全屏提示", exact: true }).click();
  await controlDispatch(A, "todo", canvasId, [
    { type: "stage.awaken" },
    { type: "card.create", card: todoCardRecord("b02-todo", ["任务甲"]) },
  ]);
  await expect(B.locator('[data-card-id="b02-todo"]')).toContainText("任务甲");
  const controls = B.getByRole("navigation", { name: "展示画布操作", exact: true });
  await expect(controls).toBeVisible();
  await expect(controls.locator("button")).toHaveCount(3);
  const portal = controls.getByRole("button", { name: "卡片传送门", exact: true });
  await expect(portal).toBeVisible();
  await expect(portal.locator(".vivic-portal-count")).toHaveText("1");
  await expect(controls.getByRole("button", { name: "显示全部", exact: true })).toBeEnabled();
  await expect(controls.getByRole("button", { name: "恢复视图", exact: true })).toBeDisabled();
  const cardActions = B.getByRole("group", { name: "任务甲的操作", exact: true });
  await expect(cardActions.locator("button")).toHaveCount(2);
  await expect(cardActions.getByRole("button", { name: "聚焦：任务甲", exact: true })).toBeEnabled();
  await expect(cardActions.getByRole("button", { name: "传送到用户页：任务甲", exact: true })).toBeEnabled();
  await expect(B.locator("button")).toHaveCount(5);
  await expect(B.locator("nav")).toHaveCount(1);
  await expect(B.locator("[data-vivic-devpanel]")).toHaveCount(0);
  const text = await B.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/设置|控制端|DEV|debug|Vivic 控制|token|模型/i);
  await context.close();
});

/** Single-owner: second /control tab is read-only, takeover transfers ownership. */
test("single owner: second control is read-only until takeover", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const A = await gotoControl(context);
  await expect(A.locator("[data-vivic-control]")).toHaveAttribute(
    "data-vivic-owner",
    "owner",
  );

  const B = await gotoControl(context);
  await expect(B.locator("[data-vivic-control]")).toHaveAttribute(
    "data-vivic-owner",
    "readonly",
  );
  await expect(B.locator("[data-vivic-readonly-notice]")).toBeVisible();
  await B.screenshot({ path: path.join(EVIDENCE1, "control-readonly-second-tab.png") });

  // Read-only side cannot dispatch.
  const canvasId = await activeCanvasId(B);
  const rejected = await B.evaluate(
    (raw) =>
      (window as unknown as { __vivic: { dispatch: (r: unknown) => unknown } })
        .__vivic.dispatch(raw),
    {
      schemaVersion: "0.6",
      requestId: `e2e-p1-readonly-${Date.now()}`,
      canvasId,
      actions: [{ type: "canvas.fit" }],
    },
  );
  expect(rejected).toEqual({ ok: false, error: "readonly-not-owner" });

  // Takeover: B becomes owner, A demotes itself.
  await B.locator("[data-vivic-takeover]").click();
  await expect(B.locator("[data-vivic-control]")).toHaveAttribute(
    "data-vivic-owner",
    "owner",
  );
  await expect(A.locator("[data-vivic-control]")).toHaveAttribute(
    "data-vivic-owner",
    "readonly",
  );
  await context.close();
});
