import { describe, expect, it } from "vitest";
import type { CardRecord } from "@vivic/contracts";
import { buildSceneActions } from "../src/scenes/index.js";
import { buildScenePrompt, buildSceneSlotGuide } from "../src/scenes/prompt.js";
import { emptyContext } from "./helpers.js";
import { SCENE_NOW, SCENE_ZONE } from "./sceneCases.js";

/**
 * "只给时段、没给钟点" must survive as text. The weekly_schedule contract has
 * no period field, so the period belongs in the event title; nothing may be
 * invented to fill start/end.
 */
const build = (text: string, events: Array<Record<string, unknown>>) =>
  buildSceneActions([{ scene_id: "weekly_schedule", data: { title: "本周安排", events } }],
    { text, ctx: { ...emptyContext(), timeZone: SCENE_ZONE }, now: SCENE_NOW });

const weeklyEvents = (result: ReturnType<typeof build>): Array<Record<string, unknown>> => {
  if (!result.ok) throw new Error(result.issue);
  const card: CardRecord | undefined = result.cards[0];
  expect(card?.type).toBe("WeeklyScheduleCard");
  if (card?.type !== "WeeklyScheduleCard") throw new Error("expected a WeeklyScheduleCard");
  return card.displayProps.events as Array<Record<string, unknown>>;
};

/** No fabricated clock time may appear anywhere in the built events. */
const noClock = (events: Array<Record<string, unknown>>) => {
  const text = JSON.stringify(events);
  expect(text).not.toMatch(/\d{1,2}\s*[:：]\s*\d{2}/);
  expect(text).not.toMatch(/\d{1,2}\s*点/);
};

describe("weekly_schedule periods without clock times", () => {
  it("keeps 上午/下午 in the event titles instead of inventing a clock time", () => {
    const events = weeklyEvents(build("周一上午开会，周三下午健身", [
      { day: 1, title: "上午 开会" },
      { day: 3, title: "下午 健身" },
    ]));
    expect(events.map(event => event.title)).toEqual(["上午 开会", "下午 健身"]);
    for (const event of events) {
      expect(event).not.toHaveProperty("start");
      expect(event).not.toHaveProperty("end");
    }
    noClock(events);
  });

  it("keeps each period with its own event when a payload swaps 上午/下午 (text only; no correspondence check)", () => {
    // This round deliberately adds no weekday↔period validator, so a swapped
    // payload is not rejected. The guarantee is narrower: never move or drop
    // the period text the payload attached to an event.
    const events = weeklyEvents(build("周一上午开会，周三下午健身", [
      { day: 1, title: "下午 开会" },
      { day: 3, title: "上午 健身" },
    ]));
    expect(events.map(event => event.title)).toEqual(["下午 开会", "上午 健身"]);
    noClock(events);
  });

  it("tells the retrying model to keep the period in the title, not to guess or ask", () => {
    const result = build("周一上午开会，周三下午健身", [
      { day: 1, start: "09:00", title: "开会" },
      { day: 3, title: "下午 健身" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue).toContain("把用户说的时段原样写进该事项标题，不要编造钟点、不要追问");
    expect(result.issue).not.toContain("没有时间就省略");
  });

  it("states the period rule in both planner guides", () => {
    for (const guide of [buildSceneSlotGuide(), buildScenePrompt()]) {
      expect(guide).toContain("不得填写 start/end");
      expect(guide).toContain("必须把时段词原样写进该事项的 title");
    }
  });
});
