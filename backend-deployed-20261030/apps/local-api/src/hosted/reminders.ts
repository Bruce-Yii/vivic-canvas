import { createHash } from "node:crypto";
import {
  isDateCountdown, isDue, conditionSatisfied, nextReminderOccurrence, reminderText, ReminderInboxSchema,
  type CardRecord, type CountdownCard, type ReminderNotice,
} from "@vivic/contracts";
import type { HostedSpaceStore } from "../space/store.js";

/** Same pure rules as the previous owner scheduler; the durable transaction now belongs to the server. */
export function createHostedReminderScheduler(store: HostedSpaceStore, options: { now?: () => number; intervalMs?: number; autoStart?: boolean } = {}) {
  const now = options.now ?? Date.now;
  const checked = new Map<string, { version: number; next: number }>();
  let running = false, closed = false, lastError: string | undefined, lastCheckAt: string | undefined;
  const isReminder = (card: CardRecord): card is CountdownCard => card.type === "CountdownCard" && !isDateCountdown(card);
  function check() {
    if (running || closed) return;
    running = true;
    try {
      const currentTime = now();
      for (const account of store.listAccounts()) for (const summary of store.listSpaces(account.id)) {
        const cacheKey = `${account.id}:${summary.id}`, cached = checked.get(cacheKey);
        if (cached && cached.version === summary.version && cached.next > currentTime) continue;
        store.transaction(() => {
          const snapshot = store.getSnapshot(account.id, summary.id), document = store.getSpaceDocument(account.id, summary.id);
          let cards = structuredClone(document.cards), changed = false;
          const existing = store.getAccountValue(account.id, "reminderInbox");
          const parsed = ReminderInboxSchema.safeParse(existing ?? []);
          if (!parsed.success) throw new Error("Reminder inbox requires recovery");
          let inbox = parsed.data;
          const pending = inbox.filter(item => Date.parse(item.targetAt) > currentTime);
          const pruned = pending.length !== inbox.length;
          inbox = pending;
          const updates: string[] = [];
          cards = cards.map(card => {
            if (!isReminder(card) || !conditionSatisfied(card, cards)) return card;
            changed = true; updates.push(`condition:${card.id}`);
            return { ...card, sourceData: { ...card.sourceData, conditionMetAt: new Date(currentTime).toISOString(),
              targetAt: new Date(currentTime + card.sourceData.condition!.delaySeconds * 1000).toISOString(), notifiedAt: null } };
          });
          cards = cards.map(card => {
            if (!isReminder(card) || !isDue(card, currentTime)) return card;
            changed = true; updates.push(`due:${card.id}:${card.sourceData.targetAt}`);
            const targetAt = card.sourceData.targetAt, firedAt = new Date(currentTime).toISOString();
            if (!inbox.some(item => item.canvasId === summary.id && item.cardId === card.id && item.targetAt === targetAt)) {
              const id = `due_${createHash("sha256").update(`${account.id}:${summary.id}:${card.id}:${targetAt}`).digest("hex")}`;
              const notice: ReminderNotice = { id, canvasId: summary.id, canvasTitle: summary.title, cardId: card.id,
                text: reminderText(card), targetAt, firedAt };
              inbox = [...inbox, notice].slice(-50);
            }
            return { ...card, sourceData: { ...card.sourceData, lastFiredAt: firedAt, lastDeliveredTargetAt: targetAt,
              ...(card.sourceData.schedule ? { targetAt: nextReminderOccurrence(card.sourceData.schedule, targetAt, currentTime), notifiedAt: null } : { notifiedAt: firedAt }) } };
          });
          if (changed) {
            // The inbox and all occurrence/next-time stamps are committed together. No client needs to be open.
            store.setAccountValue(account.id, "reminderInbox", ReminderInboxSchema.parse(inbox));
            const requestId = `reminder_${createHash("sha256").update(`${summary.id}:${snapshot.space.version}:${updates.join("|")}`).digest("hex")}`;
            store.replaceSpaceDocument(account.id, summary.id, { requestId, expectedVersion: snapshot.space.version, document: { ...document, cards } });
          } else if (pruned) store.setAccountValue(account.id, "reminderInbox", ReminderInboxSchema.parse(inbox));
          const version = store.getSnapshot(account.id, summary.id).space.version;
          const next = cards.filter(isReminder).filter(card => !card.sourceData.pausedAt && !card.sourceData.notifiedAt
            && (!card.sourceData.condition || card.sourceData.conditionMetAt)).reduce((minimum, card) => Math.min(minimum, Date.parse(card.sourceData.targetAt)), Infinity);
          checked.set(cacheKey, { version, next });
        });
      }
      if (checked.size > 4096) checked.clear();
      lastError = undefined; lastCheckAt = new Date(now()).toISOString();
    } catch { lastError = "提醒记录暂时无法保存，将在服务恢复后重新检查。"; }
    finally { running = false; }
  }
  const timer = options.autoStart === false ? undefined : setInterval(check, options.intervalMs ?? 500);
  timer?.unref();
  return { check, status: () => ({ lastCheckAt, ...(lastError ? { error: lastError } : {}),
    delivery: "server-inbox", backgroundSystemPush: false }), dispose() { closed = true; if (timer) clearInterval(timer); checked.clear(); } };
}
