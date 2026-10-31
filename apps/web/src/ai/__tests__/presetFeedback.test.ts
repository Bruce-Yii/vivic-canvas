import { describe, expect, it } from "vitest";
import { ROUTES, isSafeFeedbackText, type IntentRouteId } from "@vivic/contracts";
import {
  EXT_FEEDBACK,
  PRESET_DELAY_MS,
  PRESET_FEEDBACK,
  PRESET_FORBIDDEN,
  PRESET_MAX_CHARS,
  PRESET_MIN_VISIBLE_MS,
  SCENE_FEEDBACK,
  TARGET_ACTION_FEEDBACK,
  planPreset,
  presetFeedbackFor,
  safeFeedbackSentence,
} from "../presetFeedback";
import {
  FAST_DONE_MS,
  FEEDBACK_RANK,
  newFeedbackSlot,
  reduceFeedback,
  type FeedbackEvent,
  type FeedbackSlot,
} from "../intentStream";

const RULE_DIRECT_ROUTES = ["countdown", "todo", "note", "overview", "restore"] as const;
const neutral = (): FeedbackSlot => newFeedbackSlot("r1", "让我想想…");
const preset = (route: IntentRouteId, at = Date.now()): FeedbackEvent =>
  ({ type: "preset", text: presetFeedbackFor(route)!, route, at, requestId: "r1" });
const model = (feedback: string): FeedbackEvent =>
  ({ type: "progress", stage: "planner", feedback, feedbackSource: "model", requestId: "r1" });

