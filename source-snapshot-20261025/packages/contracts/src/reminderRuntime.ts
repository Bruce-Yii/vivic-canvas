import { z } from "zod";
import type { CountdownCard, CardRecord } from "./cardRecord";
import { nextReminderOccurrence } from "./reminderSchedule";

export const ReminderNoticeSchema = z.strictObject({
  id: z.string().min(1).max(128),
  canvasId: z.string().min(1).max(128),
  canvasTitle: z.string().min(1).max(120),
  cardId: z.string().min(1).max(128),
  text: z.string().min(1).max(160),
  targetAt: z.iso.datetime(),
  firedAt: z.iso.datetime(),
});
export const ReminderInboxSchema = z.array(ReminderNoticeSchema).max(50);
export type ReminderNotice = z.infer<typeof ReminderNoticeSchema>;

export interface ReminderSummary {
  canvasId: string;
  canvasTitle: string;
  card: CountdownCard;
}

/** Absolute wall-clock deadlines survive sleep and reload; intervals only poll. */
export const isDue = (card: CountdownCard, now: number): boolean =>
  !card.sourceData.pausedAt && !card.sourceData.notifiedAt &&
  (!card.sourceData.condition || Boolean(card.sourceData.conditionMetAt)) &&
  Date.parse(card.sourceData.targetAt) <= now;

export const remainingSeconds = (card: CountdownCard, now: number): number =>
  Math.max(0, Math.ceil((Date.parse(card.sourceData.targetAt) -
    (card.sourceData.pausedAt ? Date.parse(card.sourceData.pausedAt) : now)) / 1000));

export const reminderText = (card: CountdownCard): string =>
  card.sourceData.reminderText ?? "倒计时已结束";

export const sameDelivery = (notice: ReminderNotice, item: ReminderSummary): boolean =>
  notice.canvasId === item.canvasId && notice.cardId === item.card.id &&
  notice.targetAt === item.card.sourceData.targetAt;

export const deliveredNoticeCurrent = (notice: ReminderNotice, card: CountdownCard): boolean =>
  !card.sourceData.pausedAt && (Boolean(card.sourceData.notifiedAt) && notice.targetAt === card.sourceData.targetAt
    || Boolean(card.sourceData.lastFiredAt) && notice.targetAt === card.sourceData.lastDeliveredTargetAt);

export function conditionSatisfied(card: CountdownCard, cards: CardRecord[]): boolean {
  const rule = card.sourceData.condition;
  if (!rule || card.sourceData.conditionMetAt || card.sourceData.pausedAt) return false;
  const target = cards.find(value => value.id === rule.cardId);
  if (rule.kind === "todo.completed" && target?.type === "TodoCard") {
    return rule.itemId ? target.displayProps.items.some(item => item.id === rule.itemId && item.done)
      : target.displayProps.items.every(item => item.done);
  }
  if (rule.kind === "countdown.completed" && target?.type === "CountdownCard") {
    const fired = target.sourceData.lastFiredAt ?? target.sourceData.notifiedAt;
    return Boolean(fired && Date.parse(fired) >= Date.parse(card.metadata.createdAt));
  }
  return false;
}

export function resumeReminderSource(card: CountdownCard, now: number) {
  const source = card.sourceData;
  const targetAt = source.schedule?.kind === "calendar"
    ? nextReminderOccurrence(source.schedule, source.targetAt, now)
    : new Date(now + remainingSeconds(card, now) * 1000).toISOString();
  return { pausedAt: null, notifiedAt: null, targetAt, lastDeliveredTargetAt: null, lastFiredAt: null };
}

export function scheduleLabel(card: CountdownCard): string | null {
  const source = card.sourceData, schedule = source.schedule;
  if (source.condition && !source.conditionMetAt) return "等待画布内完成条件";
  if (!schedule) return source.timeZone ? `${new Date(source.targetAt).toLocaleString("zh-CN", { timeZone: source.timeZone })} · ${source.timeZone}` : null;
  if (schedule.kind === "interval") return `每隔 ${schedule.everySeconds < 60 ? `${schedule.everySeconds}秒` : `${schedule.everySeconds / 60}分钟`}`;
  return `${schedule.weekdays ? `每周 ${schedule.weekdays.join("、")}` : "每天"} ${schedule.time} · ${schedule.timeZone}`;
}
