import { describe, expect, it } from "vitest";
import { ROUTES, type IntentRouteId } from "@vivic/contracts";
import {
  PRESET_DELAY_MS,
  PRESET_FEEDBACK,
  PRESET_FORBIDDEN,
  PRESET_MAX_CHARS,
  PRESET_MIN_VISIBLE_MS,
  planPreset,
  presetFeedbackFor,
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

  it("never guesses a scene for unknown, extension or missing routes", () => {
    expect(presetFeedbackFor("ext.weather")).toBeNull();
    expect(presetFeedbackFor("not-a-route")).toBeNull();
    expect(presetFeedbackFor(undefined)).toBeNull();
    expect(presetFeedbackFor("")).toBeNull();
  });

  it("uses the spec's copy for the common planner routes", () => {
    expect(presetFeedbackFor("answer")).toBe("我先看一下这个问题");
    expect(presetFeedbackFor("search")).toBe("我先查一下");
    expect(presetFeedbackFor("generate")).toBe("我来整理一下");
    expect(presetFeedbackFor("focus")).toBe("我来找到那张卡");
    expect(presetFeedbackFor("edit")).toBe("我来改这张卡");
    expect(presetFeedbackFor("arrange")).toBe("我来整理布局");
    expect(presetFeedbackFor("delete")).toBe("我来处理删除");
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
