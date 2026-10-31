import { expect, test } from "@playwright/test";
import { activeCanvasId, controlDispatch, gotoControl, todoCardRecord } from "./helpers1";

test.skip(process.env.VIVIC_LIVE_MOBILE !== "1", "Explicit opt-in and a privately provisioned relay are required.");
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    localStorage.setItem("vivic.deviceLocation.v1", "off");
    localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", browserVoice: "" }));
    HTMLMediaElement.prototype.play = async () => {};
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST microphone disabled"); };
  });
});
test("real remote QR, owner commit/save, Display, canvas switching and revocation", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const desktop = await browser.newContext();
  const mobile = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  // These are deliberately separate contexts, so install capture guards in
  // each rather than relying only on the default test fixture's context.
  for (const context of [desktop, mobile]) await context.addInitScript(() => {
    localStorage.setItem("vivic.deviceLocation.v1", "off");
    localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", browserVoice: "" }));
    HTMLMediaElement.prototype.play = async () => { throw new Error("TEST audio disabled"); };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST capture disabled"); };
  });
  try {
    const owner = await gotoControl(desktop), canvasId = await activeCanvasId(owner);
    const target = await owner.evaluate(() => window.__vivicControl!.createCanvas("TEST mobile second canvas"));
    await owner.evaluate(id => window.__vivicControl!.switchCanvas(id), canvasId);
    await controlDispatch(owner, "mobile-seed", canvasId, [{ type: "stage.awaken" }, { type: "card.create", card: todoCardRecord("mobile-owner-todo", ["TEST 手机卡片正文"]) }]);
    const display = await desktop.newPage(); await display.goto("/display");
    await expect(display.locator('[data-card-id="mobile-owner-todo"]')).toHaveCount(1);
    await owner.locator('[data-settings-extra="mobile"] > summary').click();
    await owner.locator("[data-vivic-mobile-start]").click();
    const code = owner.locator("[data-vivic-mobile-pair-code]");
    await expect(code).toHaveText(/^[A-F0-9]{16}$/);
    await expect(owner.getByAltText("手机控制一次性配对二维码")).toBeVisible();
    const phone = await mobile.newPage();
    await phone.goto(`https://edsionc.top/vivic-remote/#pair=${await code.textContent()}`);
    await expect(phone.locator(".mobile-context")).toHaveCount(0);
    await expect(phone.getByRole("tab")).toHaveCount(2);
    expect(new URL(phone.url()).hash).toBe("");
    expect(await phone.evaluate(() => window.__vivicControl)).toBeUndefined();
    expect(await phone.evaluate(async () => (await indexedDB.databases()).length)).toBe(0);
    await phone.getByRole("tab", { name: "Space", exact: true }).click();
    await expect(phone.locator('[data-mobile-card-preview="mobile-owner-todo"]')).toContainText("TEST 手机卡片正文");
    await expect(phone.locator("canvas,.react-flow")).toHaveCount(0);
    await expect(code).toHaveCount(0);
    await phone.getByRole("button", { name: "固定 TEST 手机卡片正文", exact: true }).click();
    await phone.getByRole("tab", { name: "聊天", exact: true }).click();
    await expect(phone.getByText("电脑已固定卡片。", { exact: true })).toBeVisible();
    await expect.poll(() => display.evaluate(() => window.__vivic!.getState().cards.find(card => card.record.id === "mobile-owner-todo")?.record.layout.pinned)).toBe(true);
    const command = phone.getByRole("textbox", { name: "发送给电脑的文字指令" });
    await command.fill("创建便笺：手机远程验收便笺"); await phone.getByRole("button", { name: "发送指令", exact: true }).click();
    await expect(phone.getByText("电脑已执行", { exact: true })).toHaveCount(2);
    await expect(display.getByText("手机远程验收便笺", { exact: true })).toBeVisible();
    await display.reload(); await expect(display.getByText("手机远程验收便笺", { exact: true })).toBeVisible();
    await phone.getByRole("tab", { name: "Space", exact: true }).click();
    await expect(phone.locator(".mobile-card-preview-body").filter({ hasText: "手机远程验收便笺" })).toBeVisible();
    await phone.screenshot({ path: info.outputPath("public-space-owner.png") });
    await phone.getByLabel("目标画布").selectOption(target);
    await expect.poll(() => activeCanvasId(owner)).toBe(target);
    await expect(display.locator('[data-card-id="mobile-owner-todo"]')).toHaveCount(0);
    await phone.getByRole("tab", { name: "聊天", exact: true }).click();
    await expect(phone.getByText("电脑已切换画布。", { exact: true })).toBeVisible();
    await owner.getByRole("button", { name: "撤销授权", exact: true }).click();
    await expect(phone.getByText("授权已撤销", { exact: true })).toBeVisible();
    await owner.locator("[data-vivic-mobile-stop]").click();
  } finally { await mobile.close(); await desktop.close(); }
});
