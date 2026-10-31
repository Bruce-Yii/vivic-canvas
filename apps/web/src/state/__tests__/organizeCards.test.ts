import { it, expect } from "vitest";
import { organizedCards, sortCards } from "../organizeCards";
import { cardHeight, hasUnpinnedOverlap, type CardState } from "../canvasStore";
import { presentCards } from "@/canvas/reminderPresentation";
const card = (id: string, dueDate?: string, pinned = false): CardState => ({ record: { id, type: "NoteCard", variant: "standard", displayProps: { text: id }, sourceData: {}, sources: [],
  layout: { x: 120, y: 80, width: 320, height: 180, pinned }, metadata: { createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z", ...(dueDate ? { dueDate } : {}) } } });
it("sorts dates in either direction, missing dates last, equal dates stable", () => {
  const cards = [card("unknown"), card("late", "2026-12-01"), card("early", "2026-10-25"), card("early2", "2026-10-25")];
  expect(sortCards(cards, { sort: "due", direction: "asc", group: "keep" }).map(c => c.record.id)).toEqual(["early", "early2", "late", "unknown"]);
  expect(sortCards(cards, { sort: "due", direction: "desc", group: "keep" }).map(c => c.record.id)).toEqual(["late", "early", "early2", "unknown"]);
});
it("groups cards without overlap, preserves pinned geometry and user-page positions", () => {
  const fixed = card("fixed", "2026-10-25", true), phone = card("phone"); phone.record.layout.surface = "user"; phone.record.layout.userPos = { x: 44, y: 80 };
  const cards = [fixed, ...Array.from({ length: 12 }, (_, i) => card(String(i), i % 2 ? "2026-10-25" : "2026-10-26")), phone];
  const output = organizedCards(cards, { sort: "due", direction: "asc", group: "date" });
  expect(output.find(c => c.record.id === "fixed")!.record.layout).toEqual(fixed.record.layout);
  expect(output.find(c => c.record.id === "phone")!.record.layout).toEqual(phone.record.layout);
  expect(hasUnpinnedOverlap(output)).toBe(false);
  expect(new Set(output.map(c => c.record.metadata.section))).toEqual(new Set(["2026-10-25", "2026-10-26", "未定日期"]));
});
it("uses actual expanded pinned height as an obstacle and never recombines reminders from different sections", () => {
  const pinned = card("pinned", undefined, true);
  if (pinned.record.type === "NoteCard") { pinned.record.variant = "expanded"; pinned.record.displayProps.text = Array.from({ length: 100 }, (_, i) => `TEST pinned line ${i}`).join("\n"); }
  const a = card("a"); a.record.metadata.section = "旅行";
  const output = organizedCards([pinned, a], { sort: "manual", direction: "asc", group: "keep" });
  expect(output[1]!.record.layout.y).toBeGreaterThan(pinned.record.layout.y + cardHeight(pinned));
  expect(hasUnpinnedOverlap(output)).toBe(false);
  const reminders: CardState[] = ["旅行", "工作"].map((section, i) => ({ record: { ...card(`r${i}`).record, type: "CountdownCard", displayProps: {},
    metadata: { ...card(`r${i}`).record.metadata, section }, sourceData: { targetAt: new Date(Date.now() + 600000).toISOString(), reminderText: `TEST ${section}` } } }));
  expect(presentCards(organizedCards(reminders, { sort: "manual", direction: "asc", group: "keep" })).map(p => p.memberIds)).toEqual([["r0"], ["r1"]]);
});
