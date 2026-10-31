import type { CardOfType, CardType } from "@/contracts";
import type { HighlightState } from "@/state/canvasStore";

export interface CardViewProps<T extends CardType = CardType> {
  card: CardOfType<T>;
  /** Display canvas: the exact content height reserved by the layout. Undefined on the user page. */
  height?: number;
  highlight?: HighlightState | null;
}
