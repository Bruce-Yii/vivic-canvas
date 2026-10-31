import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

export const TimeZoneSchema = z.string().min(1).max(80).refine(zone => {
  try { new Intl.DateTimeFormat("en", { timeZone: zone }); return !/^[+-]/.test(zone); } catch { return false; }
}, "请使用有效的 IANA 时区，例如 Asia/Shanghai。");
export const ReminderScheduleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("interval"), everySeconds: z.number().int().min(5).max(31536000) }),
  z.strictObject({ kind: z.literal("calendar"), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), timeZone: TimeZoneSchema,
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(days => new Set(days).size === days.length).optional() }),
]);
export const ReminderConditionSchema = z.strictObject({
  kind: z.enum(["todo.completed", "countdown.completed"]), cardId: z.string().min(1).max(128),
  itemId: z.string().min(1).max(128).optional(), delaySeconds: z.number().int().min(0).max(86400),
}).refine(value => value.kind === "todo.completed" || value.itemId === undefined);
export type ReminderSchedule = z.infer<typeof ReminderScheduleSchema>;
export type ReminderCondition = z.infer<typeof ReminderConditionSchema>;

/** Recurrences skip missed occurrences, never burst after sleep. Calendar gaps
 * skip that date; a repeated DST wall time fires only at its earlier instant. */
export function nextReminderOccurrence(schedule: ReminderSchedule, previousAt: string, now: number): string {
  if (schedule.kind === "interval") {
    const previous = Date.parse(previousAt), step = schedule.everySeconds * 1000;
    return new Date(previous + Math.max(1, Math.floor((now - previous) / step) + 1) * step).toISOString();
  }
  const instant = Temporal.Instant.fromEpochMilliseconds(Math.floor(now));
  const date = instant.toZonedDateTimeISO(schedule.timeZone).toPlainDate();
  const time = Temporal.PlainTime.from(schedule.time);
  for (let i = 0; i < 370; i++) {
    const candidateDate = date.add({ days: i });
    if (schedule.weekdays && !schedule.weekdays.includes(candidateDate.dayOfWeek)) continue;
    const local = candidateDate.toPlainDateTime(time);
    const candidate = local.toZonedDateTime(schedule.timeZone, { disambiguation: "earlier" });
    if (!candidate.toPlainDateTime().equals(local) || candidate.epochMilliseconds <= now) continue;
    return new Date(candidate.epochMilliseconds).toISOString();
  }
  throw new Error("找不到下次提醒时间");
}

/** Ambiguous or nonexistent one-off local times require clarification. */
export function absoluteReminderTime(date: string, time: string, timeZone: string): string {
  const local = Temporal.PlainDate.from(date).toPlainDateTime(Temporal.PlainTime.from(time));
  const result = local.toZonedDateTime(TimeZoneSchema.parse(timeZone), { disambiguation: "reject" });
  return new Date(result.epochMilliseconds).toISOString();
}

export function relativeReminderDate(dayOffset: number, now: number, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(Math.floor(now)).toZonedDateTimeISO(timeZone).toPlainDate().add({ days: dayOffset }).toString();
}
