import { expect, test } from "@playwright/test";
import { readIntentResult, activeCanvasId, controlDispatch, sendCommand, todoCardRecord } from "./helpers1";
test("exact view and reference actions route through the backend without LLM generation; ambiguity remains safe", async ({ page, context }) => {
  let requests = 0;
  page.on("response", async response => { if (response.url().endsWith("/api/intent")) { const result = await readIntentResult(response); if (result.usedProvider === "stepfun" || result.usedProvider === "gpt") requests++; } });
  await page.goto("/control"); await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  const canvasId = await activeCanvasId(page);
  await controlDispatch(page, "TEST-fast", canvasId, [{ type: "stage.awaken" },
    { type: "card.create", card: todoCardRecord("TEST-fast-a", ["TEST first"]) }, { type: "card.create", card: todoCardRecord("TEST-fast-b", ["TEST second"]) }]);
  const display = await context.newPage(); await display.goto(`/display?canvasId=${canvasId}`);
  await sendCommand(page, "显示全部"); await expect(page.locator("[data-vivic-command-feedback]")).toContainText("已显示全部");
  await sendCommand(page, "聚焦左边的待办"); await expect(page.locator("[data-vivic-command-feedback]")).toContainText("已聚焦");
  await sendCommand(page, "恢复原视图"); await expect(page.locator("[data-vivic-command-feedback]")).toContainText("已恢复");
  await sendCommand(page, "删除待办"); await expect(page.locator("[data-vivic-clarify-candidate]")).toHaveCount(2);
  await page.locator("[data-vivic-clarify-candidate]").first().click(); await expect(display.locator(".vivic-card")).toHaveCount(1);
  await sendCommand(page, "撤销"); await expect(display.locator(".vivic-card")).toHaveCount(2);
  expect(requests).toBe(0); await display.close();
});
