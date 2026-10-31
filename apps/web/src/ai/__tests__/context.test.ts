import { expect, it } from "vitest";
import { buildCanvasContext } from "../api";
import { emptyVivicState } from "@/persistence/canvasRecord";
import { testCards } from "@/cards/__tests__/fixtures";
import type { CardRecord } from "@/contracts";
it("keeps a legacy Word card addressable but does not expose its old extract to the model", () => {
  const card: CardRecord = { id: "legacy-word", type: "FileCard", variant: "standard", sources: [], sourceData: {}, metadata: { createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z" },
    layout: { x: 0, y: 0, width: 320, height: 260, pinned: false },
    displayProps: { name: "old.docx", fileId: "old", sha256: "a".repeat(64), sizeBytes: 20, mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", parseStatus: "ready", previewText: "LEGACY EXTRACT" } };
  const context = buildCanvasContext({ ...emptyVivicState(), cards: [{ record: card }] }, "TEST");
  expect(context.cards[0]?.id).toBe("legacy-word");
  expect(context.cards[0]?.displayProps.name).toBe("old.docx");
  expect(JSON.stringify(context)).not.toContain("LEGACY EXTRACT");
  expect(context.cards[0]?.displayProps.parseStatus).toBe("unsupported");
});
it("omits credential-shaped source fields regardless of case, and bounds retained article context", () => {
  const state = { ...emptyVivicState(), cards: [{ record: { ...testCards.NoteCard, sourceData: {
    apiKey: "TEST-not-a-real-key", APIKEY: "TEST-uppercase", Token: "TEST-token", SECRET: "TEST-secret",
    articleText: "TEST ".repeat(1000), provenance: "TEST verified source",
  } } }] };
  const context = buildCanvasContext(state, "TEST");
  expect(context.cards[0]!.sourceDataSummary).toEqual({ articleText: "[5000 chars, retained on the source card]", provenance: "TEST verified source" });
});

it("selects at most 64 cards, keeping current focus and pinned cards ahead of recent cards", () => {
  const cards = Array.from({ length: 80 }, (_, index) => ({ record: { ...testCards.NoteCard, id: `card-${index}`,
    metadata: { ...testCards.NoteCard.metadata, updatedAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString() },
    layout: { ...testCards.NoteCard.layout, pinned: index === 1 } } }));
  const state = { ...emptyVivicState(), cards, focus: { cardId: "card-0", prevViewport: { x: 0, y: 0, zoom: 1 } }, focusHistory: ["card-0", "card-3"] };
  const context = buildCanvasContext(state, "TEST");
  expect(context.cards).toHaveLength(64);
  expect(context.totalCardCount).toBe(80);
  expect(context.cards.map(card => card.id)).toContain("card-0");
  expect(context.cards.map(card => card.id)).toContain("card-1");
  expect(context.cards.map(card => card.id)).not.toContain("card-3");
  expect(context.focusHistory).toEqual(["card-0"]);
  expect(context.cards.at(-1)?.id).toBe("card-79");
});

it("retains a complete bounded Todo list and original card order for positional targeting", () => {
  const todo = { ...testCards.TodoCard, displayProps: { items: Array.from({ length: 30 }, (_, i) => ({ id: `task-${i}`, text: "x".repeat(160), done: false })) } };
  const context = buildCanvasContext({ ...emptyVivicState(), cards: [{ record: testCards.NoteCard }, { record: todo }] }, "TEST");
  expect(context.cards.map(card => card.id)).toEqual([testCards.NoteCard.id, todo.id]);
  expect(context.cards[1]?.displayProps).toEqual(todo.displayProps);
  expect(context.cards[1]?.contextSummary).toBeUndefined();
  expect(context.totalCardCount).toBeUndefined();
});

it("marks partial display fields and keeps an exact bounded provenance receipt", () => {
  const receipt = JSON.stringify({ version: 1, sources: [], sourceData: { retained: "x".repeat(1000) } });
  const card: CardRecord = { ...testCards.TableCard, displayProps: { columns: ["name", "value"], rows: Array.from({ length: 80 }, (_, i) => [`Row ${i}`, i]) },
    sourceData: { dataProvenanceJson: receipt, articleText: "x".repeat(50000) } };
  const context = buildCanvasContext({ ...emptyVivicState(), cards: [{ record: card }] }, "TEST");
  expect(context.cards[0]?.sourceDataSummary.dataProvenanceJson).toBe(receipt);
  expect(context.cards[0]?.contextSummary?.truncatedFields).toContain("rows");
  expect(JSON.stringify(context).length).toBeLessThan(5000);
});
