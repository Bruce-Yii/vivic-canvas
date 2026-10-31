import { expect, test as base, type Page } from "@playwright/test";
import http, { type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { activeCanvasId, showChat, todoCardRecord } from "./helpers1";
import { PRESET_FEEDBACK } from "../../src/ai/presetFeedback";

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
  // Playwright requires the first fixture argument to be an object destructuring
  // pattern; this fixture needs no upstream fixtures.
  // oxlint-disable-next-line no-empty-pattern
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
    // Playwright's fixture `use` callback, not a React hook.
    // oxlint-disable-next-line react-hooks/rules-of-hooks
    try { await use({ requests, url: `http://127.0.0.1:${address.port}/intent` }); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  },
});

const frame = (held: HeldIntent, event: string, data: unknown) => {
  held.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};
type ProgressFields = { feedback?: string; route?: string; feedbackSource?: "model" | "preset" };
const emitProgress = (held: HeldIntent, stage: string, fields: ProgressFields = {}) => frame(held, "progress", {
  requestId: held.id, stage, status: "started", ...fields,
});
const progress = (held: HeldIntent, stage: string, feedback?: string) =>
  emitProgress(held, stage, feedback ? { feedback } : {});
const result = (held: HeldIntent, cardId: string, message: string) => frame(held, "result", {
  kind: "envelope", usedProvider: "stepfun", envelope: {
    schemaVersion: "0.6", requestId: `result-${held.id}`, canvasId: held.body.canvasContext.canvasId,
    spokenText: message, actions: [{ type: "stage.awaken" }, { type: "card.create", card: todoCardRecord(cardId, ["保留用户原文"]) }],
  },
});
const complete = (held: HeldIntent, cardId: string, message: string) => {
  result(held, cardId, message);
  held.response.end();
};

// The client copy the state machine already owns. Scene copy comes from the
// real route table; the test only controls when the route hint arrives.
const NEUTRAL_CONTROL = "正在理解你的指令…";
const SLOW_HINT = "响应较慢，仍在处理…";
const CANCELLED_TEXT = "已取消本次请求";
const FAST_DONE_MS = 250;

type FeedbackTraceEntry = {
  requestId: string;
  source: "neutral" | "slow" | "preset" | "model" | "final" | "stage";
  rank?: number;
  stage?: string;
  suppressed?: boolean;
  route?: string;
  textLength?: number;
};
/** Record the reducer's decisions (including suppressed stage frames) in page order. */
const watchFeedbackTrace = (page: Page) => page.evaluate(() => {
  const entries: unknown[] = [];
  window.addEventListener("vivic:feedback-trace", event => entries.push((event as CustomEvent).detail));
  (window as unknown as { __feedbackTrace: unknown[] }).__feedbackTrace = entries;
});
const feedbackTrace = (page: Page): Promise<FeedbackTraceEntry[]> => page.evaluate(() =>
  ((window as unknown as { __feedbackTrace?: FeedbackTraceEntry[] }).__feedbackTrace ?? []));
/** Record every text value the one visible slot actually had, without polling timing. */
const observeFeedbackLine = (page: Page) => page.evaluate(() => {
  const seen: (string | null)[] = [];
  const record = () => {
    const text = document.querySelector("[data-vivic-command-feedback]")?.textContent ?? null;
    if (seen[seen.length - 1] !== text) seen.push(text);
  };
  const observer = new MutationObserver(record);
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  (window as unknown as { __feedbackTexts: (string | null)[] }).__feedbackTexts = seen;
  record();
});
const visibleFeedbackTexts = (page: Page): Promise<(string | null)[]> => page.evaluate(() =>
  ((window as unknown as { __feedbackTexts?: (string | null)[] }).__feedbackTexts ?? []));
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

test("stage telemetry never overwrites the neutral line", async ({ page, sse }) => {
  await ready(page, sse);
  await watchFeedbackTrace(page);
  await observeFeedbackLine(page);
  await sendCommand(page, "请总结一下今天的工作");
  await expect.poll(() => sse.requests.length).toBe(1);
  const held = sse.requests[0]!;
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(NEUTRAL_CONTROL);
  const stages = ["rules", "data", "search", "decision", "planner", "validation"] as const;
  for (const stage of stages) emitProgress(held, stage,
    // A rule-direct route: recorded as telemetry, never scheduled as scene copy.
    stage === "decision" ? { route: "todo", feedbackSource: "preset" } : {});
  // Each stage emits a suppressed trace entry but writes no visible text.
  await expect.poll(async () => (await feedbackTrace(page)).length).toBe(stages.length);
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(NEUTRAL_CONTROL);
  const trace = await feedbackTrace(page);
  expect(trace.map(entry => entry.stage)).toEqual([...stages]);
  expect(trace.every(entry => entry.source === "stage" && entry.suppressed === true)).toBe(true);
  const routed = trace.filter(entry => entry.route === "todo");
  expect(routed).toHaveLength(1);
  expect(routed[0]).toMatchObject({ stage: "decision", suppressed: true });
  expect(await visibleFeedbackTexts(page)).toEqual([null, NEUTRAL_CONTROL]);
});

