import { expect, test } from "@playwright/test";
import { activeCanvasId, controlDispatch, gotoControl, gotoDisplay, showChat, openSpace, sendCommand, todoCardRecord } from "./helpers1";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", browserVoice: "" }));
    localStorage.setItem("vivic.deviceLocation.v1", "off");
    HTMLMediaElement.prototype.play = async () => { throw Error("TEST silent"); };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw Error("TEST no device capture"); };
  });
});
test("Space classification, preview, collapse, undo/redo and natural light commands use the actual owner", async ({ context }, info) => {
  const owner = await gotoControl(context), id = await activeCanvasId(owner);
  const note = { ...todoCardRecord("TEST-note", []), type: "NoteCard", displayProps: { text: "TEST 旅行资料" }, layout: { x: 0, y: 0, width: 300, height: 180, pinned: false }, metadata: { createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z", dueDate: "2026-11-01" } };
  await controlDispatch(owner, "seed-organizer", id, [{ type: "stage.awaken" }, { type: "card.create", card: note },
    { type: "card.create", card: todoCardRecord("TEST-todo", ["TEST 确认酒店", "TEST 整理行李"]) }]);
  const display = await gotoDisplay(context, id);
  const before = await owner.evaluate(() => window.__vivic!.getState().cards.map(c => c.record));
  const space = await openSpace(owner, "卡片");
  await space.locator('[data-space-organizer] > summary').click();
  await space.getByLabel("分区方式", { exact: true }).selectOption("type");
  await space.getByRole("button", { name: "预览整理", exact: true }).click();
  await expect(space.getByLabel("整理预览", { exact: true })).toContainText("TEST 旅行资料");
  expect(await owner.evaluate(() => window.__vivic!.getState().cards.map(c => c.record))).toEqual(before);
  await space.getByRole("button", { name: "应用整理", exact: true }).click();
  await expect(space.getByRole("status")).toContainText("已整理并保存");
  await expect(display.locator('[data-space-section="便笺"]')).toBeVisible();
  await display.getByRole("button", { name: "收起分区：便笺", exact: true }).click();
  await expect(display.locator('[data-card-id="TEST-note"]')).toHaveCount(0);
  await display.getByRole("button", { name: "展开分区：便笺", exact: true }).click();
  await expect(display.locator('[data-card-id="TEST-note"]')).toBeVisible();
  await display.screenshot({ path: info.outputPath("space-section-real.png") });
  await space.getByRole("navigation", { name: "Space 管理", exact: true }).getByRole("button", { name: "空间", exact: true }).click();
  await space.locator('[data-vivic-undo]').click();
  await expect.poll(() => owner.evaluate(() => window.__vivic!.getState().cards.map(c => c.record))).toEqual(before);
  await expect(display.locator('[data-space-section]')).toHaveCount(0);
  await space.locator('[data-vivic-redo]').click();
  await expect(display.locator('[data-space-section="便笺"]')).toBeVisible();
  await showChat(owner);
  await sendCommand(owner, "暂停背景动画");
  await expect.poll(() => owner.evaluate(() => window.__vivicControl!.snapshot().preferences.ambientMotion)).toBe("off");
  await sendCommand(owner, "增强光效");
  await expect.poll(() => owner.evaluate(() => window.__vivicControl!.snapshot().preferences.ambientMotion)).toBe("vivid");
  await sendCommand(owner, "按优先级排序");
  await expect(owner.getByRole("dialog", { name: "Vivic Space", exact: true })).toBeVisible();
  await expect(owner.getByLabel("整理预览", { exact: true })).toBeVisible();
  await owner.screenshot({ path: info.outputPath("natural-organization-preview.png") });
});
