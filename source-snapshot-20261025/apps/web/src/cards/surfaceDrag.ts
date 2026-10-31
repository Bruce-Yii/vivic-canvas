import type { DragEvent } from "react";
import { z } from "zod";
import type { CardSurface } from "@/contracts";

/**
 * Native HTML drag-and-drop carries a card between the Display window and
 * the user page (separate windows of the same browser). The origin is part of
 * the MIME type because only type names are readable before the drop.
 */
export const CARD_DRAG_TYPES: Record<CardSurface, string> = {
  display: "application/x-vivic-card-from-display",
  user: "application/x-vivic-card-from-user",
};

const PayloadSchema = z.strictObject({
  v: z.literal(1),
  canvasId: z.string().min(1).max(128),
  cardId: z.string().min(1).max(128),
  from: z.enum(["display", "user"]),
  /** Where the pointer grabbed the card, so the drop lands under the pointer. */
  grabX: z.number().finite().min(0).max(4000).optional(),
  grabY: z.number().finite().min(0).max(4000).optional(),
});
export type CardDragPayload = z.infer<typeof PayloadSchema>;

export function startCardDrag(event: DragEvent, payload: CardDragPayload, label: string, preview?: Element | null) {
  const transfer = event.dataTransfer;
  transfer.setData(CARD_DRAG_TYPES[payload.from], JSON.stringify(payload));
  // Dropped into another app, the card degrades to its title.
  transfer.setData("text/plain", label);
  transfer.effectAllowed = "move";
  if (preview) {
    const rect = preview.getBoundingClientRect();
    transfer.setDragImage(preview, Math.min(rect.width, Math.max(0, payload.grabX ?? 24)), Math.min(rect.height, Math.max(0, payload.grabY ?? 24)));
  }
}

/** Only drags coming FROM `origin` are accepted by a target. */
export const carriesCard = (event: DragEvent, origin: CardSurface): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes(CARD_DRAG_TYPES[origin]);

export function readCardDrag(event: DragEvent, origin: CardSurface): CardDragPayload | null {
  try {
    const parsed = PayloadSchema.safeParse(JSON.parse(event.dataTransfer.getData(CARD_DRAG_TYPES[origin]) || "null"));
    return parsed.success && parsed.data.from === origin ? parsed.data : null;
  } catch {
    return null;
  }
}
