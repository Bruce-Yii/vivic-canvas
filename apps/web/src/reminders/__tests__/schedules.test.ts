import { expect, it } from "vitest";
import { createControlHost } from "@/sync/controlHost";
import { createMemoryDB } from "@/persistence/db";
import { createMemoryHub, flushChannel } from "@/sync/channel";
import { createMemoryLockProvider } from "@/sync/testing";
import { createCanvasStore } from "@/state/canvasStore";
import { testCards } from "@/cards/__tests__/fixtures";
import { isDue, deliveredNoticeCurrent } from "../reminders";
import type { CountdownCard } from "@/contracts";
it("advances recurrences without catch-up bursts, activates todo conditions and preserves them across takeover", async () => {
  let now = Date.parse("2026-10-15T10:00:00Z");
  const db = createMemoryDB(), hub = createMemoryHub(), locks = createMemoryLockProvider(), store = createCanvasStore();
  const owner = createControlHost({ db, channel: hub.createChannel(), store, lockProvider: locks, now: () => now, reminderPollMs: 1000000 });
  const reader = createControlHost({ db, channel: hub.createChannel(), store: createCanvasStore(), lockProvider: locks, now: () => now, reminderPollMs: 1000000 });
  try {
    await owner.start(); const canvasId = owner.getSnapshot().activeCanvasId!;
    const recurring: CountdownCard = { ...testCards.CountdownCard, id: "TEST-recur", sourceData: { targetAt: new Date(now + 10000).toISOString(), schedule: { kind: "interval", everySeconds: 10 } } };
    const condition: CountdownCard = { ...testCards.CountdownCard, id: "TEST-condition", metadata: { createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() },
      sourceData: { targetAt: new Date(now).toISOString(), condition: { kind: "todo.completed", cardId: testCards.TodoCard.id, delaySeconds: 5 } } };
    expect(isDue(condition, now)).toBe(false);
    owner.dispatch({ schemaVersion: "0.6", requestId: "TEST-create", canvasId, actions: [
      { type: "card.create", card: recurring }, { type: "card.create", card: condition }, { type: "card.create", card: testCards.TodoCard },
    ] });
    now += 55000; await owner.checkReminders();
    expect(owner.getSnapshot().reminderNotices).toHaveLength(1);
    const current = owner.getSnapshot().reminders.find(r => r.card.id === recurring.id)!.card;
    expect(Date.parse(current.sourceData.targetAt)).toBe(Date.parse(recurring.sourceData.targetAt) + 50000);
    expect(deliveredNoticeCurrent(owner.getSnapshot().reminderNotices[0]!, current)).toBe(true);
    await owner.checkReminders(); expect(owner.getSnapshot().reminderNotices).toHaveLength(1);
    owner.dispatch({ schemaVersion: "0.6", requestId: "TEST-done", canvasId, actions: [{ type: "card.update", targetId: testCards.TodoCard.id,
      displayProps: { items: testCards.TodoCard.displayProps.items.map(item => ({ ...item, done: true })) } }] });
    await owner.checkReminders();
    const armed = owner.getSnapshot().reminders.find(r => r.card.id === condition.id)!.card;
    expect(armed.sourceData.conditionMetAt).toBeTruthy(); expect(Date.parse(armed.sourceData.targetAt)).toBe(now + 5000);
    now += 5000; await owner.checkReminders();
    expect(owner.getSnapshot().reminderNotices.filter(n => n.cardId === condition.id)).toHaveLength(1);
    await reader.start(); reader.takeover(); await flushChannel(); await reader.checkReminders();
    expect(reader.getSnapshot().reminderNotices.filter(n => n.cardId === condition.id)).toHaveLength(1);
  } finally { owner.stop(); reader.stop(); }
});
