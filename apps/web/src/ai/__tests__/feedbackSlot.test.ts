import { describe, expect, it, vi } from "vitest";
import {
  FAST_DONE_MS,
  FEEDBACK_RANK,
  IntentProgressSchema,
  newFeedbackSlot,
  readIntentStream,
  reduceFeedback,
  type FeedbackEvent,
  type FeedbackSlot,
} from "../intentStream";

const neutral = (text = "让我想想…"): FeedbackSlot => newFeedbackSlot("r1", text);
const stage = (name: "rules" | "data" | "search" | "decision" | "planner" | "validation" | "travel" | "total",
  extra: { route?: string } = {}): FeedbackEvent => ({ type: "progress", stage: name, requestId: "r1", ...extra });
const model = (feedback: string): FeedbackEvent => ({ type: "progress", stage: "planner", feedback, requestId: "r1" });
const preset = (feedback: string): FeedbackEvent =>
  ({ type: "progress", stage: "decision", feedback, feedbackSource: "preset", requestId: "r1" });

const STAGES = ["rules", "data", "search", "decision", "planner", "validation", "travel", "total"] as const;

describe("single-slot feedback priority", () => {
  it("keeps the neutral line and the model first sentence against every stage label", () => {
    const start = neutral();
    for (const name of STAGES) expect(reduceFeedback(start, stage(name))).toBe(start);
    expect(reduceFeedback(start, model("我会先理一理这个问题。"))).toMatchObject({ tier: "model", text: "我会先理一理这个问题。" });
    const sentence = reduceFeedback(start, model("我会先理一理这个问题。"));
    for (const name of STAGES) expect(reduceFeedback(sentence, stage(name))).toBe(sentence);
    // Only the first model sentence of a request is painted.
    expect(reduceFeedback(sentence, model("第二句模型反馈。"))).toBe(sentence);
  });

  it("orders final > model > preset > neutral > stage and never downgrades", () => {
    expect(FEEDBACK_RANK.final).toBeGreaterThan(FEEDBACK_RANK.model);
    expect(FEEDBACK_RANK.model).toBeGreaterThan(FEEDBACK_RANK.preset);
    expect(FEEDBACK_RANK.preset).toBeGreaterThan(FEEDBACK_RANK.neutral);
    expect(FEEDBACK_RANK.neutral).toBeGreaterThan(FEEDBACK_RANK.stage);

    const withPreset = reduceFeedback(neutral(), preset("我先理一理这个问题"));
    expect(withPreset).toMatchObject({ tier: "preset", text: "我先理一理这个问题" });
    const withModel = reduceFeedback(withPreset, model("我在整理成待办。"));
    expect(withModel).toMatchObject({ tier: "model", text: "我在整理成待办。" });
    // A preset frame cannot downgrade a model sentence, and neutral cannot beat either.
    expect(reduceFeedback(withModel, preset("我再猜一个场景"))).toBe(withModel);
    expect(reduceFeedback(withModel, { type: "neutral", text: "正在理解你的指令…", requestId: "r1" })).toBe(withModel);
  });

  it("enters the slow hint only from neutral and keeps later stages from overwriting it", () => {
    const slow = reduceFeedback(neutral(), { type: "slow", text: "响应较慢，仍在处理…", requestId: "r1" });
    expect(slow).toMatchObject({ tier: "slow", text: "响应较慢，仍在处理…" });
    for (const name of STAGES) expect(reduceFeedback(slow, stage(name))).toBe(slow);
    expect(reduceFeedback(slow, { type: "slow", text: "响应较慢，仍在处理…", requestId: "r1" })).toBe(slow);
    // A model sentence may still replace the slow hint.
    expect(reduceFeedback(slow, model("我在整理卡片内容。"))).toMatchObject({ tier: "model" });
    // Existing model/preset copy is never replaced by the slow hint.
    const sentence = reduceFeedback(neutral(), model("我会先看看你的画布。"));
    expect(reduceFeedback(sentence, { type: "slow", text: "响应较慢，仍在处理…", requestId: "r1" })).toBe(sentence);
    const presetSentence = reduceFeedback(neutral(), preset("我先理一理这个问题"));
    expect(reduceFeedback(presetSentence, { type: "slow", text: "响应较慢，仍在处理…", requestId: "r1" })).toBe(presetSentence);
  });

  it("settles on cancel/error and discards late or superseded feedback", () => {
    const sentence = reduceFeedback(neutral(), model("我会先整理第一条内容。"));
    const cancelled = reduceFeedback(sentence, { type: "settle", text: "已取消本次请求", elapsedMs: 4200, requestId: "r1" });
    expect(cancelled).toMatchObject({ tier: "final", text: "已取消本次请求", settled: true });
    expect(reduceFeedback(cancelled, model("迟到的模型首句。"))).toBe(cancelled);
    expect(reduceFeedback(cancelled, { type: "slow", text: "响应较慢，仍在处理…", requestId: "r1" })).toBe(cancelled);
    expect(reduceFeedback(cancelled, { type: "settle", text: "迟到的结果", elapsedMs: 9000, requestId: "r1" })).toBe(cancelled);

    const failed = reduceFeedback(sentence, { type: "settle", text: "模型服务返回 HTTP 429", elapsedMs: 6100, requestId: "r1" });
    expect(failed).toMatchObject({ tier: "final", text: "模型服务返回 HTTP 429", settled: true });
    expect(reduceFeedback(failed, model("失败之后才到的首句。"))).toBe(failed);

    // A still-running slot ignores frames that belong to a superseded request.
    expect(reduceFeedback(sentence, { type: "progress", stage: "planner", feedback: "旧请求反馈", requestId: "r0" })).toBe(sentence);
    expect(reduceFeedback(sentence, { type: "slow", text: "响应较慢，仍在处理…", requestId: "r0" })).toBe(sentence);
  });

  it("does not paint a preset/model sentence for a fast completion", () => {
    const quiet = reduceFeedback(neutral(), { type: "settle", text: "已保存", elapsedMs: FAST_DONE_MS - 150, quiet: true, requestId: "r1" });
    expect(quiet).toMatchObject({ tier: "final", text: null, settled: true });
    // A first sentence arriving after the fast result cannot repaint the slot.
    expect(reduceFeedback(quiet, model("我会整理成待办。"))).toBe(quiet);
    // Fast but visible results still paint only their own final line.
    const visible = reduceFeedback(neutral(), { type: "settle", text: "已放到画布", elapsedMs: 120, requestId: "r1" });
    expect(visible).toMatchObject({ tier: "final", text: "已放到画布" });
    // A quiet success outside the fast window keeps its (already hidden) text.
    const late = reduceFeedback(neutral(), { type: "settle", text: "已保存", elapsedMs: FAST_DONE_MS + 1000, quiet: true, requestId: "r1" });
    expect(late.text).toBe("已保存");
  });

  it("records the advisory route or scene without touching the visible line", () => {
    const routed = reduceFeedback(neutral(), stage("decision", { route: "answer" }));
    expect(routed).toMatchObject({ tier: "neutral", text: "让我想想…", route: "answer" });
    const scene = reduceFeedback(routed, { type: "progress", stage: "decision", scene: "multi", requestId: "r1" });
    expect(scene).toMatchObject({ tier: "neutral", text: "让我想想…", route: "answer", scene: "multi" });
    const targeted = reduceFeedback(scene, { type: "progress", stage: "decision", route: "focus", targetState: "resolved", requestId: "r1" });
    expect(targeted).toMatchObject({ tier: "neutral", text: "让我想想…", route: "focus", targetState: "resolved" });
    const sentence = reduceFeedback(targeted, model("我先查一下资料。"));
    expect(reduceFeedback(sentence, stage("validation", { route: "search" }))).toMatchObject({
      tier: "model", text: "我先查一下资料。", route: "search", scene: "multi", targetState: "resolved",
    });
  });
});

