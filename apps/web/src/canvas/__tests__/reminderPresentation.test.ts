import { expect, it } from "vitest";
import { presentCards } from "../reminderPresentation";
import { createCanvasStore, hasUnpinnedOverlap } from "@/state/canvasStore";
import { testCards } from "@/cards/__tests__/fixtures";
import type { CountdownCard } from "@/contracts";
const timer = (id: string, text?: string): CountdownCard => ({ ...testCards.CountdownCard, id, layout: { ...testCards.CountdownCard.layout, width: 264, height: 96 }, sourceData: { targetAt: new Date(Date.now() + 600000).toISOString(), ...(text ? { reminderText: text } : {}) } });
it("presents named reminders as one list while keeping plain timers and pinned cards independent", () => {
  const a = timer("a", "喝水"), b = timer("b", "休息"), plain = timer("plain");
  const view = presentCards([a, b, plain].map(record => ({ record })));
  expect(view).toHaveLength(2); expect(view[0]!.memberIds).toEqual(["a", "b"]);
  expect(view[0]!.reminders?.map(card => card.sourceData.reminderText)).toEqual(["喝水", "休息"]);
  const pinned = { ...b, layout: { ...b.layout, x: 800, pinned: true } };
  expect(presentCards([a, pinned, plain].map(record => ({ record })))).toHaveLength(3);
});
it("expires delivered one-offs from the display without losing condition history or recurring schedules", () => {
  const a = timer("a", "喝水"), done = { ...a, sourceData: { ...a.sourceData, notifiedAt: "2026-10-16T00:00:00.000Z" } };
  expect(presentCards([{ record: done }])).toHaveLength(0);
  expect(presentCards([{ record: { ...done, sourceData: { ...done.sourceData, notifiedAt: null, schedule: { kind: "interval", everySeconds: 60 } } } }])).toHaveLength(1);
  expect(done.sourceData.notifiedAt).toBeTruthy();
});
it("reserves group height around pinned obstacles and moves the group through the existing interaction", () => {
  const store = createCanvasStore();
  const pinned = { ...testCards.TodoCard, layout: { ...testCards.TodoCard.layout, pinned: true } };
  store.dispatch({ schemaVersion: "0.6", canvasId: "TEST", requestId: "seed", actions: [pinned, timer("a", "很长的事项".repeat(20)), timer("b", "休息")].map(card => ({ type: "card.create", card })) });
  expect(hasUnpinnedOverlap(store.getState().cards)).toBe(false);
  const before = store.getState().cards.find(c => c.record.id === "a")!.record.layout;
  expect(store.interact("move", { kind: "card.move", cardId: "a", from: before, x: 900, y: 900 }).ok).toBe(true);
  const cards = store.getState().cards;
  expect(cards.find(c => c.record.id === "b")!.record.layout.x).toBe(900);
  expect(cards.find(c => c.record.id === pinned.id)!.record.layout).toEqual(pinned.layout);
});
it("separates plans from immediate reminders and keeps far-future and unmet conditions in Control", () => {
  const soon = timer("soon", "喝水");
  const recurring = { ...timer("repeat", "休息"), sourceData: { ...soon.sourceData, reminderText: "休息", schedule: { kind: "interval" as const, everySeconds: 600 } } };
  const far = { ...timer("far", "明天开会"), sourceData: { targetAt: new Date(Date.now() + 86400000).toISOString(), reminderText: "明天开会", timeZone: "Asia/Shanghai" } };
  const waiting = { ...timer("waiting", "检查"), sourceData: { ...soon.sourceData, condition: { kind: "todo.completed" as const, cardId: "todo", delaySeconds: 5 } } };
  const cards = [soon, recurring, far, waiting].map(record => ({ record }));
  expect(presentCards(cards).map(group => group.memberIds)).toEqual([["soon"], ["repeat"]]);
  expect(presentCards(cards, { now: Date.now() + 86400000 - 3600000 }).flatMap(group => group.memberIds)).toContain("far");
  expect(presentCards(cards, { focusId: "far" }).flatMap(group => group.memberIds)).toContain("far");
  expect(cards).toHaveLength(4);
});
it("does not move pinned cards while bringing a hidden reminder into focus", () => {
  const store = createCanvasStore();
  const pinned = { ...testCards.TodoCard, layout: { ...testCards.TodoCard.layout, pinned: true } };
  const far = { ...timer("far", "明天开会"), sourceData: { targetAt: new Date(Date.now() + 86400000).toISOString(), reminderText: "明天开会" } };
  store.dispatch({ schemaVersion: "0.6", canvasId: "TEST", requestId: "setup", actions: [pinned, far].map(card => ({ type: "card.create", card })) });
  store.dispatch({ schemaVersion: "0.6", canvasId: "TEST", requestId: "focus", actions: [{ type: "card.focus", targetId: "far" }] });
  expect(store.getState().cards.find(c => c.record.id === pinned.id)!.record.layout).toEqual(pinned.layout);
  const shown = presentCards(store.getState().cards, { focusId: "far" });
  expect(shown).toHaveLength(2);
  const [a, b] = shown.map(c => c.entry.record.layout);
  expect(a!.x + a!.width <= b!.x || b!.x + b!.width <= a!.x || a!.y + a!.height <= b!.y || b!.y + b!.height <= a!.y).toBe(true);
});
it("moving an immediate reminder never drags the separate recurring plan along", () => {
  const store = createCanvasStore();
  const relative = timer("water", "喝水"), planned = timer("repeat", "休息");
  planned.sourceData.schedule = { kind: "interval", everySeconds: 600 };
  store.dispatch({ schemaVersion: "0.6", canvasId: "TEST", requestId: "groups", actions: [relative, planned].map(card => ({ type: "card.create", card })) });
  const before = store.getState().cards.find(c => c.record.id === planned.id)!.record.layout;
  const from = store.getState().cards.find(c => c.record.id === relative.id)!.record.layout;
  store.interact("move-relative", { kind: "card.move", cardId: relative.id, from, x: 900, y: 900 });
  expect(store.getState().cards.find(c => c.record.id === planned.id)!.record.layout).toEqual(before);
});
