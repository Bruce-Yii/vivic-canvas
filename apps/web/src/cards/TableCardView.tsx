import type { TableCard } from "./dataCardTypes";
import { StyledDataTable } from "./StyledDataTable";
import { CARD_INNER_HEIGHT } from "./metrics";

export const TableCardView = ({ card, highlightedItemId }: {
  card: TableCard;
  highlightedItemId?: string;
}) => <StyledDataTable
  card={card}
  columns={card.displayProps.columns}
  rows={card.displayProps.rows}
  highlightedItemId={highlightedItemId}
  maxHeight={Math.max(56, card.layout.height - CARD_INNER_HEIGHT)}
/>;
