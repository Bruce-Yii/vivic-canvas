import { expect, test } from "@playwright/test";
import { activeCanvasId, gotoControl, gotoDisplay, sendCommand } from "./helpers1";

test("travel DEMO works without a model, blocks forged facts, and refreshes while preserving user notes", async ({ context }, info) => {
  await context.addInitScript(() => {
    localStorage.setItem("vivic.deviceLocation.v1", "off");
    localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", browserVoice: "" }));
  });
  const page = await gotoControl(context);
  const disconnected = await page.request.post("/api/credentials/stepfun/disconnect");
  expect(disconnected.ok()).toBe(true);
  const display = await gotoDisplay(context, await activeCanvasId(page));
  await sendCommand(page, "下周去杭州住两晚，预算500");
  const card = display.locator('[data-scene-card="TravelOffersCard"]');
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card).toContainText("DEMO");
  await expect(card).toContainText("虚构样例");
  await expect(card.getByRole("button", { name: "刷新结果" })).toHaveCount(0);
  const result = await page.evaluate(async () => {
    const path = "/src/sync/browserRuntime.ts";
    const { getControlHost } = await import(/* @vite-ignore */ path);
    const host = await getControlHost();
    const state = window.__vivic!.getState() as { cards: Array<{ record: { id: string; type: string; sourceData: { requestId: string }; displayProps: { items: unknown[]; notes: string } } }> };
    const original = state.cards.find(entry => entry.record.type === "TravelOffersCard")!.record;
    const canvasId = host.getSnapshot().activeCanvasId;
    const forged = host.dispatch({ schemaVersion: "0.6", requestId: "TEST-forged", canvasId,
      actions: [{ type: "card.update", targetId: original.id, displayProps: { mode: "live" } }] });
    const edited = host.dispatch({ schemaVersion: "0.6", requestId: "TEST-personal", canvasId,
      actions: [{ type: "card.update", targetId: original.id, displayProps: { notes: "TEST 用户备注保留" } }] });
    const refreshed = await host.refreshTravelCard(original.id);
    const next = (window.__vivic!.getState() as typeof state).cards.find(entry => entry.record.id === original.id)!.record;
    return { forged, edited, refreshed, beforeRequest: original.sourceData.requestId, afterRequest: next.sourceData.requestId, notes: next.displayProps.notes };
  });
  expect(result.forged.ok).toBe(false); expect(result.edited.ok).toBe(true); expect(result.refreshed.ok).toBe(true);
  expect(result.afterRequest).not.toBe(result.beforeRequest); expect(result.notes).toBe("TEST 用户备注保留");
  await expect(card).toContainText("TEST 用户备注保留", { timeout: 15000 });
  await display.screenshot({ path: info.outputPath("travel-demo-display.png") });
});