describe("route scene copy", () => {
  it("covers every shared route and keeps every sentence short and clean", () => {
    const routes = Object.keys(ROUTES) as IntentRouteId[];
    expect(routes).toHaveLength(16);
    // The table must stay exhaustive: a new route is a deliberate copy decision.
    expect(Object.keys(PRESET_FEEDBACK).sort()).toEqual([...routes].sort());
    const copy = routes.flatMap(route => {
      const text = PRESET_FEEDBACK[route];
      return text === null ? [] : [text];
    });
    expect(copy).toHaveLength(11);
    for (const text of copy) {
      expect([...text].length).toBeLessThanOrEqual(PRESET_MAX_CHARS);
      expect(text).not.toMatch(PRESET_FORBIDDEN);
      // Never claim anything finished; the sentence only describes ongoing work.
      expect(text).not.toMatch(/已|完成|成功|好了|马上|稍等/);
      expect(text).not.toMatch(/[?？]/);
      expect(text).not.toMatch(/[\r\n]/);
      expect(text).not.toMatch(/[\p{Extended_Pictographic}]/u);
      expect(text.trim()).toBe(text);
    }
  });

  it("gives no preset to routes that execute directly from parsed slots", () => {
    for (const route of RULE_DIRECT_ROUTES) expect(presetFeedbackFor(route)).toBeNull();
    // Every remaining route is a planner/wait route and must have copy.
    for (const route of Object.keys(ROUTES) as IntentRouteId[]) {
      if ((RULE_DIRECT_ROUTES as readonly string[]).includes(route)) continue;
      expect(presetFeedbackFor(route)).toBeTruthy();
    }
  });

  it("covers extension and unknown routes with the safe fallback, but never a missing route", () => {
    expect(presetFeedbackFor("ext.weather")).toBe(EXT_FEEDBACK);
    expect(presetFeedbackFor("ext.travel.offers")).toBe(EXT_FEEDBACK);
    expect(presetFeedbackFor("not-a-route")).toBe(EXT_FEEDBACK);
    expect(presetFeedbackFor(undefined)).toBeNull();
    expect(presetFeedbackFor("")).toBeNull();
  });

  it("covers multi-clause, attachment, continuation and task paths with a neutral scene", () => {
    for (const [scene, text] of Object.entries(SCENE_FEEDBACK)) {
      expect(presetFeedbackFor(undefined, scene as keyof typeof SCENE_FEEDBACK)).toBe(text);
      expect(text).not.toMatch(PRESET_FORBIDDEN);
      expect([...text].length).toBeLessThanOrEqual(PRESET_MAX_CHARS);
    }
    expect(SCENE_FEEDBACK.multi).toBe("我在分开处理这几件事");
    expect(SCENE_FEEDBACK.attachment).toBe("我先看看你发的内容");
  });

  it("uses confirmation copy for target-sensitive routes instead of naming a target", () => {
    expect(presetFeedbackFor("focus")).toBe("我先找一下相关卡片");
    expect(presetFeedbackFor("edit")).toBe("我先确认要改哪张");
    expect(presetFeedbackFor("delete")).toBe("我先确认要删哪张");
    for (const text of ["我先找一下相关卡片", "我先确认要改哪张", "我先确认要删哪张"]) {
      expect(text).not.toMatch(/找到|这张卡|处理删除/);
    }
  });

  it("only speaks an action after a unique target resolved, and never for delete", () => {
    expect(TARGET_ACTION_FEEDBACK.focus).toBe("我来打开这张卡");
    expect(presetFeedbackFor("focus", undefined, "resolved")).toBe("我来打开这张卡");
    expect(presetFeedbackFor("edit", undefined, "resolved")).toBe("我来修改这张卡");
    expect(presetFeedbackFor("highlight", undefined, "resolved")).toBe("我来标出这张卡");
    // Unresolved/ambiguous/missing targets stay on the confirmation sentence.
    for (const state of ["unresolved", "ambiguous", "missing"] as const) {
      expect(presetFeedbackFor("focus", undefined, state)).toBe("我先找一下相关卡片");
      expect(presetFeedbackFor("edit", undefined, state)).toBe("我先确认要改哪张");
    }
    // Delete is destructive: even a known target keeps the confirmation copy.
    expect(TARGET_ACTION_FEEDBACK.delete).toBeUndefined();
    expect(presetFeedbackFor("delete", undefined, "resolved")).toBe("我先确认要删哪张");
    for (const text of Object.values(TARGET_ACTION_FEEDBACK)) {
      expect(text).toBeTruthy();
      if (!text) continue;
      expect(text).not.toMatch(PRESET_FORBIDDEN);
      expect(Array.from(text).length).toBeLessThanOrEqual(PRESET_MAX_CHARS);
    }
  });

  it("rejects fake completion sentences and keeps normal in-progress copy", () => {
    for (const fake of ["已为你创建卡片。", "已帮你生成内容。", "我帮你弄好了。", "做好了。",
      "搞定了。", "卡片弄好了，请查看。", "我创建了卡片。", "已删除卡片。", "已设置提醒。"]) {
      expect(isSafeFeedbackText(fake)).toBe(false);
      // The ControlApp gate uses this helper, so a stale server cannot paint it.
      expect(safeFeedbackSentence(fake)).toBeUndefined();
    }
    for (const normal of ["正在创建卡片。", "正在为你创建卡片。", "正在整理这张卡。",
      "我会帮你创建。", "我先看看。", "我来整理一下。"]) {
      expect(isSafeFeedbackText(normal)).toBe(true);
      expect(safeFeedbackSentence(normal)).toBe(normal);
    }
    expect(safeFeedbackSentence(undefined)).toBeUndefined();
  });

  it("uses the spec's copy for the common planner routes", () => {
    expect(presetFeedbackFor("answer")).toBe("我先看一下这个问题");
    expect(presetFeedbackFor("search")).toBe("我先查一下");
    expect(presetFeedbackFor("generate")).toBe("我来整理一下");
    expect(presetFeedbackFor("focus")).toBe("我先找一下相关卡片");
    expect(presetFeedbackFor("edit")).toBe("我先确认要改哪张");
    expect(presetFeedbackFor("arrange")).toBe("我来整理布局");
    expect(presetFeedbackFor("delete")).toBe("我先确认要删哪张");
    expect(presetFeedbackFor("undo")).toBe("我来撤销");
    expect(presetFeedbackFor("highlight")).toBe("我来标出来");
    expect(presetFeedbackFor("chat")).toBe("我先回你");
    expect(presetFeedbackFor("unsupported")).toBe("我先看看能不能做");
  });
});

