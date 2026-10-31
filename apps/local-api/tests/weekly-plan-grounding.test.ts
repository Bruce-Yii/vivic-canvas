import { describe, expect, it } from "vitest";
import type { CanvasContext } from "../src/schemas.js";
import { buildSceneActions } from "../src/scenes/index.js";
import { planDeterministic } from "../src/intent/plans.js";
import { emptyContext } from "./helpers.js";
import { SCENE_NOW, SCENE_ZONE } from "./sceneCases.js";

/**
 * The acceptance canvas (accept60) carries a note whose body mentions 周三.
 * A "下周的健身计划" request names no weekday, so the plan's own days are
 * content, not user facts — and a canvas card is not the user's words. Before
 * this fix the canvas weekday made the plan look "grounded" and every proposed
 * day was rejected, so sc-16 fell through to the planner and clarified.
 */
const canvasWithWeekdayNote = (): CanvasContext => ({ ...emptyContext(), timeZone: SCENE_ZONE,
  focusHistory: ["note_meeting"], cards: [
    { id: "note_meeting", type: "NoteCard", aliases: ["会议记录"],
      displayProps: { title: "会议记录", text: "周三和设计讨论首页改版" },
      sourceDataSummary: {}, layout: { x: 300, y: 0, width: 360, height: 240, pinned: false } },
  ] } as CanvasContext);

const weeklyPlan = (text: string, ctx: CanvasContext, events = [
  { day: 1, title: "力量训练" }, { day: 3, title: "有氧运动" }, { day: 5, title: "拉伸放松" },
]) => buildSceneActions([{ scene_id: "weekly_schedule", data: { title: "下周健身计划", events } }],
  { text, ctx, now: SCENE_NOW });

describe("a requested weekly plan is grounded in the user's own words", () => {
  it("builds proposed days even when a canvas card mentions a weekday", () => {
    const built = weeklyPlan("帮我做一个下周的健身计划", canvasWithWeekdayNote());
    expect(built.ok, built.ok ? "" : built.issue).toBe(true);
    if (!built.ok) return;
    expect(built.cards[0]?.type).toBe("WeeklyScheduleCard");
  });

  it("still binds days the user actually named in the same turn", () => {
    // The user named 周二, so day 2 is allowed; the unsaid days 1/3/5 are not.
    const built = weeklyPlan("下周二练力量，帮我排个计划", canvasWithWeekdayNote());
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.issue).toContain("weekly_schedule.events.day");
  });

  it("keeps the page/canvas evidence for the rest of the payload", () => {
    // Grounding of numbers is unchanged: an invented point still fails.
    const built = buildSceneActions([{ scene_id: "goal_progress", data: { title: "项目进度", current: 42, target: 100 } }],
      { text: "帮我做一个项目进度卡", ctx: canvasWithWeekdayNote(), now: SCENE_NOW });
    expect(built.ok).toBe(false);
  });

  it("lets the rule planner build sc-16 for the acceptance canvas", async () => {
    const plan = await planDeterministic("帮我做一个下周的健身计划", canvasWithWeekdayNote(), SCENE_NOW);
    expect(plan, "planDeterministic must own this sentence").not.toBeNull();
    expect(plan?.groups[0]?.cards).toEqual(["WeeklyScheduleCard"]);
  });
});
