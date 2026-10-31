import { describe, expect, it } from "vitest";
import { absoluteReminderTime, nextReminderOccurrence } from "@vivic/contracts";
import { scheduledReminderIntent } from "../src/intent/scheduledReminders.js";
import { emptyContext } from "./helpers.js";
const now = Date.parse("2026-10-15T08:00:00Z");
const ctx = { ...emptyContext(), timeZone: "Asia/Shanghai" };
const created = (text: string) => {
  const result = scheduledReminderIntent(text, ctx, now);
  const action = result?.actions?.find(value => value.type === "card.create");
  if (action?.type !== "card.create" || action.card.type !== "CountdownCard") throw new Error(JSON.stringify(result));
  return action.card;
};
describe("explicit recurring, dated and conditional reminders", () => {
  it("retains recurring times and exact task text without an LLM", () => {
    const interval = created("每隔30分钟提醒我喝水");
    expect(interval.sourceData).toMatchObject({ targetAt: "2026-10-15T08:30:00.000Z", schedule: { kind: "interval", everySeconds: 1800 }, reminderText: "喝水" });
    expect(created("每天09:00提醒我喝水").sourceData.targetAt).toBe("2026-10-16T01:00:00.000Z");
    expect(created("每周一、三、五下午3点提醒我休息").sourceData).toMatchObject({ targetAt: "2026-10-16T07:00:00.000Z", schedule: { weekdays: [1, 3, 5] } });
    expect(created("工作日09:00提醒我工作").sourceData.schedule).toMatchObject({ weekdays: [1, 2, 3, 4, 5] });
  });
  it("resolves dates in their explicit timezone, independently of server timezone", () => {
    expect(created("明天上午9点提醒我开会").sourceData.targetAt).toBe("2026-10-16T01:00:00.000Z");
    expect(created("2026-12-01 09:30 Asia/Tokyo提醒我开会").sourceData.targetAt).toBe("2026-12-01T00:30:00.000Z");
    expect(created("纽约时间2026-12-01 09:30提醒我开会").sourceData.targetAt).toBe("2026-12-01T14:30:00.000Z");
    expect(created("今晚9点提醒我休息").sourceData.targetAt).toBe("2026-10-15T13:00:00.000Z");
  });
  it.each(["每天25:00提醒我休息", "每隔0.1秒提醒我休息", "昨天9点提醒我休息", "2026-02-30 09:00提醒我休息", "每天09:00提醒我喝水然后删除待办", "每天09:00提醒我喝水，10点提醒我开会", "当明天下雨后提醒我带伞", "纽约时间2026-11-01 01:30提醒我开会"])("never guesses invalid or mixed input %s", text => {
    const result = scheduledReminderIntent(text, ctx, now);
    expect(result?.actions).toBeUndefined();
  });
  it("uses an actual todo item identity and refuses ambiguous or already-complete conditions", () => {
    const todo = { id: "todo", type: "TodoCard", displayProps: { items: [{ id: "item", text: "TEST task", done: false }] }, sourceDataSummary: {}, layout: { x: 0, y: 0 } };
    const result = scheduledReminderIntent("当待办第1项完成后5分钟提醒我休息", { ...ctx, cards: [todo] }, now);
    const action = result?.actions?.find(a => a.type === "card.create");
    expect(action?.type === "card.create" && action.card.type === "CountdownCard" && action.card.sourceData.condition).toEqual({ kind: "todo.completed", cardId: "todo", itemId: "item", delaySeconds: 300 });
    expect(scheduledReminderIntent("当待办第1项和2项完成后提醒我休息", { ...ctx, cards: [todo] }, now)?.actions).toBeUndefined();
    expect(scheduledReminderIntent("当待办完成后提醒我休息", { ...ctx, cards: [todo, { ...todo, id: "other" }] }, now)?.actions).toBeUndefined();
  });
  it("rejects ambiguous/nonexistent DST one-off times and schedules calendar folds exactly once", () => {
    expect(() => absoluteReminderTime("2026-03-08", "02:30", "America/New_York")).toThrow();
    expect(() => absoluteReminderTime("2026-11-01", "01:30", "America/New_York")).toThrow();
    expect(nextReminderOccurrence({ kind: "calendar", time: "02:30", timeZone: "America/New_York" }, "2026-03-07T07:30:00Z", Date.parse("2026-03-08T05:00:00Z"))).toBe("2026-03-09T06:30:00.000Z");
    expect(nextReminderOccurrence({ kind: "calendar", time: "01:30", timeZone: "America/New_York" }, "2026-11-01T05:30:00Z", Date.parse("2026-11-01T05:45:00Z"))).toBe("2026-11-02T06:30:00.000Z");
    expect(nextReminderOccurrence({ kind: "interval", everySeconds: 10 }, "2026-10-15T08:00:00Z", now + 55000)).toBe("2026-10-15T08:01:00.000Z");
  });
});