describe("preset timing", () => {
  it("delays a known route's copy by 600ms, already past the fast-completion window", () => {
    expect(PRESET_DELAY_MS).toBe(600);
    expect(PRESET_DELAY_MS).toBeGreaterThanOrEqual(FAST_DONE_MS);
    expect(PRESET_MIN_VISIBLE_MS).toBe(600);
    expect(planPreset("search", { now: 75, tier: "neutral", settled: false })).toEqual({
      route: "search", text: "我先查一下", delayMs: PRESET_DELAY_MS, showAt: 75 + PRESET_DELAY_MS,
    });
  });

  it("refuses to schedule when the line already moved on or the request settled", () => {
    const now = 1000;
    expect(planPreset("answer", { now, tier: "neutral", settled: true })).toBeNull();
    expect(planPreset("answer", { now, tier: "slow", settled: false })).toBeNull();
    expect(planPreset("answer", { now, tier: "model", settled: false })).toBeNull();
    expect(planPreset("answer", { now, tier: "preset", settled: false })).toBeNull();
    expect(planPreset("answer", { now, tier: "final", settled: false })).toBeNull();
    expect(planPreset("answer", { now, tier: "neutral", settled: false, scheduled: true })).toBeNull();
  });

  it("never schedules for rule-direct routes even while neutral", () => {
    for (const route of RULE_DIRECT_ROUTES) {
      expect(planPreset(route, { now: 75, tier: "neutral", settled: false })).toBeNull();
    }
  });

  it("schedules extension and scene fallbacks instead of leaving the line neutral", () => {
    expect(planPreset("ext.weather", { now: 75, tier: "neutral", settled: false })).toMatchObject({
      route: "ext.weather", text: EXT_FEEDBACK, delayMs: PRESET_DELAY_MS,
    });
    expect(planPreset(undefined, { now: 75, tier: "neutral", settled: false, scene: "multi" })).toMatchObject({
      scene: "multi", text: SCENE_FEEDBACK.multi, delayMs: PRESET_DELAY_MS,
    });
    expect(planPreset(undefined, { now: 75, tier: "neutral", settled: false })).toBeNull();
  });

  it("reschedules the target-sensitive copy when a unique target arrives", () => {
    expect(planPreset("focus", { now: 75, tier: "neutral", settled: false, targetState: "resolved" })).toMatchObject({
      route: "focus", text: "我来打开这张卡",
    });
    expect(planPreset("focus", { now: 75, tier: "neutral", settled: false, targetState: "ambiguous" })).toMatchObject({
      route: "focus", text: "我先找一下相关卡片",
    });
  });
});

describe("preset slot transitions", () => {
  it("paints a preset on a neutral slot and lets the model sentence replace it immediately", () => {
    expect(FEEDBACK_RANK.preset).toBe(30);
    const shown = reduceFeedback(neutral(), preset("answer", 700));
    expect(shown).toMatchObject({ tier: "preset", text: "我先看一下这个问题", route: "answer" });
    const replaced = reduceFeedback(shown, model("我先看看这页的内容。"));
    expect(replaced).toMatchObject({ tier: "model", text: "我先看看这页的内容。" });
    // A late route/preset cannot downgrade the model sentence.
    expect(reduceFeedback(replaced, preset("search", 800))).toBe(replaced);
  });

  it("never covers the slow hint, a model sentence or an earlier preset", () => {
    const slow = reduceFeedback(neutral(), { type: "slow", text: "响应较慢，仍在处理…", requestId: "r1" });
    expect(reduceFeedback(slow, preset("answer"))).toBe(slow);

    const sentence = reduceFeedback(neutral(), model("我在整理这张卡。"));
    expect(reduceFeedback(sentence, preset("edit"))).toBe(sentence);

    const shown = reduceFeedback(neutral(), preset("answer", 700));
    // Same tier cannot replace itself, so a visible preset keeps its window.
    expect(reduceFeedback(shown, preset("edit", 900))).toBe(shown);
  });

  it("paints extension and scene copy from the same single slot", () => {
    const extension = reduceFeedback(neutral(), { type: "preset", text: EXT_FEEDBACK, route: "ext.weather", requestId: "r1" });
    expect(extension).toMatchObject({ tier: "preset", text: EXT_FEEDBACK, route: "ext.weather" });
    const scene = reduceFeedback(neutral(), { type: "preset", text: SCENE_FEEDBACK.multi, scene: "multi", requestId: "r1" });
    expect(scene).toMatchObject({ tier: "preset", text: SCENE_FEEDBACK.multi, scene: "multi" });
    // A later route frame records telemetry but cannot replace the visible text.
    const routed = reduceFeedback(scene, { type: "progress", stage: "decision", route: "note", requestId: "r1" });
    expect(routed).toMatchObject({ tier: "preset", text: SCENE_FEEDBACK.multi, route: "note", scene: "multi" });
  });

  it("drops a preset after a fast quiet result or a cancelled request", () => {
    const quiet = reduceFeedback(neutral(), { type: "settle", text: "已保存", elapsedMs: FAST_DONE_MS - 100, quiet: true, requestId: "r1" });
    expect(quiet).toMatchObject({ tier: "final", text: null, settled: true });
    expect(reduceFeedback(quiet, preset("answer"))).toBe(quiet);

    const cancelled = reduceFeedback(neutral(), { type: "settle", text: "已取消本次请求", elapsedMs: 4000, requestId: "r1" });
    expect(reduceFeedback(cancelled, preset("answer", 4100))).toBe(cancelled);
  });

  it("ignores presets from a superseded request", () => {
    const current = neutral();
    expect(reduceFeedback(current, { type: "preset", text: "我先查一下", route: "search", requestId: "r0" })).toBe(current);
  });
});
