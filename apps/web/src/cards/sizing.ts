import { sceneOfCard, type CardRecord } from "@/contracts";
import { CARD_INNER_HEIGHT } from "./metrics";

/** Display shows the first rows of a todo list; the user page shows all of them. */
export const TODO_VISIBLE_ITEMS = 5;

/** Scene cards (except the list-like todo/chart) render at exactly their layout height. */
export const usesFixedHeight = (card: CardRecord): boolean =>
  sceneOfCard(card) !== null && card.type !== "TodoCard" && card.type !== "ChartCard";

export const fixedContentHeight = (card: CardRecord): number | undefined =>
  usesFixedHeight(card) ? Math.max(56, card.layout.height - CARD_INNER_HEIGHT) : undefined;
