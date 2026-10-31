import { onUserSurface, type CountdownCard } from "@/contracts";
import type { CardState } from "@/state/canvasStore";
import { CARD_INNER_HEIGHT } from "@/cards/metrics";
export const completedCountdown = (entry: CardState) => entry.record.type === "CountdownCard" && Boolean(entry.record.sourceData.notifiedAt) && !entry.record.sourceData.schedule;
export const REMINDER_HORIZON_MS = 60 * 60 * 1000;
export const reminderGroupKey = (entry: CardState) => JSON.stringify([
  entry.record.type === "CountdownCard" && (entry.record.sourceData.schedule || entry.record.sourceData.timeZone || entry.record.sourceData.condition) ? "planned" : "relative",
  entry.record.metadata.section ?? "",
]);
export function reminderVisible(entry: CardState, now = Date.now()): boolean {
  if (completedCountdown(entry)) return false;
  if (entry.record.type !== "CountdownCard" || !entry.record.sourceData.reminderText || entry.record.layout.pinned) return true;
  const source = entry.record.sourceData;
  if (source.condition && !source.conditionMetAt) return false;
  return Date.parse(source.targetAt) - (source.pausedAt ? Date.parse(source.pausedAt) : now) <= REMINDER_HORIZON_MS;
}
export const groupedReminder = (entry: CardState) => entry.record.type === "CountdownCard" && Boolean(entry.record.sourceData.reminderText) && !entry.record.layout.pinned && !entry.exitingRequestId && reminderVisible(entry);
export interface PresentedCard { entry: CardState; reminders?: CountdownCard[]; memberIds: string[] }
/** Derived view only: preserve every timer's ID, task, pause state and delivery.
 * Pinned cards remain separate; completed timers stay available to Control and
 * conditions but occupy no display/layout space. */
export function presentCards(cards: CardState[], options: { focusId?: string; now?: number } = {}): PresentedCard[] {
  const now = options.now ?? Date.now();
  // Cards moved to the user page are not part of the Display canvas at all.
  const visible = (entry: CardState) => !onUserSurface(entry.record)
    && (reminderVisible(entry, now) || entry.record.id === options.focusId && !completedCountdown(entry));
  const grouped = (entry: CardState) => entry.record.type === "CountdownCard" && Boolean(entry.record.sourceData.reminderText) && !entry.record.layout.pinned && !entry.exitingRequestId && visible(entry);
  const groups = new Map<string, CardState[]>();
  for (const card of cards.filter(grouped)) {
    const key = reminderGroupKey(card);
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  return cards.flatMap(entry => {
    if (onUserSurface(entry.record) || (!visible(entry) && !entry.exitingRequestId)) return [];
    if (!grouped(entry)) return [{ entry, memberIds: [entry.record.id] }];
    const group = groups.get(reminderGroupKey(entry))!;
    if (entry !== group[0]) return [];
    const reminders = group.map(item => item.record as CountdownCard);
    const width = Math.max(360, entry.record.layout.width);
    const chars = Math.max(1, Math.floor((width - 168) / 18));
    const height = CARD_INNER_HEIGHT + reminders.reduce((sum, card) => sum + Math.max(56, Math.ceil(card.sourceData.reminderText!.length / chars) * 27 + 20), 0);
    return [{ entry: { ...entry, record: { ...entry.record, layout: { ...entry.record.layout, width, height } } }, reminders, memberIds: reminders.map(card => card.id) }];
  });
}
