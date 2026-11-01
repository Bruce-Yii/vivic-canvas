import type { NoteCard } from "./dataCardTypes";
import { Fragment } from "react";
import { CARD_INNER_HEIGHT, CARD_METRICS } from "./metrics";
import { renderVivicSpec } from "./vivicGUILibrary";
import { SubcardAnchor } from "./SubcardAnchor";
import { ConnectedResultCard } from "@/connections/ConnectedResultCard";

/** Density changes only with the stored variant; Display adds no expand button. */
export const NoteCardView = ({ card }: { card: NoteCard }) => card.sourceData.connectedSource && typeof card.sourceData.connectedSource === "object"
  && typeof (card.sourceData.connectedSource as Record<string, unknown>).text === "string" ? <ConnectedResultCard card={card} /> : <NoteCardBody card={card} />;

type NoteRow = { height: number; gap: number };
/** Room the "+N" marker needs, reserved so no half-row sits under it. */
const NOTE_MORE_ROW = 24;
const NOTE_HEADING_HEIGHT = 24;
const NOTE_GAP = 4;
const NOTE_SECTION_GAP = 12;

/** The line boxes NotePlainText/NoteSections actually render, in order. */
const noteRows = (card: NoteCard): NoteRow[] => {
  const sections = card.displayProps.sections ?? [];
  if (sections.length) {
    return sections.flatMap((section, sectionIndex) => [
      { height: NOTE_HEADING_HEIGHT, gap: sectionIndex ? NOTE_SECTION_GAP : 0 },
      ...section.items.map(() => ({ height: CARD_METRICS.lineHeight, gap: NOTE_GAP })),
    ]);
  }
  const text = card.displayProps.text;
  const rows: NoteRow[] = text === undefined ? [] : text.split("\n").map(() => ({ height: CARD_METRICS.lineHeight, gap: 0 }));
  for (let index = 0; index < (card.displayProps.bullets?.length ?? 0); index++) rows.push({ height: CARD_METRICS.lineHeight, gap: 8 });
  return rows;
};

/**
 * Lines a folded card shows and lines it cannot. This is deliberately
 * estimated from the stored height and the renderer's own line boxes (never
 * measured in jsdom): wrapping can only add hidden lines, so the hidden count
 * is a floor. Expanded never clips and never reports overflow.
 */
const noteRowsFitting = (card: NoteCard, maxHeight: number): { visible: number; hidden: number } => {
  const rows = noteRows(card);
  const shown = (limit: number) => {
    let used = 0, count = 0;
    for (const row of rows) {
      const bottom = used + row.gap + row.height;
      if (bottom > limit) break;
      used = bottom; count += 1;
    }
    return count;
  };
  const fitting = shown(maxHeight);
  if (fitting >= rows.length) return { visible: rows.length, hidden: 0 };
  // Rows under the "+N" marker are hidden too, so the count stays honest.
  const visible = shown(Math.max(0, maxHeight - NOTE_MORE_ROW));
  return { visible, hidden: rows.length - visible };
};

/**
 * Structured notes stay inside the existing NoteCard: short section headings
 * with their own lines, never a new card type or a second visual shell.
 */
const NoteCardBody = ({ card }: { card: NoteCard }) => {
  const sections = card.displayProps.sections ?? [];
  const available = Math.max(28, card.layout.height - CARD_INNER_HEIGHT);
  // A folded section note still shows its first heading and line; a standard
  // one uses the room its creation size reserved. Expanded is unbounded.
  const maxHeight = sections.length
    ? card.variant === "minimal" ? Math.min(available, 84) : available
    : Math.min(available, card.variant === "minimal" ? 84 : 168);
  const { visible, hidden } = card.variant === "expanded"
    ? { visible: Number.POSITIVE_INFINITY, hidden: 0 }
    : noteRowsFitting(card, maxHeight);
  return <div
    className="vivic-note-content relative min-w-0 whitespace-pre-wrap break-words"
    style={card.variant === "expanded" ? undefined : { maxHeight, overflow: "hidden" }}
    data-vivic-note-variant={card.variant}
    data-vivic-note-layout={sections.length ? "sections" : "plain"}
  >
    {sections.length ? <NoteSections card={card} sections={sections} visible={visible} /> : <NotePlainText card={card} visible={visible} />}
    {hidden > 0 && <span
      className="pointer-events-none absolute bottom-0 right-0 rounded-tl-lg bg-[var(--hark-solid,var(--card))] px-2 text-[12px] font-medium leading-6 text-[var(--vivic-reading-muted)]"
      role="note" aria-label={`还有 ${hidden} 行未显示，可在阅读详情中查看全文`}
      data-vivic-note-overflow={hidden}
    >+{hidden}</span>}
  </div>;
};

