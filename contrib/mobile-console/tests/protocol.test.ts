import { describe, expect, it } from "vitest";
import { CardPreviewSchema, CanvasSnapshotSchema, OperationSchema, SubcardPreviewSchema } from "../protocol";

describe("bounded card preview wire contract", () => {
  it("allows only explicit two-way card movement and plain bounded subcards", () => {
    expect(OperationSchema.safeParse({ kind: "card.surface", cardId: "note", surface: "user" }).success).toBe(true);
    expect(OperationSchema.safeParse({ kind: "card.surface", cardId: "note", surface: "display" }).success).toBe(true);
    expect(OperationSchema.safeParse({ kind: "card.surface", cardId: "note", surface: "user", copy: true }).success).toBe(false);
    expect(OperationSchema.safeParse({ kind: "card.surface", cardId: "note", surface: "other" }).success).toBe(false);
    expect(SubcardPreviewSchema.safeParse({ id: "note_1", label: "会议", text: "<script>literal</script>" }).success).toBe(true);
    expect(SubcardPreviewSchema.safeParse({ id: "note_1", label: "会议", text: "x".repeat(2001) }).success).toBe(false);
    expect(SubcardPreviewSchema.safeParse({ id: "note_1", label: "会议", text: "内容", url: "file:///private" }).success).toBe(false);
  });
  it("keeps summary-only snapshots valid and rejects non-whitelisted preview fields", () => {
    const summary = { computerName: "Computer", ownerAvailable: true, ownerEpoch: "owner", activeCanvasId: "canvas", version: 1,
      canvases: [{ id: "canvas", title: "Space", version: 1 }], cards: [{ id: "note", type: "NoteCard", title: "便笺", pinned: false }] };
    expect(CanvasSnapshotSchema.safeParse(summary).success).toBe(true);
    expect(CardPreviewSchema.safeParse({ kind: "text", body: "<script>literal text</script>" }).success).toBe(true);
    expect(CardPreviewSchema.safeParse({ kind: "text", body: "hello", token: "PRIVATE_MARKER" }).success).toBe(false);
    expect(CardPreviewSchema.safeParse({ kind: "text", items: [{ text: "row", url: "https://private.invalid" }] }).success).toBe(false);
    expect(CardPreviewSchema.safeParse({ kind: "chart", series: [{ label: "row", value: Infinity }] }).success).toBe(false);
    expect(CardPreviewSchema.safeParse({ kind: "table", rows: [Array(13).fill("cell")] }).success).toBe(false);
    expect(CardPreviewSchema.safeParse({ kind: "collection", items: Array(41).fill({ text: "row" }) }).success).toBe(false);
  });
});
