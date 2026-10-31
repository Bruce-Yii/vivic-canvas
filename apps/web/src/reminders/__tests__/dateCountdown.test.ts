import { describe, expect, it } from "vitest";
import { CardRecordSchema, type CardRecord } from "@/contracts";
import { presentCards, completedCountdown } from "@/canvas/reminderPresentation";
import { parseCommand } from "@/commands/parse";
import { createMemoryDB } from "@/persistence/db";
import { createCanvasStore } from "@/state/canvasStore";
import { emptyVivicState } from "@/persistence/canvasRecord";
import { createMemoryHub } from "@/sync/channel";
import { createControlHost } from "@/sync/controlHost";
import { createMemoryLockProvider } from "@/sync/testing";

const stamp = "2026-10-17T00:00:00.000Z";
/** A birthday countdown whose date has already arrived must still never "fire". */
const birthday: CardRecord = CardRecordSchema.parse({ id: "birthday", type: "CountdownCard", variant: "standard", displayProps: {},
  sourceData: { targetAt: "2026-10-10T16:00:00.000Z", startedAt: stamp, timeZone: "Asia/Shanghai", event: { title: "生日", date: "2026-10-11" } },
  sources: [], layout: { x: 0, y: 0, width: 300, height: 200, pinned: false }, metadata: { createdAt: stamp, updatedAt: stamp } });

describe("date countdowns are cards, not reminders", () => {
  it("rejects a date countdown that is also a reminder, schedule or pause", () => {
    const base = birthday as Extract<CardRecord, { type: "CountdownCard" }>;
    for (const extra of [{ reminderText: "生日" }, { pausedAt: stamp }, { schedule: { kind: "interval", everySeconds: 60 } }]) {
      expect(CardRecordSchema.safeParse({ ...base, sourceData: { ...base.sourceData, ...extra } }).success).toBe(false);
    }
    expect(CardRecordSchema.safeParse({ ...base, sourceData: { ...base.sourceData, timeZone: undefined } }).success).toBe(false);
  });

  it("is never scheduled, notified or hidden after its date", async () => {
    const store = createCanvasStore();
    const host = createControlHost({ db: createMemoryDB(), store, channel: createMemoryHub().createChannel(), lockProvider: createMemoryLockProvider(), reminderPollMs: 1000000 });
    await host.start();
    const canvasId = host.getSnapshot().activeCanvasId!;
    host.dispatch({ schemaVersion: "0.6", canvasId, requestId: "seed", actions: [{ type: "card.create", card: birthday }] });
    await host.checkReminders();
    expect(host.getSnapshot().reminders).toEqual([]);
    expect(host.getSnapshot().reminderNotices).toEqual([]);
    const entry = store.getState().cards[0]!;
    expect(completedCountdown(entry)).toBe(false);
    expect(presentCards(store.getState().cards).map(item => item.entry.record.id)).toEqual(["birthday"]);
    host.stop();
  });

  it("is not paused or resumed by timer commands", () => {
    const state = { ...emptyVivicState(), stage: "WORKSPACE" as const, cards: [{ record: birthday }] };
    expect(parseCommand("暂停这个倒计时", { state, canvasId: "c" }).kind).toBe("unknown");
  });
});
