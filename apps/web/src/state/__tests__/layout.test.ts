import { describe, expect, it } from "vitest";
import { CardRecordSchema, type CardRecord } from "@/contracts";
import { testCards } from "@/cards/__tests__/fixtures";
import { fromCanvasRecord, toCanvasRecord } from "@/persistence/canvasRecord";
import { createCanvasStore, relayout, type CanvasStore, type CardState } from "@/state/canvasStore";

// Synthetic TEST geometry/content only; these fixtures make no live-data claim.
const mixedCards = (): CardRecord[] => [
  { ...testCards.CountdownCard, layout: { x: 0, y: 0, width: 288, height: 96, pinned: false } },
  { ...testCards.TodoCard, layout: { x: 0, y: 0, width: 300, height: 80, pinned: false },
    displayProps: { items: Array.from({ length: 5 }, (_, i) => ({ id: `long-task-${i}`, text: `TEST ${i} ${"长待办需要换行并完整保留内容".repeat(9)}`, done: i === 1 })) } },
  { ...testCards.SearchResultCard, layout: { x: 0, y: 0, width: 520, height: 128, pinned: false },
    displayProps: { title: `TEST ${"长标题边界验证".repeat(18)}`, summary: `TEST ${"摘要内容需要在卡片内部收束".repeat(15)}`, sourceLabel: "TEST synthetic source" } },
  { ...testCards.WeatherCard, layout: { x: 0, y: 0, width: 180, height: 96, pinned: false } },
  { ...testCards.TableCard, layout: { x: 0, y: 0, width: 640, height: 176, pinned: false } },
  { ...testCards.ChartCard, layout: { x: 0, y: 0, width: 420, height: 240, pinned: false } },
  { ...testCards.NoteCard, variant: "expanded", layout: { x: 0, y: 0, width: 280, height: 72, pinned: false },
    displayProps: { text: Array.from({ length: 4 }, (_, i) => `TEST 第${i + 1}段 ${"多行笔记应保留换行和正文".repeat(7)}`).join("\n"),
      bullets: ["TEST 长条目 " + "笔记条目内容".repeat(20), "TEST 第二条 " + "更多正文".repeat(20)] } },
];
const obstacles = (): CardRecord[] => [
  { ...testCards.SearchResultCard, id: "TEST-pin-search", layout: { x: 0, y: 0, width: 720, height: 320, pinned: true } },
  { ...testCards.ChartCard, id: "TEST-pin-chart", layout: { x: -240, y: 950, width: 560, height: 360, pinned: true } },
];
const entries = (cards: CardRecord[]): CardState[] => cards.map(record => ({ record }));
const layouts = (cards: CardState[]) => Object.fromEntries(cards.map(({ record }) => [record.id, record.layout]));
const nonLayoutData = (cards: CardState[]) => Object.fromEntries(cards.map(({ record }) => {
  const { layout: _layout, ...content } = record;
  return [record.id, content];
}));

/** Pairwise rectangles, deliberately independent of grid columns/spacing. */
const expectDisjoint = (cards: CardState[]) => {
  const active = cards.filter(c => !c.exitingRequestId);
  expect(new Set(active.map(c => c.record.id)).size).toBe(active.length);
  for (const { record } of active) {
    for (const value of Object.values(record.layout).filter(value => typeof value === "number")) expect(Number.isFinite(value)).toBe(true);
    expect(record.layout.width).toBeGreaterThan(0); expect(record.layout.height).toBeGreaterThan(0);
  }
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
    const a = active[i]!.record, b = active[j]!.record;
    const width = Math.min(a.layout.x + a.layout.width, b.layout.x + b.layout.width) - Math.max(a.layout.x, b.layout.x);
    const height = Math.min(a.layout.y + a.layout.height, b.layout.y + b.layout.height) - Math.max(a.layout.y, b.layout.y);
    expect(width > 0 && height > 0, `${a.id} overlaps ${b.id}: ${JSON.stringify([a.layout, b.layout])}`).toBe(false);
  }
};
const dispatch = (store: CanvasStore, requestId: string, actions: object[]) => {
  expect(store.dispatch({ schemaVersion: "0.6", canvasId: "TEST-layout", requestId, actions })).toEqual({ ok: true, deduplicated: false });
};
const seed = () => {
  const store = createCanvasStore();
  const cards = [...mixedCards(), ...obstacles()];
  dispatch(store, "seed", cards.map(card => ({ type: "card.create", card })));
  return { store, cards };
};