test("the first model sentence is not replaced by later stages or the slow timer", async ({ page, sse }) => {
  await ready(page, sse);
  await watchFeedbackTrace(page);
  await observeFeedbackLine(page);
  await page.clock.install();
  await sendCommand(page, "请把这段原文整理成待办");
  await expect.poll(() => sse.requests.length).toBe(1);
  const held = sse.requests[0]!;
  const sentence = "我先理清原文，再整理成待办。";
  emitProgress(held, "planner", { feedback: sentence, feedbackSource: "model" });
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(sentence);
  const stages = ["rules", "data", "search", "decision", "validation"] as const;
  for (const stage of stages) emitProgress(held, stage);
  await expect.poll(async () => (await feedbackTrace(page)).length).toBe(stages.length + 1);
  // The slow timer no longer has a neutral line to replace; advancing past 5s
  // must not add a second slow hint either.
  await page.clock.fastForward(6000);
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(sentence);
  const trace = await feedbackTrace(page);
  expect(trace.map(entry => entry.source)).toEqual(["model", ...stages.map(() => "stage")]);
  expect(trace.filter(entry => entry.source === "slow")).toHaveLength(0);
  expect(await visibleFeedbackTexts(page)).toEqual([null, NEUTRAL_CONTROL, sentence]);
});

test("the 5s slow hint survives later stage labels", async ({ page, sse }) => {
  await ready(page, sse);
  await watchFeedbackTrace(page);
  await observeFeedbackLine(page);
  await page.clock.install();
  await sendCommand(page, "这条请求需要多等一会儿");
  await expect.poll(() => sse.requests.length).toBe(1);
  const held = sse.requests[0]!;
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(NEUTRAL_CONTROL);
  await page.clock.fastForward(5100);
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(SLOW_HINT);
  const stages = ["rules", "data", "decision", "validation"] as const;
  for (const stage of stages) emitProgress(held, stage);
  await expect.poll(async () => (await feedbackTrace(page)).length).toBe(stages.length + 1);
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(SLOW_HINT);
  // A second 5s interval has no timer left to fire.
  await page.clock.fastForward(6000);
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(SLOW_HINT);
  const trace = await feedbackTrace(page);
  expect(trace.map(entry => entry.source)).toEqual(["slow", ...stages.map(() => "stage")]);
  expect(trace.filter(entry => entry.source === "slow")).toHaveLength(1);
  expect(await visibleFeedbackTexts(page)).toEqual([null, NEUTRAL_CONTROL, SLOW_HINT]);
});

test("a result inside the 250ms window keeps the line empty and never paints a first sentence", async ({ page, sse }) => {
  await ready(page, sse);
  await watchFeedbackTrace(page);
  await observeFeedbackLine(page);
  // Fixing Date makes the browser-side elapsedMs exactly 0 without freezing
  // timers, so the fast-result branch is deterministic and clicks still work.
  await page.clock.setFixedTime(new Date("2026-10-31T08:00:00.000Z"));
  const quietStartedAt = await page.evaluate(() => Date.now());
  await sendCommand(page, "快速保存这条待办");
  await expect.poll(() => sse.requests.length).toBe(1);
  const quiet = sse.requests[0]!;
  emitProgress(quiet, "decision", { route: "todo" });
  result(quiet, "fast-quiet-card", "已保存");
  // Frames written after the result belong to a settled request.
  emitProgress(quiet, "planner", { feedback: "迟到首句不应上屏。", feedbackSource: "model" });
  quiet.response.end();
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveCount(0);
  await expect(page.locator("[data-vivic-command-cancel]")).toHaveCount(0);
  const quietElapsed = await page.evaluate(() => Date.now()) - quietStartedAt;
  expect(quietElapsed).toBeLessThan(FAST_DONE_MS);
  const quietTexts = await visibleFeedbackTexts(page);
  // A fast result may clear neutral before or after its first paint; the
  // contract only forbids leaving a first sentence behind.
  expect(quietTexts.every(text => text === null || text === NEUTRAL_CONTROL)).toBe(true);
  expect(quietTexts[quietTexts.length - 1]).toBeNull();
  expect(quietTexts).not.toContain("迟到首句不应上屏。");

  const visibleStartedAt = await page.evaluate(() => Date.now());
  await sendCommand(page, "快速把这条放到画布");
  await expect.poll(() => sse.requests.length).toBe(2);
  const visible = sse.requests[1]!;
  emitProgress(visible, "decision", { route: "todo" });
  complete(visible, "fast-visible-card", "已放到画布");
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText("已放到画布");
  await expect(page.locator("[data-vivic-command-cancel]")).toHaveCount(0);
  const visibleElapsed = await page.evaluate(() => Date.now()) - visibleStartedAt;
  expect(visibleElapsed).toBeLessThan(FAST_DONE_MS);
  const texts = await visibleFeedbackTexts(page);
  expect(texts[texts.length - 1]).toBe("已放到画布");
  expect(texts).not.toContain("迟到首句不应上屏。");
  const trace = await feedbackTrace(page);
  expect(trace.filter(entry => entry.source === "stage")).toHaveLength(2);
  expect(trace.filter(entry => entry.source === "model" || entry.source === "preset" || entry.source === "slow")).toHaveLength(0);
});

