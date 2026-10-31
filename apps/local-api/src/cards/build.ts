import { randomUUID } from "node:crypto";
import { CardRecordSchema, type Action, type CardRecord } from "@vivic/contracts";
import type { CardBuildContext } from "./types.js";

/** Place only the new card. Existing cards, including pinned cards, never move. */
export function newCardLayout(width: number, height: number, context: CardBuildContext): CardRecord["layout"] {
  const gap = 24;
  let x = 0;
  // Missing footprints use a conservative fallback for older canvas contexts.
  const occupied = context.cards.map(card => ({
    x: card.layout.x, y: card.layout.y,
    width: card.layout.width ?? 640, height: card.layout.height ?? 480,
  }));
  for (let attempt = 0; attempt <= occupied.length; attempt++) {
    const overlap = occupied.find(rect => x < rect.x + rect.width + gap && x + width + gap > rect.x
      && 0 < rect.y + rect.height + gap && height + gap > rect.y);
    if (!overlap) return { x, y: 0, width, height, pinned: false };
    x = overlap.x + overlap.width + gap;
  }
  throw new Error("无法为新卡片确定空位");
}

export const awakenFor = (actions: Action[], context: CardBuildContext): Action[] =>
  context.stage === "STANDBY" ? [{ type: "stage.awaken" }, ...actions] : actions;

export function createCardActions(
  data: Pick<CardRecord, "type" | "displayProps" | "sourceData">,
  size: { width: number; height: number },
  context: CardBuildContext,
  now: Date,
  variant: CardRecord["variant"] = "minimal",
): Action[] {
  const stamp = now.toISOString();
  const card = CardRecordSchema.parse({
    ...data,
    id: `${data.type.replace(/Card$/, "").toLowerCase()}_${randomUUID()}`,
    variant,
    sources: [],
    layout: newCardLayout(size.width, size.height, context),
    metadata: { createdAt: stamp, updatedAt: stamp },
  });
  return awakenFor([{ type: "card.create", card }, { type: "card.focus", targetId: card.id }], context);
}
