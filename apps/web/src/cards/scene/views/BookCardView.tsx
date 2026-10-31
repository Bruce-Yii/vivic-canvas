import { useState } from "react";
import { Plus, Star } from "lucide-react";
import type { BookCard } from "@/contracts";
import { SceneCardShell, type BadgeTone } from "../SceneCardShell";
import { useCardEditor } from "../cardContext";
import { MediaImage, PhotoPickButton } from "../MediaImage";
import { SegmentedControl, rowsThatFit, useFitHeight } from "../DetailPopover";
import type { CardViewProps } from "../types";
import "./BookCardView.css";

type Book = BookCard["displayProps"];
type BookStatus = Book["status"];

const STATUS: ReadonlyArray<{ value: BookStatus; label: string; tone: BadgeTone }> = [
  { value: "want", label: "想读", tone: "neutral" },
  { value: "reading", label: "在读", tone: "accent" },
  { value: "paused", label: "暂停", tone: "caution" },
  { value: "finished", label: "读完", tone: "positive" },
];
const MAX_PAGES = 100_000;
const PAGE_STEP = 10;

// Display line boxes (px), mirrored in BookCardView.css.
const TITLE_BLOCK = 42;
const ROW_GAP = 6;
const AUTHOR_ROW = 16;
const PROGRESS_ROW = 27;
const STARS_ROW = 16;
const NOTE_LINE = 19;
const NOTES_LABEL = 18;

/** Page progress text; never invents a total that was not recorded. */
export function bookProgress({ currentPage, totalPages }: Pick<Book, "currentPage" | "totalPages">): { label: string; percent?: number } | null {
  if (currentPage !== undefined && totalPages) {
    const percent = Math.min(100, Math.max(0, Math.round((currentPage / totalPages) * 100)));
    return { label: `第 ${currentPage} / ${totalPages} 页 · ${percent}%`, percent };
  }
  if (currentPage !== undefined) return { label: `读到第 ${currentPage} 页` };
  if (totalPages) return { label: `共 ${totalPages} 页` };
  return null;
}

function GeneratedCover({ title, author }: { title: string; author?: string }) {
  return <div className="vivic-book-gen" aria-hidden data-book-generated-cover>
    <span className="vivic-book-gen-rule" />
    <span className="vivic-book-gen-title">{title}</span>
    {author && <span className="vivic-book-gen-author">{author}</span>}
  </div>;
}

function Stars({ rating, onRate }: { rating?: number; onRate?: (value: number | undefined) => void }) {
  const size = onRate ? 17 : 14;
  return <div className={`vivic-book-stars${onRate ? " nodrag nopan" : ""}`} role={onRate ? "radiogroup" : "img"}
    aria-label={rating ? `评分 ${rating} / 5` : "未评分"} data-book-rating={rating ?? 0}>
    {[1, 2, 3, 4, 5].map(value => {
      const filled = rating !== undefined && value <= rating;
      const icon = <Star size={size} strokeWidth={1.8} aria-hidden fill={filled ? "var(--vivic-accent)" : "none"}
        color={filled ? "var(--vivic-accent)" : "color-mix(in oklab, var(--foreground) 30%, transparent)"} />;
      return onRate
        ? <button key={value} type="button" role="radio" aria-checked={rating === value} className="vivic-book-star"
          aria-label={rating === value ? `${value} 星（再次点击清除评分）` : `评 ${value} 星`} onClick={() => onRate(rating === value ? undefined : value)}>{icon}</button>
        : <span key={value} className="inline-flex">{icon}</span>;
    })}
  </div>;
}