const NotePlainText = ({ card, visible }: { card: NoteCard; visible: number }) => {
  const lines = card.displayProps.text?.split("\n") ?? [];
  const bullets = card.displayProps.bullets ?? [];
  return <>
    <div>{lines.map((line, index) => {
      const clipped = index >= visible;
      return <Fragment key={`line:${index + 1}`}>
        <div className="vivic-note-line" style={clipped ? { visibility: "hidden" } : undefined} data-vivic-note-clipped={clipped || undefined}>
          <SubcardAnchor card={card} itemId={`line:${index + 1}`}>{renderVivicSpec({ _type: "Text", value: line })}</SubcardAnchor>
        </div>
        {index < lines.length - 1 ? "\n" : null}
      </Fragment>;
    })}</div>
    {bullets.map((bullet, index) => {
      const clipped = lines.length + index >= visible;
      return <div className="mt-2" key={`bullet:${index + 1}`} style={clipped ? { visibility: "hidden" } : undefined} data-vivic-note-clipped={clipped || undefined}>
        <SubcardAnchor card={card} itemId={`bullet:${index + 1}`}>{renderVivicSpec({ _type: "Text", value: `• ${bullet}`, color: "secondary" })}</SubcardAnchor>
      </div>;
    })}
  </>;
};

/** First row index of each section, matching noteRows(). */
const sectionRowOffsets = (sections: NonNullable<NoteCard["displayProps"]["sections"]>): number[] => {
  const offsets: number[] = [];
  let row = 0;
  for (const section of sections) { offsets.push(row); row += 1 + section.items.length; }
  return offsets;
};

const NoteSections = ({ card, sections, visible }: { card: NoteCard; sections: NonNullable<NoteCard["displayProps"]["sections"]>; visible: number }) => {
  const offsets = sectionRowOffsets(sections);
  return <div className="flex min-w-0 flex-col gap-3">
    {sections.map((section, sectionIndex) => {
      const sectionId = `section:${sectionIndex + 1}`;
      const clippedHeading = offsets[sectionIndex]! >= visible;
      return <section key={sectionId} className="min-w-0" data-vivic-note-section={sectionIndex + 1}>
        <h4 className="vivic-note-line m-0 text-[14px] font-semibold leading-6 tracking-[0.01em] text-[var(--vivic-reading-muted)] [overflow-wrap:anywhere]"
          style={clippedHeading ? { visibility: "hidden" } : undefined} data-vivic-note-clipped={clippedHeading || undefined}
          data-vivic-note-section-title>
          <SubcardAnchor card={card} itemId={sectionId}>{section.title}</SubcardAnchor>
        </h4>
        <ul className="m-0 mt-1 list-none space-y-1 p-0">
          {section.items.map((item, itemIndex) => {
            const clipped = offsets[sectionIndex]! + 1 + itemIndex >= visible;
            return <li key={`${sectionId}:item:${itemIndex + 1}`} className="flex min-w-0 items-start gap-2"
              style={clipped ? { visibility: "hidden" } : undefined} data-vivic-note-clipped={clipped || undefined}>
              <span aria-hidden className="shrink-0 select-none leading-7 text-[var(--vivic-reading-muted)]">•</span>
              <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <SubcardAnchor card={card} itemId={`${sectionId}:item:${itemIndex + 1}`}>
                  {renderVivicSpec({ _type: "Text", value: item })}
                </SubcardAnchor>
              </div>
            </li>;
          })}
        </ul>
      </section>;
    })}
  </div>;
};
