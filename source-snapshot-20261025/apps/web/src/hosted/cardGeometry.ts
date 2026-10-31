import { hostedCardHeight, type CardRecord } from "@vivic/contracts";
import { CARD_INNER_HEIGHT } from "@/cards/metrics";

/** The same 42px padding/border budget used by the authoritative layout and
 * legacy renderer. Content may scroll, but never enlarge the desktop rectangle. */
export function hostedCardGeometry(card: CardRecord) {
  const height = hostedCardHeight(card);
  return { height, contentHeight: height - CARD_INNER_HEIGHT };
}