describe("layout business invariants", () => {
  it("retains records and array identity when relayout does not change geometry", () => {
    const placed = relayout(entries(mixedCards()));
    const repeated = relayout(placed);
    expect(repeated).toBe(placed);
    repeated.forEach((entry, index) => {
      expect(entry).toBe(placed[index]);
      expect(entry.record).toBe(placed[index]!.record);
    });
  });
  it("uses valid fixtures spanning all seven types and long, multiline content", () => {
    expect(new Set(mixedCards().map(c => c.type)).size).toBe(7);
    for (const card of [...mixedCards(), ...obstacles()]) expect(CardRecordSchema.safeParse(card).success, card.id).toBe(true);
  });

  it.each(["original", "reversed", "rotated"] as const)("keeps mixed widths/heights disjoint in %s insertion order", order => {
    const cards = mixedCards();
    const ordered = order === "reversed" ? cards.reverse() : order === "rotated" ? [...cards.slice(3), ...cards.slice(0, 3)] : cards;
    const before = structuredClone(ordered);
    const placed = relayout(entries(ordered));
    expectDisjoint(placed);
    expect(nonLayoutData(placed)).toEqual(nonLayoutData(entries(ordered)));
    expect(ordered).toEqual(before); // layout is pure, including nested records
  });

  it("reserves more than the declared minimum for long Todo and expanded multiline Note", () => {
    const placed = relayout(entries(mixedCards()));
    for (const type of ["TodoCard", "NoteCard"] as const) {
      const original = mixedCards().find(c => c.type === type)!;
      expect(placed.find(c => c.record.type === type)!.record.layout.height).toBeGreaterThan(original.layout.height);
    }
    expectDisjoint(placed);
  });

  it("treats pinned obstacles as immovable even when they arrive after automatic cards", () => {
    const { store } = seed();
    expectDisjoint(store.getState().cards);
    for (const pin of obstacles()) expect(layouts(store.getState().cards)[pin.id]).toEqual(pin.layout);
    dispatch(store, "more", [{ type: "card.create", card: { ...testCards.TableCard, id: "TEST-wide-extra", layout: { x: 0, y: 0, width: 980, height: 460, pinned: false } } }]);
    expectDisjoint(store.getState().cards);
    for (const pin of obstacles()) expect(layouts(store.getState().cards)[pin.id]).toEqual(pin.layout);
  });

  it("preserves restored/manual coordinates as obstacles without changing their pin state", () => {
    const manual: CardRecord = { ...testCards.WeatherCard, id: "TEST-manual", layout: { x: 0, y: 0, width: 680, height: 500, pinned: false } };
    const placed = relayout(entries([...mixedCards(), manual]), new Set([manual.id]));
    expect(layouts(placed)[manual.id]).toEqual(manual.layout);
    expectDisjoint(placed);
  });

  it("delete then undo restores the exact card while moving conflicting survivors out of its slot", () => {
    const { store } = seed();
    const before = store.toJSON(), deleted = before.cards.find(c => c.record.type === "TodoCard")!;
    dispatch(store, "delete", [{ type: "card.delete", targetId: deleted.record.id }]);
    store.internal({ type: "card.delete.commit", requestId: "delete" });
    expectDisjoint(store.getState().cards);
    expect(store.getState().cards.some(c => c.record.id === deleted.record.id)).toBe(false);
    store.internal({ type: "undo" });
    const restored = store.getState().cards;
    expect(restored.map(c => c.record.id)).toEqual(before.cards.map(c => c.record.id));
    expect(restored.find(c => c.record.id === deleted.record.id)!.record).toEqual(deleted.record);
    expect(nonLayoutData(restored)).toEqual(nonLayoutData(before.cards));
    for (const pin of obstacles()) expect(layouts(restored)[pin.id]).toEqual(pin.layout);
    expectDisjoint(restored);
  });

  it("undo remains disjoint when another card was created after the deletion", () => {
    const { store } = seed();
    const deleted = store.getState().cards.find(c => c.record.type === "NoteCard")!.record;
    dispatch(store, "del-then-add", [{ type: "card.delete", targetId: deleted.id }]);
    store.internal({ type: "card.delete.commit", requestId: "del-then-add" });
    const newcomer: CardRecord = { ...testCards.ChartCard, id: "TEST-newcomer", layout: { x: 0, y: 0, width: 820, height: 480, pinned: false } };
    dispatch(store, "add-after-delete", [{ type: "card.create", card: newcomer }]);
    store.internal({ type: "undo" });
    expect(store.getState().cards.find(c => c.record.id === deleted.id)!.record).toEqual(deleted);
    expect(store.getState().cards.find(c => c.record.id === newcomer.id)?.record.displayProps).toEqual(newcomer.displayProps);
    expectDisjoint(store.getState().cards);
  });

  it("batch delete/undo restores all records and pin positions without collision", () => {
    const { store } = seed(), before = store.toJSON();
    const ids = ["TEST-search", "TEST-note", "TEST-pin-chart"];
    dispatch(store, "batch-delete", ids.map(targetId => ({ type: "card.delete", targetId })));
    store.internal({ type: "card.delete.commit", requestId: "batch-delete" });
    store.internal({ type: "undo" });
    expect(nonLayoutData(store.getState().cards)).toEqual(nonLayoutData(before.cards));
    for (const id of ids) expect(store.getState().cards.find(c => c.record.id === id)!.record).toEqual(before.cards.find(c => c.record.id === id)!.record);
    expectDisjoint(store.getState().cards);
  });

  it("fit/800x600 and persistence round-trip preserve positions and pin state", () => {
    const { store } = seed();
    const before = structuredClone(layouts(store.getState().cards));
    store.internal({ type: "canvas.viewportSize", width: 800, height: 600 });
    dispatch(store, "small-fit", [{ type: "canvas.fit" }]);
    expect(layouts(store.getState().cards)).toEqual(before);
    const record = JSON.parse(JSON.stringify(toCanvasRecord("TEST-layout", "TEST overlap", 4, store.getState())));
    const revived = createCanvasStore(); revived.internal({ type: "canvas.viewportSize", width: 800, height: 600 });
    revived.loadState(fromCanvasRecord(record));
    expect(layouts(revived.getState().cards)).toEqual(before);
    expect(revived.getState().viewportSize).toEqual({ width: 800, height: 600 });
    expectDisjoint(revived.getState().cards);
  });

  it.each(["TodoCard", "NoteCard"] as const)("content growth via card.update reserves space for %s instead of covering the next row", type => {
    const store = createCanvasStore();
    const short: CardRecord = type === "TodoCard"
      ? { ...testCards.TodoCard, id: "TEST-growing", layout: { x: 0, y: 0, width: 260, height: 120, pinned: false }, displayProps: { items: [{ id: "grow-0", text: "TEST short", done: false }] } }
      : { ...testCards.NoteCard, id: "TEST-growing", variant: "expanded", layout: { x: 0, y: 0, width: 260, height: 120, pinned: false }, displayProps: { text: "TEST short" } };
    const neighbors = Array.from({ length: 3 }, (_, index) => ({ ...testCards.WeatherCard, id: `TEST-neighbor-${index}` }));
    dispatch(store, "growth-seed", [short, ...neighbors].map(card => ({ type: "card.create", card })));
    const originalHeight = store.getState().cards[0]!.record.layout.height;
    const displayProps = type === "TodoCard"
      ? { items: Array.from({ length: 5 }, (_, index) => ({ id: `grow-${index}`, text: `TEST ${index} ${"很长的待办文本".repeat(18)}`, done: false })) }
      : { text: Array.from({ length: 4 }, (_, index) => `TEST ${index} ${"多行长笔记".repeat(18)}`).join("\n"), bullets: ["TEST " + "长条目".repeat(40)] };
    dispatch(store, "grow-content", [{ type: "card.update", targetId: short.id, displayProps }]);
    const grown = store.getState().cards.find(card => card.record.id === short.id)!.record;
    expect(grown.displayProps).toEqual(displayProps);
    expect(grown.layout.height, "updated content must reserve a new render height before fitting").toBeGreaterThan(originalHeight);
    expectDisjoint(store.getState().cards);
    for (const neighbor of neighbors) expect(store.getState().cards.find(card => card.record.id === neighbor.id)?.record.displayProps).toEqual(neighbor.displayProps);
  });

  it.each(["TodoCard", "NoteCard"] as const)("requests fit when a %s update grows outside 800x600", type => {
    const store = createCanvasStore();
    store.internal({ type: "canvas.viewportSize", width: 800, height: 600 });
    const short: CardRecord = type === "TodoCard"
      ? { ...testCards.TodoCard, id: "TEST-fit-growth", layout: { x: 0, y: 0, width: 260, height: 120, pinned: false }, displayProps: { items: [{ id: "fit-short", text: "TEST short", done: false }] } }
      : { ...testCards.NoteCard, id: "TEST-fit-growth", variant: "expanded", layout: { x: 0, y: 0, width: 260, height: 120, pinned: false }, displayProps: { text: "TEST short" } };
    dispatch(store, "fit-growth-seed", [{ type: "card.create", card: short }]);
    expect(store.getState().lastFitRequestId).toBeNull();
    const longer = mixedCards().find(card => card.type === type)!;
    dispatch(store, "fit-growth-update", [{ type: "card.update", targetId: short.id, displayProps: longer.displayProps }]);
    expect(store.getState().cards[0]!.record.layout.height).toBeGreaterThan(600);
    expect(store.getState().lastFitRequestId).toBe("fit-growth-update");
    expect(store.getState().viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("a non-growing update that already fits keeps positions and does not request fit", () => {
    const store = createCanvasStore();
    store.internal({ type: "canvas.viewportSize", width: 1440, height: 900 });
    dispatch(store, "quiet-update-seed", [testCards.TodoCard, testCards.WeatherCard].map(card => ({ type: "card.create", card })));
    const before = structuredClone(layouts(store.getState().cards));
    const neighbor = structuredClone(store.getState().cards.find(card => card.record.type === "WeatherCard")!.record);
    dispatch(store, "quiet-update", [{ type: "card.update", targetId: testCards.TodoCard.id,
      displayProps: { items: [{ id: "TEST-task", text: "TEST done", done: true }] } }]);
    expect(layouts(store.getState().cards)).toEqual(before);
    expect(store.getState().lastFitRequestId).toBeNull();
    expect(store.getState().cards.find(card => card.record.id === neighbor.id)!.record).toEqual(neighbor);
    expectDisjoint(store.getState().cards);
  });

  it("expanding/collapsing a Note preserves original data and clears space around its full content", () => {
    const store = createCanvasStore();
    const note = { ...testCards.NoteCard, layout: { ...testCards.NoteCard.layout, width: 260, height: 120 },
      displayProps: { text: "TEST original note\n".repeat(20) }, sourceData: { original: "TEST source stays intact" } };
    dispatch(store, "density-seed", [note, ...Array.from({ length: 4 }, (_, index) => ({ ...testCards.WeatherCard, id: `TEST-density-neighbor-${index}` }))].map(card => ({ type: "card.create", card })));
    dispatch(store, "expand-note", [{ type: "card.update", targetId: note.id, variant: "expanded" }]);
    const expanded = store.getState().cards.find(card => card.record.id === note.id)!.record;
    expect(expanded.variant).toBe("expanded");
    expect(expanded.layout.height).toBeGreaterThan(note.layout.height);
    expect(expanded.displayProps).toEqual(note.displayProps); expect(expanded.sourceData).toEqual(note.sourceData);
    expectDisjoint(store.getState().cards);
    dispatch(store, "collapse-note", [{ type: "card.update", targetId: note.id, variant: "minimal" }]);
    const collapsed = store.getState().cards.find(card => card.record.id === note.id)!.record;
    expect(collapsed.variant).toBe("minimal");
    expect(collapsed.layout.height).toBeLessThan(expanded.layout.height);
    expect(collapsed.displayProps).toEqual(note.displayProps); expect(collapsed.sourceData).toEqual(note.sourceData);
    expectDisjoint(store.getState().cards);
    const before = structuredClone(store.getState().cards);
    dispatch(store, "cannot-expand-weather", [{ type: "card.update", targetId: "TEST-density-neighbor-0", variant: "expanded" }]);
    expect(store.getState().cards).toEqual(before);
  });

  it("60 mixed cards remain disjoint around pinned obstacles", () => {
    const cards = Array.from({ length: 60 }, (_, i) => ({ ...mixedCards()[i % 7]!, id: `TEST-load-${i}` }));
    const placed = relayout(entries([...cards, ...obstacles()]));
    expect(placed).toHaveLength(62); expectDisjoint(placed);
    for (const pin of obstacles()) expect(layouts(placed)[pin.id]).toEqual(pin.layout);
  });
});