const response = (chunks: string[]) => new Response(new ReadableStream({ start(controller) {
  chunks.forEach(chunk => controller.enqueue(new TextEncoder().encode(chunk))); controller.close();
} }), { headers: { "content-type": "text/event-stream" } });
const accepted = 'event: accepted\ndata: {"requestId":"r1"}\n\n';
const result = 'event: result\ndata: {"kind":"clarify","message":"需要日期"}\n\n';

describe("optional progress fields stay backward compatible", () => {
  it("parses legacy frames unchanged and accepts the new optional fields", () => {
    expect(IntentProgressSchema.parse({ requestId: "r1", stage: "validation", status: "started" }))
      .toEqual({ requestId: "r1", stage: "validation", status: "started" });
    expect(IntentProgressSchema.parse({ requestId: "r1", stage: "decision", status: "started",
      route: "answer", feedbackSource: "preset" })).toMatchObject({ route: "answer", feedbackSource: "preset" });
    expect(IntentProgressSchema.parse({ requestId: "r1", stage: "planner", status: "started",
      feedback: "我会整理成待办。", feedbackSource: "model" })).toMatchObject({ feedbackSource: "model" });
    // Scene fallbacks are a closed set; unknown values are dropped at the wire.
    expect(IntentProgressSchema.parse({ requestId: "r1", stage: "decision", status: "started", scene: "multi" }))
      .toMatchObject({ scene: "multi" });
    expect(IntentProgressSchema.safeParse({ requestId: "r1", stage: "decision", status: "started", scene: "ext.weather" }).success).toBe(false);
    expect(IntentProgressSchema.parse({ requestId: "r1", stage: "decision", status: "started", route: "focus", targetState: "resolved" }))
      .toMatchObject({ targetState: "resolved" });
    expect(IntentProgressSchema.safeParse({ requestId: "r1", stage: "decision", status: "started", targetState: "unique" }).success).toBe(false);
    // Bounded route ids and a closed source enum.
    expect(IntentProgressSchema.safeParse({ requestId: "r1", stage: "decision", status: "started", route: "x".repeat(91) }).success).toBe(false);
    expect(IntentProgressSchema.safeParse({ requestId: "r1", stage: "decision", status: "started", feedbackSource: "other" }).success).toBe(false);
  });

  it("delivers the route hint through the existing progress channel and drops invalid ones", async () => {
    const onProgress = vi.fn();
    const routeFrame = 'event: progress\ndata: {"requestId":"r1","stage":"decision","status":"started","route":"answer","feedbackSource":"preset"}\n\n';
    const sceneFrame = 'event: progress\ndata: {"requestId":"r1","stage":"decision","status":"started","scene":"multi"}\n\n';
    const modelFrame = 'event: progress\ndata: {"requestId":"r1","stage":"planner","status":"started","feedback":"我先理一理这个问题。","feedbackSource":"model"}\n\n';
    const invalid = `event: progress\ndata: ${JSON.stringify({ requestId: "r1", stage: "decision", status: "started", route: "x".repeat(91) })}\n\n`;
    expect(await readIntentStream(response([accepted, routeFrame, sceneFrame, modelFrame, invalid, result]), onProgress))
      .toEqual({ kind: "clarify", message: "需要日期" });
    expect(onProgress.mock.calls.map(([event]) => event)).toEqual([
      { requestId: "r1", stage: "decision", status: "started", route: "answer", feedbackSource: "preset" },
      { requestId: "r1", stage: "decision", status: "started", scene: "multi" },
      { requestId: "r1", stage: "planner", status: "started", feedback: "我先理一理这个问题。", feedbackSource: "model" },
    ]);
  });
});