test("cancel clears the slot and late frames from the cancelled request cannot write", async ({ page, sse }) => {
  await ready(page, sse);
  await watchFeedbackTrace(page);
  await observeFeedbackLine(page);
  await sendCommand(page, "先整理这条，随后我会取消");
  await expect.poll(() => sse.requests.length).toBe(1);
  const held = sse.requests[0]!;
  const sentence = "我会先整理这条请求。";
  emitProgress(held, "planner", { feedback: sentence });
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(sentence);
  await page.locator("[data-vivic-command-cancel]").click();
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(CANCELLED_TEXT);
  await expect(page.locator("[data-vivic-command-cancel]")).toHaveCount(0);
  emitProgress(held, "planner", { feedback: "取消之后才到的首句。" });
  emitProgress(held, "validation", { route: "answer" });
  complete(held, "cancelled-late-card", "旧请求不应完成");
  await page.waitForTimeout(300);
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(CANCELLED_TEXT);
  const state = await page.evaluate(() => window.__vivic!.getState()) as {
    cards: { record: { id: string } }[]; activity: unknown;
  };
  expect(state.cards.map(card => card.record.id)).not.toContain("cancelled-late-card");
  expect(state.activity).toBeNull();
  expect((await feedbackTrace(page)).map(entry => entry.source)).toEqual(["model"]);
  expect(await visibleFeedbackTexts(page)).toEqual([null, NEUTRAL_CONTROL, sentence, CANCELLED_TEXT]);
});

test("a decided route paints its scene copy after the quiet delay and yields to the model sentence", async ({ page, sse }) => {
  await ready(page, sse);
  await watchFeedbackTrace(page);
  await observeFeedbackLine(page);
  // The clock makes the 600ms quiet delay deterministic without a real wait.
  await page.clock.install();
  await sendCommand(page, "帮我查一下最新的资料");
  await expect.poll(() => sse.requests.length).toBe(1);
  const held = sse.requests[0]!;
  const presetSentence = PRESET_FEEDBACK.search!;
  const modelSentence = "我会先查一下最新资料。";
  // A route-only frame is new telemetry: accepted immediately, but the scene copy
  // waits out the 600ms quiet delay so a fast completion never flashes it.
  emitProgress(held, "decision", { route: "search", feedbackSource: "preset" });
  await expect.poll(async () => (await feedbackTrace(page)).length).toBe(1);
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(NEUTRAL_CONTROL);
  await page.clock.fastForward(600);
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(presetSentence);
  await expect.poll(async () => (await feedbackTrace(page)).length).toBe(2);
  // A model sentence replaces the scene copy without waiting for a minimum display.
  progress(held, "planner", modelSentence);
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(modelSentence);
  await expect.poll(async () => (await feedbackTrace(page)).length).toBe(3);
  // A legacy stage-only frame is still parsed and still cannot write text.
  progress(held, "validation");
  await expect.poll(async () => (await feedbackTrace(page)).length).toBe(4);
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(modelSentence);
  const trace = await feedbackTrace(page);
  expect(trace.map(entry => entry.source)).toEqual(["stage", "preset", "model", "stage"]);
  expect(trace[0]).toMatchObject({ stage: "decision", route: "search", suppressed: true });
  expect(trace[1]).toMatchObject({ source: "preset", rank: 30, route: "search" });
  expect(trace[2]).toMatchObject({ source: "model", route: "search" });
  expect(trace[3]).toMatchObject({ source: "stage", suppressed: true });
  expect(await visibleFeedbackTexts(page)).toEqual([null, NEUTRAL_CONTROL, presetSentence, modelSentence]);
});

test("an explicit preset feedback frame still paints arbitrary fallback copy", async ({ page, sse }) => {
  await ready(page, sse);
  await watchFeedbackTrace(page);
  await sendCommand(page, "帮我整理一下这页的内容");
  await expect.poll(() => sse.requests.length).toBe(1);
  const held = sse.requests[0]!;
  const fallback = "这是测试注入的预设兜底句。";
  // Older/raw preset frames carry their own text; the route table is not required.
  emitProgress(held, "decision", { feedback: fallback, feedbackSource: "preset", route: "generate" });
  await expect(page.locator("[data-vivic-command-feedback]")).toHaveText(fallback);
  await expect.poll(async () => (await feedbackTrace(page)).length).toBe(1);
  const trace = await feedbackTrace(page);
  expect(trace[0]).toMatchObject({ source: "preset", rank: 30, route: "generate" });
});
