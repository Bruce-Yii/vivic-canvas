import { useState } from "react";
import { Pencil, Quote } from "lucide-react";
import type { QuoteCard } from "@/contracts";
import { SceneCardShell } from "../SceneCardShell";
import { useCardEditor } from "../cardContext";
import { CopyButton, rowsThatFit, useFitHeight } from "../DetailPopover";
import type { CardViewProps } from "../types";
import "./QuoteCardView.css";

const LONG_QUOTE = 100;
const MAX_TEXT = 400;
const MAX_AUTHOR = 60;

type QuoteProps = QuoteCard["displayProps"];

/** `text —— author，source`; parts that are absent are left out. */
export const quoteCopyText = ({ text, author, source }: Pick<QuoteProps, "text" | "author" | "source">): string => {
  const by = [author, source].filter(Boolean).join("，");
  return by ? `${text} —— ${by}` : text;
};

export function QuoteCardView({ card, height }: CardViewProps<"QuoteCard">) {
  const { text, author, source, tag } = card.displayProps;
  const editor = useCardEditor(card);
  const fixed = height !== undefined;
  const long = text.length > LONG_QUOTE;
  const [fitRef, fitHeight] = useFitHeight<HTMLDivElement>(fixed);
  const [editing, setEditing] = useState(false);
  const lines = fixed ? Math.max(1, rowsThatFit(fitHeight, long ? 24 : 29, 24)) : undefined;
  return <SceneCardShell card={card} height={height} bare bleed>
    <figure className="vivic-quote m-0" data-long={long || undefined} data-quote-card>
      <Quote className="vivic-quote-glyph" size={64} strokeWidth={1.6} aria-hidden />
      <span className="vivic-quote-kicker"><Quote size={12} strokeWidth={2.4} aria-hidden />金句</span>
      <div ref={fitRef} className="vivic-quote-fit">
        <blockquote className="vivic-quote-text m-0" style={lines ? { WebkitLineClamp: lines } : undefined} title={fixed && long ? text : undefined} data-quote-text>{text}</blockquote>
      </div>
      {(author || source || tag) && <figcaption className="vivic-quote-by">
        {(author || source) && <span className="vivic-quote-author" data-quote-author>
          {author && <strong>— {author}</strong>}
          {source && <span className="vivic-quote-source">{author ? " · " : "— "}{source}</span>}
        </span>}
        {tag && <span className="vivic-quote-tag" title={tag} data-quote-tag>{tag}</span>}
      </figcaption>}
      {editor.editable && !editing && <div className="vivic-quote-tools nodrag nopan" data-quote-tools>
        <CopyButton text={quoteCopyText({ text, author, source })} ariaLabel="复制这句金句" />
        <button type="button" className="vivic-scene-action nodrag nopan" onClick={() => setEditing(true)} data-quote-edit>
          <Pencil size={13} aria-hidden />编辑
        </button>
      </div>}
      {editor.editable && editing && <QuoteEditor text={text} author={author} onSave={next => editor.patch(next)} onDone={() => setEditing(false)} />}
    </figure>
  </SceneCardShell>;
}

function QuoteEditor({ text, author, onSave, onDone }: {
  text: string; author?: string; onSave: (next: Pick<QuoteProps, "text" | "author">) => boolean; onDone: () => void;
}) {
  const [draft, setDraft] = useState(text);
  const [by, setBy] = useState(author ?? "");
  const [error, setError] = useState<string | null>(null);
  return <form className="vivic-quote-form nodrag nopan" data-quote-form onSubmit={event => {
    event.preventDefault();
    const nextText = draft.trim().slice(0, MAX_TEXT);
    if (!nextText) { setError("金句不能为空。"); return; }
    const nextAuthor = by.trim().slice(0, MAX_AUTHOR);
    if (onSave({ text: nextText, author: nextAuthor || undefined })) onDone();
    else setError("没有保存，请检查控制权后重试。");
  }}>
    <textarea className="vivic-scene-input nowheel" rows={4} maxLength={MAX_TEXT} value={draft} aria-label="金句内容"
      onChange={event => { setDraft(event.target.value); setError(null); }} />
    <div className="flex items-center gap-2">
      <input className="vivic-scene-input min-w-0 flex-1" value={by} maxLength={MAX_AUTHOR} placeholder="作者（可选）" aria-label="作者"
        onChange={event => setBy(event.target.value)} />
      <span className="shrink-0 text-[11.5px] tabular-nums opacity-70">{draft.length}/{MAX_TEXT}</span>
    </div>
    <div className="flex items-center justify-end gap-2">
      {error && <span role="alert" className="mr-auto text-xs text-[var(--vivic-danger)]">{error}</span>}
      <button type="button" className="vivic-scene-action" onClick={onDone}>取消</button>
      <button type="submit" className="vivic-scene-action" data-variant="primary" disabled={!draft.trim()}>保存</button>
    </div>
  </form>;
}
