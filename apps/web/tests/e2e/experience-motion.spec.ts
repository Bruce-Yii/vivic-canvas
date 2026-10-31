import { test, expect } from "@playwright/test";
import path from "node:path";
import { activeCanvasId, controlDispatch, openSpace, openPreferences, showChat } from "./helpers1";
import { testCards } from "../../src/cards/__tests__/fixtures";

// A short, silent recording of the actual Control flow. Explicit dwell time
// below is for human viewing of the evidence, never a readiness assertion.
test("TEST record reading and quick-find transitions", async ({ browser }, info) => {
  const dir = path.resolve(process.cwd(), "../../evidence/experience-20261016/final", info.project.use.browserName ?? "chromium");
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, recordVideo: { dir: path.join(dir, "video"), size: { width: 1100, height: 800 } } });
  await context.addInitScript(() => {
    HTMLMediaElement.prototype.play = async () => { throw new Error("TEST no audio"); };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error("TEST no microphone"); };
  });
  const page = await context.newPage(), video = page.video();
  try {
    await page.goto("/control"); await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
    const canvasId = await activeCanvasId(page);
    await controlDispatch(page, "TEST-record", canvasId, [{ type: "card.create", card: { ...testCards.NoteCard,
      metadata: { ...testCards.NoteCard.metadata, aliases: ["TEST 上海发布会阅读记录"] }, displayProps: { text: "## TEST 阅读记录\n\n先核对今天的进度，再整理发布会材料。\n\n中文正文保持自然换行，来源与结论分开记录。\n\n**下一步**：逐项确认体验优化结果。", bullets: ["阅读时可选择和复制原文", "关闭详情后回到原入口"] } } }]);
    await showChat(page); await page.keyboard.press("Control+k");
    const find = page.locator("[data-vivic-quick-find]"), input = find.getByRole("combobox");
    await expect(input).toBeFocused(); await input.pressSequentially("shanghai", { delay: 120 });
    await expect(page.locator("[data-vivic-find-result]")).toHaveCount(1);
    await page.waitForTimeout(900); await input.press("Enter"); await expect(find).toHaveCount(0);
    await openSpace(page, "卡片");
    const trigger = page.locator('[data-vivic-read-details="TEST-note"]'); await trigger.click();
    const detail = page.locator("[data-vivic-card-details]"); await expect(detail).toHaveCSS("opacity", "1");
    await page.waitForTimeout(1300); await detail.getByRole("button", { name: "关闭窗口" }).click(); await expect(trigger).toBeFocused();
    await openPreferences(page, true); await page.getByRole("switch", { name: "减少动效" }).check(); await openSpace(page, "卡片"); await trigger.click();
    await expect(detail).toHaveAttribute("data-reduced-motion", "true"); await expect(detail).toHaveCSS("opacity", "1");
    await page.waitForTimeout(900); await page.keyboard.press("Escape");
  } finally {
    await context.close(); await video?.saveAs(path.join(dir, "TEST-reading-search-motion.webm"));
  }
});
