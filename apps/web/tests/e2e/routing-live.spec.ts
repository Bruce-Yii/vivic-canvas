import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { activeCanvasId, showChat } from "./helpers1";

// Explicit opt-in only. The test API is a separate loopback process with a
// controlled classifier and the one authorized real model through an in-memory
// proxy. No provider key or production canvas is accessible to this browser.
test.skip(process.env.VIVIC_ROUTING_LIVE !== "1", "requires the explicitly started isolated live test API");

const cases = process.env.VIVIC_ROUTING_COMPARE_RULES === "1" ? [
  { id: "todo", text: "加待办：买牛奶、交周报、预约体检", types: ["TodoCard"], calls: 0 },
  { id: "note-timer", text: "记个便笺明天交周报，再设个50分钟倒计时", types: ["NoteCard", "CountdownCard"], calls: 0 },
] : [
  { id: "todo", text: "加一个待办：买牛奶；交周报；预约体检", types: ["TodoCard"], calls: 0 },
  { id: "note-timer", text: "记个便笺明天交周报，再设个50分钟倒计时", types: ["NoteCard", "CountdownCard"], calls: 0 },
  { id: "answer", text: "解释一下光合作用，做成知识卡片", types: ["NewsCard"], calls: 1 },
];
for (const item of cases) test(`isolated actual API and owner receipt: ${item.id}`, async ({ page, context, request }, testInfo) => {
  const endpoint = process.env.VIVIC_ROUTING_TEST_API ?? "http://localhost:46033";
  const before = await (await request.get(`${endpoint}/routing-test-metrics`)).json();
  page.on("requestfailed", failed => { if (failed.url().includes("/api/intent")) console.log(item.id, "intent transport", failed.failure()?.errorText); });
  const requests: unknown[] = []; let results: any[] = [], modelFeedback: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", wakeEnabled: false }));
    localStorage.setItem("vivic.reminders.sound.v1", "0");
  });
  await page.route("**/api/intent", async route => {
    requests.push(route.request().postDataJSON());
    await route.continue({ url: `${endpoint}/api/intent`, headers: { ...route.request().headers(), authorization: "Bearer routing-local-test-token-12345678" } });
  });
  await page.goto("/control");
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  const canvasId = await activeCanvasId(page);
  const display = await context.newPage(); await display.goto(`/display?canvasId=${canvasId}`);
  await display.evaluate(() => {
    (window as any).__routingCardObservations = [];
    const sample = () => {
      const count = Array.from(document.querySelectorAll("[data-card-id]")).filter(el => {
        const bounds = el.getBoundingClientRect(), style = getComputedStyle(el);
        return bounds.width > 0 && bounds.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }).length;
      if (count) (window as any).__routingCardObservations.push({ at: Date.now(), count });
    };
    setInterval(sample, 16);
  });
  await showChat(page);
  await page.evaluate(value => window.dispatchEvent(new CustomEvent("vivic:template-draft", { detail: value })), item.text);
  await expect(page.locator("[data-vivic-command-input]")).toHaveValue(item.text);
  const start = Date.now();
  await page.evaluate(() => {
    (window as any).__routingObservations = [];
    const observe = () => {
      const el = document.querySelector("[data-vivic-command-feedback]");
      (window as any).__routingObservations.push({ at: Date.now(), text: el?.textContent ?? "" });
    };
    new MutationObserver(observe).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await page.locator("[data-vivic-command-send]").click();
  await expect.poll(async () => {
    const metrics = await (await request.get(`${endpoint}/routing-test-metrics`)).json();
    const received = metrics.responses.slice(before.responses.length);
    results = received.map((value: any) => value.result);
    modelFeedback = received.flatMap((value: any) => value.feedback);
    return results.some(result => result.task?.status === "completed");
  }, { timeout: 60_000 }).toBe(true);
  const completedMs = Date.now() - start;
  const state = await page.evaluate(() => window.__vivic!.getState()) as { cards: { record: { type: string; displayProps: any; sourceData: any; id: string } }[] };
  expect(state.cards.map(card => card.record.type)).toEqual(item.types);
  if (item.id === "todo") expect(state.cards[0]!.record.displayProps.items.map((row: { text: string }) => row.text)).toEqual(["买牛奶", "交周报", "预约体检"]);
  if (item.id === "note-timer") {
    expect(state.cards[0]!.record.displayProps.text).toBe("明天交周报");
    const source = state.cards[1]!.record.sourceData;
    expect(Date.parse(source.targetAt) - Date.parse(source.startedAt)).toBe(50 * 60_000);
  }
  for (const card of state.cards) await expect(display.locator(`[data-card-id="${card.record.id}"]`)).toBeVisible();
  const visibleMs = Date.now() - start;
  const observations = await page.evaluate(() => (window as any).__routingObservations) as Array<{ at: number; text: string }>;
  const cardObservations = await display.evaluate(() => (window as any).__routingCardObservations) as Array<{ at: number; count: number }>;
  expect(cardObservations.length).toBeGreaterThan(0);
  const firstCardVisibleMs = cardObservations[0]!.at - start;
  const after = await (await request.get(`${endpoint}/routing-test-metrics`)).json();
  expect(after.modelHttpCalls - before.modelHttpCalls).toBe(item.calls);
  const proposal = results.find(result => result.envelope);
  const trace = proposal?.trace;
  const firstFeedback = observations.find(value => modelFeedback.includes(value.text));
  if (item.calls) {
    expect(modelFeedback.length).toBeGreaterThan(0);
    expect(firstFeedback).toBeDefined(); expect(firstFeedback!.at - start).toBeLessThan(firstCardVisibleMs);
  }
  const evidence = JSON.stringify({
    entry: "existing template-draft then real submit; typing and speech not validated", classifier: "controlled", model: "deepseek-v4.1-flash",
    modelHttpCalls: after.modelHttpCalls - before.modelHttpCalls, firstFeedbackVisibleMs: firstFeedback ? firstFeedback.at - start : null,
    firstCardVisibleMs, completedReceiptObservedMs: completedMs, allCardsVisibleCheckedMs: visibleMs,
    observations: observations.map(value => ({ ms: value.at - start, text: value.text })), requests, results, trace,
  }, null, 2);
  const evidencePath = testInfo.outputPath(`routing-${item.id}-live.json`);
  await writeFile(evidencePath, evidence);
  await testInfo.attach(`routing-${item.id}-live`, { contentType: "application/json", path: evidencePath });
  await display.close();
});