export function BookCardView({ card, height }: CardViewProps<"BookCard">) {
  const book = card.displayProps;
  const { title, author, status, rating, cover } = book;
  const notes = book.notes ?? [];
  const editor = useCardEditor(card);
  const fixed = height !== undefined;
  const [boxRef, boxHeight] = useFitHeight<HTMLDivElement>(fixed);
  const [notesRef, notesHeight] = useFitHeight<HTMLDivElement>(fixed && notes.length > 0);
  const tone = STATUS.find(item => item.value === status) ?? STATUS[1]!;
  const progress = bookProgress(book);

  // Display: optional rows give way, in order, when the card is shorter than its content.
  let room = boxHeight === null ? Infinity : boxHeight - TITLE_BLOCK;
  const take = (wanted: boolean, size: number) => {
    if (!wanted || room < size + ROW_GAP) return false;
    room -= size + ROW_GAP;
    return true;
  };
  const showAuthor = take(Boolean(author), AUTHOR_ROW);
  const showProgress = take(progress !== null, PROGRESS_ROW);
  const showStars = take(editor.editable || rating !== undefined, STARS_ROW);
  const noteLines = fixed ? rowsThatFit(notesHeight, NOTE_LINE, 2, NOTES_LABEL) : undefined;

  const coverArt = <GeneratedCover title={title} author={author} />;
  // Display: the first note in whatever height is left; user page: every note, full width under the cover.
  const notesBlock = notes.length > 0 && <div ref={fixed ? notesRef : undefined} className="vivic-book-notes" data-book-notes={notes.length}>
    {(!fixed || (noteLines ?? 0) > 0) && <>
      <span className="vivic-book-notes-label">笔记{notes.length > 1 ? ` · ${notes.length} 条` : ""}</span>
      {fixed
        ? <p className="vivic-book-note" style={{ WebkitLineClamp: noteLines }} title={notes[0]}>{notes[0]}</p>
        : notes.map((note, index) => <p key={index} className="vivic-book-note">{note}</p>)}
    </>}
  </div>;
  return <SceneCardShell card={card} height={height} badge={tone.label} badgeTone={tone.tone}>
    <div ref={boxRef} className="vivic-book" data-book-status={status}>
      <div className="vivic-book-cover" data-book-cover={cover ? "image" : "generated"}>
        {cover ? <MediaImage src={cover} alt={`《${title}》封面`} placeholder={coverArt} /> : coverArt}
      </div>
      <div className="vivic-book-info">
        <h3 className="vivic-book-title" title={fixed ? title : undefined}>{title}</h3>
        {showAuthor && <p className="vivic-book-author" data-book-author>{author}</p>}
        {showProgress && progress && <div className="vivic-book-progress" data-book-progress={progress.percent ?? "pages"}>
          {progress.percent !== undefined && <div className="vivic-scene-bar" role="progressbar" aria-label="阅读进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
            <i style={{ width: `${Math.max(2, progress.percent)}%` }} />
          </div>}
          <span className="vivic-book-progress-label">{progress.label}</span>
        </div>}
        {showStars && <Stars rating={rating} onRate={editor.editable ? value => editor.patch({ rating: value }) : undefined} />}
        {fixed && notesBlock}
      </div>
    </div>
    {!fixed && notesBlock}
    {editor.editable && <BookTools card={card} />}
  </SceneCardShell>;
}

function BookTools({ card }: { card: BookCard }) {
  const editor = useCardEditor(card);
  const { status, currentPage, totalPages, cover } = card.displayProps;
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const [totalDraft, setTotalDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const max = totalPages ?? MAX_PAGES;
  const save = (next: Partial<Book>) => {
    const ok = editor.patch(next);
    setError(ok ? null : "没有保存，请检查数值或控制权后重试。");
    return ok;
  };
  const commitPage = (raw: string) => {
    const text = raw.trim();
    if (!text) return currentPage === undefined || save({ currentPage: undefined });
    const value = Number(text);
    if (!Number.isFinite(value)) { setError("请输入页码数字。"); return false; }
    return save({ currentPage: Math.min(max, Math.max(0, Math.round(value))) });
  };
  const commitTotal = (raw: string) => {
    const value = Number(raw.trim());
    if (!raw.trim()) return;
    if (!Number.isFinite(value) || value < 1) { setError("总页数需大于 0。"); return; }
    const total = Math.min(MAX_PAGES, Math.round(value));
    if (save({ totalPages: total, ...(currentPage !== undefined && currentPage > total ? { currentPage: total } : {}) })) setTotalDraft("");
  };
  return <div className="vivic-book-tools nodrag nopan" data-book-tools>
    <SegmentedControl label="阅读状态" value={status} options={STATUS} onChange={value => save({ status: value })} />
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5">读到第
        <input className="vivic-scene-input w-16 text-center tabular-nums" inputMode="numeric" aria-label="当前页码"
          value={pageDraft ?? (currentPage === undefined ? "" : String(currentPage))} placeholder="—"
          onChange={event => setPageDraft(event.target.value)}
          onBlur={() => { if (pageDraft !== null && commitPage(pageDraft)) setPageDraft(null); }}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } if (event.key === "Escape") { setPageDraft(null); setError(null); } }} />页
      </label>
      {totalPages !== undefined
        ? <span className="vivic-scene-muted tabular-nums">共 {totalPages} 页</span>
        : <label className="flex items-center gap-1.5">共
          <input className="vivic-scene-input w-16 text-center tabular-nums" inputMode="numeric" aria-label="总页数" placeholder="总页数"
            value={totalDraft} onChange={event => setTotalDraft(event.target.value)}
            onBlur={() => commitTotal(totalDraft)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />页
        </label>}
      <button type="button" className="vivic-scene-action" disabled={currentPage !== undefined && currentPage >= max}
        onClick={() => save({ currentPage: Math.min(max, (currentPage ?? 0) + PAGE_STEP) })} data-book-step>
        <Plus size={13} aria-hidden />{PAGE_STEP} 页
      </button>
    </div>
    {editor.addPhotos && <div className="flex items-center gap-2">
      <PhotoPickButton multiple={false} label={cover ? "更换封面" : "添加封面"} onPick={async files => {
        try {
          const [image] = await editor.addPhotos!(files);
          if (image) save({ cover: image.src });
          else setError("封面没有保存，请换一张照片重试。");
        } catch (failure) {
          setError(failure instanceof Error && failure.name === "PhotoInputError" ? failure.message : "封面保存失败，请重试。");
        }
      }} />
    </div>}
    {error && <p role="alert" className="m-0 text-xs text-[var(--vivic-danger)]">{error}</p>}
  </div>;
}
