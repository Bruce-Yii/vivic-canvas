import { expect, test as base, type Page } from "@playwright/test";
import http, { type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { activeCanvasId, showChat, todoCardRecord } from "./helpers1";

// This is a controlled transport test, not a real-model latency measurement.
// The local HTTP server flushes SSE frames separately, so the browser has to render
// progress before the final envelope exists rather than receiving a buffered fixture.
type HeldIntent = {
  body: { text: string; canvasContext: { canvasId: string; version: number }; task: { id: string } };
  response: ServerResponse;
  id: string;
};
type SseFixture = { url: string; requests: HeldIntent[] };
const test = base.extend<{ sse: SseFixture }>({
  sse: async ({}, use) => {
    const requests: HeldIntent[] = [];
    const server = http.createServer((request, response) => {
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("access-control-allow-headers", "content-type,accept");
      response.setHeader("access-control-allow-methods", "POST,OPTIONS");
      if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
      let body = "";
      request.on("data", chunk => { body += String(chunk); });
      request.on("end", () => {
        const parsed = JSON.parse(body);
        if (parsed.task?.cancel) {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ kind: "error", message: "已取消本次请求" }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.flushHeaders();
        const held = { body: parsed, response, id: `controlled-${requests.length + 1}` };
        requests.push(held);
        frame(held, "accepted", { requestId: held.id });
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("SSE fixture did not bind a port");
    try { await use({ requests, url: `http://127.0.0.1:${address.port}/intent` }); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  },
});

const frame = (held: HeldIntent, event: string, data: unknown) => {
  held.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};
const progress = (held: HeldIntent, stage: string, feedback?: string) => frame(held, "progress", {
  requestId: held.id, stage, status: "started", ...(feedback ? { feedback } : {}),
});
const complete = (held: HeldIntent, cardId: string, message: string) => {
  frame(held, "result", { kind: "envelope", usedProvider: "stepfun", envelope: {
    schemaVersion: "0.6", requestId: `result-${held.id}`, canvasId: held.body.canvasContext.canvasId,
    spokenText: message, actions: [{ type: "stage.awaken" }, { type: "card.create", card: todoCardRecord(cardId, ["保留用户原文"]) }],
  } });
  held.response.end();
};
const sendCommand = async (page: Page, text: string) => {
  await showChat(page);
  // Exercise the existing template-draft entry then the real submit control.
  // Native text entry in this baseline's test environment clears its draft;
  // this test does not claim to validate typing or speech capture.
  await page.evaluate(value => window.dispatchEvent(new CustomEvent("vivic:template-draft", { detail: value })), text);
  await expect(page.locator("[data-vivic-command-input]")).toHaveValue(text);
  await page.locator("[data-vivic-command-send]").click();
};
const ready = async (page: Page, sse: SseFixture) => {
  page.on("pageerror", error => console.error("routing feedback browser error:", error.message));
  page.on("console", message => { if (message.type() === "error") console.error("routing feedback console:", message.text()); });
  page.on("requestfailed", request => { if (request.url().includes("/api/intent")) console.error("routing feedback transport error:", request.failure()?.errorText); });
  await page.addInitScript(() => {
    localStorage.setItem("vivic.voice.providers.v1", JSON.stringify({ stt: "none", tts: "none", wakeEnabled: false }));
    localStorage.setItem("vivic.reminders.sound.v1", "0");
  });
  await page.route("**/api/intent", route => route.continue({ url: sse.url }));
  await page.goto("/control");
  await page.waitForSelector('[data-vivic-control="ready"]');
  await expect(page.locator("[data-vivic-control]")).toHaveAttribute("data-vivic-owner", "owner");
  await expect.poll(() => activeCanvasId(page)).toBeTruthy();
};

test("model feedback appears before the card, survives stages and the slow timer without changing the canvas", async ({ page, context, sse }, testInfo) => {
  await ready(page, sse);
  const canvasId = await activeCanvasId(page);
  const display = await context.newPage();
  await display.goto(`/display?canvasId=${canvasId}`);
  await page.clock.install();
  const submittedAt = Date.now();
  await sendCommand(page, "请把原文仔细整理成待办");
  await expect.poll(() => sse.requests.length).toBe(1);
  const held = sse.requests[0]!;
  const initialVersion = held.body.canvasContext.version;
  const sentence = "我会保留原文，把要做的事情整理成待办。";
  // Split inside the JSON string: no partial JSON should reach either UI.
  const event = `event: progress\ndata: ${JSON.stringify({ requestId: held.id, stage: "planner", status: "started", feedback: sentence })}\n\n`;
  const split = event.indexOf(sentence) + 4;
  held.response.write(event.slice(0, split));
  await expect(page.locator("[data-vivic-command-feedback]")).not.toHaveText(sentence);
  held.response.write(event.slice(split));
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(sentence);
  const feedbackAt = Date.now();
  await expect(display.locator("[data-vivic-thinking]")).toHaveText(sentence);
  await expect(display.locator("[data-card-id]")).toHaveCount(0);
  progress(held, "validation");
  progress(held, "planner", "另一句反馈不应覆盖第一句。");
  await page.clock.fastForward(6000);
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(sentence);
  await expect(display.locator("[data-vivic-thinking]")).toHaveText(sentence);
  const snapshot = await page.evaluate(() => window.__vivicControl!.snapshot()) as { canvases: { id: string; version: number }[] };
  expect(snapshot.canvases.find(canvas => canvas.id === canvasId)?.version).toBe(initialVersion);
  complete(held, "feedback-first-card", "已整理并保存待办。");
  await expect(display.locator('[data-card-id="feedback-first-card"]')).toBeVisible();
  const cardAt = Date.now();
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText("已整理并保存待办。");
  await expect(page.locator("[data-vivic-command-cancel]")).toHaveCount(0);
  await expect(display.locator("[data-vivic-thinking]")).toHaveCount(0);
  const timing = JSON.stringify({
    evidence: "controlled SSE; not a real model; slow timer advanced by 6000 ms using browser clock",
    requests: sse.requests.length, feedbackVisibleMs: feedbackAt - submittedAt,
    cardVisibleMs: cardAt - submittedAt, completedVisibleMs: Date.now() - submittedAt,
  }, null, 2);
  await writeFile(testInfo.outputPath("controlled-browser-timing.json"), timing);
  await testInfo.attach("controlled-browser-timing", { contentType: "application/json", path: testInfo.outputPath("controlled-browser-timing.json") });
  await display.close();
});

test("cancel and a newer request isolate late feedback and envelopes", async ({ page, sse }) => {
  await ready(page, sse);
  await sendCommand(page, "第一条需要模型的整理请求");
  await expect.poll(() => sse.requests.length).toBe(1);
  const first = sse.requests[0]!;
  progress(first, "planner", "我会先整理第一条内容。");
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText("我会先整理第一条内容。");
  await page.locator("[data-vivic-command-cancel]").focus();
  await page.locator("[data-vivic-command-cancel]").press("Enter");
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText("已取消本次请求");
  await sendCommand(page, "第二条需要模型的整理请求");
  await expect.poll(() => sse.requests.length).toBe(2);
  const second = sse.requests[1]!;
  progress(second, "planner", "我会整理第二条内容。");
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText("我会整理第二条内容。");
  progress(first, "planner", "这是不应出现的旧反馈。");
  complete(first, "stale-feedback-card", "旧请求不应完成");
  progress(second, "validation");
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText("我会整理第二条内容。");
  complete(second, "current-feedback-card", "已保存第二条内容。");
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText("已保存第二条内容。");
  const state = await page.evaluate(() => window.__vivic!.getState()) as { cards: { record: { id: string } }[]; activity: unknown };
  expect(state.cards.map(card => card.record.id)).toEqual(["current-feedback-card"]);
  expect(state.activity).toBeNull();
});

test("a model failure replaces feedback and clears transient waiting state", async ({ page, sse }) => {
  await ready(page, sse);
  await sendCommand(page, "一条需要模型的复杂请求");
  await expect.poll(() => sse.requests.length).toBe(1);
  const held = sse.requests[0]!;
  progress(held, "planner", "我会先梳理这条请求。");
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText("我会先梳理这条请求。");
  frame(held, "result", { kind: "error", message: "模型服务返回 HTTP 429" });
  held.response.end();
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText("模型服务返回 HTTP 429");
  await expect(page.locator("[data-vivic-command-cancel]")).toHaveCount(0);
  expect(await page.evaluate(() => (window.__vivic!.getState() as { activity: unknown }).activity)).toBeNull();
});
