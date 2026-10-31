import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Image as ImageIcon, ImageMinus, ImagePlus } from "lucide-react";
import type { PhotoCoverCard } from "@/contracts";
import { SceneCardShell } from "../SceneCardShell";
import { useCardEditor } from "../cardContext";
import { MediaImage, PhotoPickButton } from "../MediaImage";
import { formatFullDate, parseIsoDate } from "../dates";
import type { CardViewProps } from "../types";
import "./PhotoCoverCardView.css";

const CAPTION_MAX = 200;
const NOT_SAVED = "没有保存，请检查控制权后重试。";

type CoverProps = PhotoCoverCard["displayProps"];
type Editor = ReturnType<typeof useCardEditor<PhotoCoverCard>>;
interface Notice { tone: "info" | "error"; text: string }

const blurOnEnter = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); }
};

export function PhotoCoverCardView({ card, height }: CardViewProps<"PhotoCoverCard">) {
  const { title, date, caption, image } = card.displayProps;
  const editor = useCardEditor(card);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const tone = image ? "photo" : "plain";
  const compact = height !== undefined && height < 200;
  const addPhotos = editor.addPhotos;

  const save = (patch: Partial<CoverProps>) => {
    const ok = editor.patch(patch);
    setNotice(ok ? null : { tone: "error", text: NOT_SAVED });
    return ok;
  };
  const pickPhoto = async (files: File[]) => {
    if (!addPhotos) return;
    setBusy(true);
    setNotice(null);
    try {
      const [picked] = await addPhotos(files.slice(0, 1));
      if (!picked) { setNotice({ tone: "error", text: "这张照片没能添加。" }); return; }
      save({ image: {
        src: picked.src,
        ...(picked.width ? { width: picked.width } : {}),
        ...(picked.height ? { height: picked.height } : {}),
        alt: title.slice(0, 120),
      } });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error && error.message ? error.message : "照片保存失败。" });
    } finally {
      setBusy(false);
    }
  };
  const picker = (label: string) => <PhotoPickButton multiple={false} onPick={files => { void pickPhoto(files); }} disabled={busy}
    label={busy ? "正在添加…" : label} />;

  return <SceneCardShell card={card} height={height} bleed bare>
    <figure className="vivic-cover" data-tone={tone} data-compact={compact || undefined} data-cover-tone={tone}>
      {image
        ? <MediaImage src={image.src} alt={image.alt ?? title} className="vivic-cover-media" />
        : <div className="vivic-scene-placeholder vivic-cover-media" aria-hidden />}
      {image && <div className="vivic-cover-shade" aria-hidden />}
      <span className="vivic-cover-kicker"><ImageIcon size={12} strokeWidth={2.2} aria-hidden />纪念</span>
      <figcaption className="vivic-cover-copy">
        <h3 className="vivic-cover-title">{title}</h3>
        {date && <p className="vivic-cover-date"><time dateTime={date}>{formatFullDate(date, false)}</time></p>}
        {caption && <p className="vivic-cover-caption">{caption}</p>}
        {!image && editor.mode === "display" && <p className="vivic-cover-hint"><ImagePlus size={13} aria-hidden />在用户页添加照片</p>}
        {!image && editor.editable && addPhotos && <div className="vivic-cover-pick nodrag">{picker("添加照片")}</div>}
      </figcaption>
    </figure>
    {editor.editable && <CoverEditor props={card.displayProps} editor={editor} save={save}
      picker={image && addPhotos ? picker("更换照片") : null} notice={notice} />}
  </SceneCardShell>;
}

function CoverEditor({ props, editor, save, picker, notice }: {
  props: CoverProps; editor: Editor; save: (patch: Partial<CoverProps>) => boolean; picker: ReactNode; notice: Notice | null;
}) {
  const [caption, setCaption] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [dateError, setDateError] = useState(false);
  const commitCaption = () => {
    if (caption === null) return;
    setCaption(null);
    const next = caption.trim().slice(0, CAPTION_MAX) || undefined;
    if (next !== props.caption) save({ caption: next });
  };
  const commitDate = () => {
    if (date === null) return;
    setDate(null);
    if (date === (props.date ?? "")) { setDateError(false); return; }
    if (date && !parseIsoDate(date)) { setDateError(true); return; }
    setDateError(false);
    save({ date: date || undefined });
  };
  const captionValue = caption ?? props.caption ?? "";
  return <div className="vivic-cover-editor nodrag" data-cover-editor={editor.mode}>
    {props.image && <div className="flex flex-wrap items-center gap-2">
      {picker}
      <button type="button" className="vivic-scene-action" onClick={() => save({ image: undefined })} data-cover-remove-photo>
        <ImageMinus size={14} aria-hidden />移除照片
      </button>
    </div>}
    <label className="vivic-cover-field">
      <span>日期</span>
      <input className="vivic-scene-input" type="date" value={date ?? props.date ?? ""} aria-invalid={dateError || undefined}
        onChange={event => setDate(event.target.value)} onBlur={commitDate} onKeyDown={blurOnEnter} />
    </label>
    <label className="vivic-cover-field">
      <span className="flex justify-between gap-2">说明<span className="tabular-nums">{captionValue.length}/{CAPTION_MAX}</span></span>
      <textarea className="vivic-scene-input vivic-cover-textarea" rows={2} maxLength={CAPTION_MAX} value={captionValue}
        placeholder="写一句关于这一刻的话" onChange={event => setCaption(event.target.value)} onBlur={commitCaption} onKeyDown={blurOnEnter} />
    </label>
    {dateError && <p role="alert" className="m-0 text-xs text-[var(--vivic-danger)]">这个日期无效，请重新选择。</p>}
    {notice && <p className="m-0 text-xs" role={notice.tone === "error" ? "alert" : "status"}
      style={{ color: notice.tone === "error" ? "var(--vivic-danger)" : "var(--vivic-muted-ink)" }}>{notice.text}</p>}
  </div>;
}
