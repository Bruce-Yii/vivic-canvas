import { describe, expect, it } from "vitest";
import { cardTargets, type CardRecord } from "@vivic/contracts";
import { projectMobileSubcards } from "../projectSubcards";

const note: CardRecord = { id: "note", type: "NoteCard", variant: "standard", displayProps: { text: "第一行\n第二行" }, sourceData: {}, sources: [],
  layout: { x: 0, y: 0, width: 320, height: 200, pinned: true }, metadata: { createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z" } };
describe("mobile visible subcard projection", () => {
  it("retains valid whole-card and row notes, removes stale anchors and never forwards target internals", () => {
    const row = cardTargets(note).find(target => target.itemId === "line:1")!;
    const result = projectMobileSubcards({ ...note, metadata: { ...note.metadata, subcards: [
      { id: "whole", text: "整个便笺" }, { id: "current", itemId: row.itemId, anchor: row.anchor, text: "<script>仅作为文字</script>" },
      { id: "stale", itemId: row.itemId, anchor: "old", text: "失效备注" },
    ] } });
    expect(result).toEqual([{ id: "whole", label: "第一行\n第二行", text: "整个便笺" }, { id: "current", label: "第一行", text: "<script>仅作为文字</script>" }]);
    expect(projectMobileSubcards({ ...note, metadata: { ...note.metadata, token: "secret" } })).toEqual([]);
  });
});
