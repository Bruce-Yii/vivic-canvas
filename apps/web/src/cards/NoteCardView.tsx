import type { NoteCard } from "./dataCardTypes";
import { Fragment } from "react";
import { CARD_INNER_HEIGHT } from "./metrics";
import { renderVivicSpec } from "./vivicGUILibrary";
import { SubcardAnchor } from "./SubcardAnchor";
import { ConnectedResultCard } from "@/connections/ConnectedResultCard";

/** Density changes only with the stored variant; Display adds no expand button. */
export const NoteCardView = ({ card }: { card: NoteCard }) => card.sourceData.connectedSource && typeof card.sourceData.connectedSource === "object"
  && typeof (card.sourceData.connectedSource as Record<string, unknown>).text === "string" ? <ConnectedResultCard card={card} /> : <div
  className="vivic-note-content min-w-0 whitespace-pre-wrap break-words"
  style={card.variant === "expanded" ? undefined : {
    maxHeight: Math.max(28, Math.min(card.layout.height - CARD_INNER_HEIGHT, card.variant === "minimal" ? 84 : 168)),
    overflow: "hidden",
  }}
  data-vivic-note-variant={card.variant}
>
  <div>{card.displayProps.text?.split("\n").map((line, index, lines) => <Fragment key={`line:${index + 1}`}>
    <div className="vivic-note-line"><SubcardAnchor card={card} itemId={`line:${index + 1}`}>{renderVivicSpec({ _type: "Text", value: line })}</SubcardAnchor></div>
    {index < lines.length - 1 ? "\n" : null}
  </Fragment>)}</div>
  {(card.displayProps.bullets ?? []).map((bullet, index) => <div className="mt-2" key={`bullet:${index + 1}`}>
    <SubcardAnchor card={card} itemId={`bullet:${index + 1}`}>{renderVivicSpec({ _type: "Text", value: `• ${bullet}`, color: "secondary" })}</SubcardAnchor>
  </div>)}
</div>;
