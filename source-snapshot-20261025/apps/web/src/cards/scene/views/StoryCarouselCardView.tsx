import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronLeft, ChevronRight, GalleryHorizontalEnd, ImageMinus, Plus, Trash2 } from "lucide-react";
import type { StoryCarouselCard } from "@/contracts";
import { useDisplayPreferences } from "@/state/canvasStore";
import { SceneCardShell } from "../SceneCardShell";
import { useCardEditor } from "../cardContext";
import { MediaImage, PhotoPickButton } from "../MediaImage";
import type { CardViewProps } from "../types";
import "./StoryCarouselCardView.css";

const AUTOPLAY_MS = 9000;
const MAX_SLIDES = 15;
const HEADING_MAX = 60;
const TEXT_MAX = 300;
const NOT_SAVED = "没有保存，请检查控制权后重试。";

type Slide = StoryCarouselCard["displayProps"]["slides"][number];
type Field = "heading" | "text";
interface Notice { tone: "info" | "error"; text: string }

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
/** Autoplay never advances a page nobody can see. */
const usePageHidden = () => useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "hidden", () => false);
const keyboardFocus = (target: EventTarget) => {
  try { return target instanceof Element && target.matches(":focus-visible"); } catch { return false; }
};

export function StoryCarouselCardView({ card, height }: CardViewProps<"StoryCarouselCard">) {
  const { title, slides } = card.displayProps;
  const editor = useCardEditor(card);
  const display = editor.mode === "display";
  const systemReduced = useReducedMotion();
  const preferences = useDisplayPreferences();
  const reduced = Boolean(systemReduced || preferences.reducedMotion);
  const pageHidden = usePageHidden();
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const count = slides.length;
  const current = Math.max(0, Math.min(index, count - 1));
  const slide = slides[current];
  const autoplay = display && count > 1 && !reduced && !hovered && !keyboard && !pageHidden;

  useEffect(() => {
    if (!autoplay) return;
    // Re-armed on every page change, so manual browsing gets a full 9 s too.
    const timer = setTimeout(() => setIndex((current + 1) % count), AUTOPLAY_MS);
    return () => clearTimeout(timer);
  }, [autoplay, current, count]);

  if (!slide) return <SceneCardShell card={card} height={height} title={title} />;

  const go = (delta: number) => setIndex((current + delta + count) % count);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    // Keep the canvas from nudging the selected card as well.
    event.stopPropagation();
    go(event.key === "ArrowLeft" ? -1 : 1);
  };
  const onPointer = (inside: boolean) => (event: PointerEvent) => { if (event.pointerType === "mouse") setHovered(inside); };
  const tone = slide.image ? "photo" : "plain";
  const compact = height !== undefined && height < 220;

  return <SceneCardShell card={card} height={height} bleed bare>
    <div className="vivic-story" data-mode={editor.mode} data-tone={tone} data-single={count < 2 || undefined} data-compact={compact || undefined}
      role="region" aria-roledescription="carousel" aria-label={`照片故事：${title}`} data-story-index={current}
      onKeyDown={onKeyDown} onPointerEnter={onPointer(true)} onPointerLeave={onPointer(false)}
      onFocus={event => setKeyboard(keyboardFocus(event.target))}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setKeyboard(false); }}>
      <AnimatePresence initial={false}>
        <motion.div key={slide.id} className="vivic-story-slide" data-tone={tone}
          role="group" aria-roledescription="slide" aria-label={`第 ${current + 1} 页，共 ${count} 页`}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.7, ease: "easeInOut" }}>
          {slide.image
            ? <MediaImage src={slide.image} alt={slide.heading ?? `${title} · 第 ${current + 1} 页`} className="vivic-story-media" />
            : <div className="vivic-scene-placeholder vivic-story-media" aria-hidden />}
          {slide.image && <div className="vivic-story-shade" aria-hidden />}
          <div className="vivic-story-copy">
            {slide.heading && <h3 className="vivic-story-heading">{slide.heading}</h3>}
            <p className="vivic-story-text">{slide.text}</p>
          </div>
        </motion.div>
      </AnimatePresence>
      <span className="vivic-story-kicker"><GalleryHorizontalEnd size={12} strokeWidth={2.2} aria-hidden /><span className="truncate">照片故事 · {title}</span></span>
      {count > 1 && <>
        <button type="button" className="vivic-story-nav nodrag nopan" data-side="prev" aria-label="上一页" onClick={() => go(-1)}><ChevronLeft size={20} aria-hidden /></button>
        <button type="button" className="vivic-story-nav nodrag nopan" data-side="next" aria-label="下一页" onClick={() => go(1)}><ChevronRight size={20} aria-hidden /></button>
        <div className="vivic-story-bar">
          <div className="vivic-story-dots">
            {slides.map((item, i) => <button key={item.id} type="button" className="vivic-story-dot nodrag nopan" aria-label={`第 ${i + 1} 页`}
              aria-current={i === current || undefined} onClick={() => setIndex(i)}><i /></button>)}
          </div>
          <span className="vivic-story-count" aria-live={autoplay ? "off" : "polite"} data-story-counter>{current + 1} / {count}</span>
        </div>
      </>}
    </div>
    {editor.editable && <StoryEditor slides={slides} slide={slide} current={current} editor={editor} onJump={setIndex} />}
  </SceneCardShell>;
}

function StoryEditor({ slides, slide, current, editor, onJump }: {
  slides: Slide[]; slide: Slide; current: number; editor: ReturnType<typeof useCardEditor<StoryCarouselCard>>; onJump: (index: number) => void;
}) {
  const [draft, setDraft] = useState<{ id: string; field: Field; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const latest = useRef(slides);
  useEffect(() => { latest.current = slides; });

  const save = (next: Slide[]) => {
    const ok = editor.patch({ slides: next });
    setNotice(ok ? null : { tone: "error", text: NOT_SAVED });
    return ok;
  };
  const updateSlide = (id: string, change: (slide: Slide) => Slide) => save(latest.current.map(item => item.id === id ? change(item) : item));
  const valueOf = (field: Field) => draft && draft.id === slide.id && draft.field === field ? draft.value : slide[field] ?? "";
  const commit = () => {
    if (!draft) return;
    setDraft(null);
    const target = latest.current.find(item => item.id === draft.id);
    if (!target) return;
    const value = draft.value.trim();
    if (draft.field === "text") {
      if (!value) { setNotice({ tone: "error", text: "正文不能为空，已保留原来的内容。" }); return; }
      if (value !== target.text) updateSlide(target.id, item => ({ ...item, text: value.slice(0, TEXT_MAX) }));
    } else if (value !== (target.heading ?? "")) {
      updateSlide(target.id, item => {
        const next = { ...item };
        if (value) next.heading = value.slice(0, HEADING_MAX); else delete next.heading;
        return next;
      });
    }
  };
  const field = (name: Field) => ({
    value: valueOf(name),
    onChange: (event: { target: { value: string } }) => setDraft({ id: slide.id, field: name, value: event.target.value }),
    onBlur: commit,
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); }
    },
  });
  const addPhotos = editor.addPhotos;
  const setPhoto = async (files: File[]) => {
    if (!addPhotos) return;
    const id = slide.id;
    setBusy(true);
    setNotice(null);
    try {
      const [image] = await addPhotos(files.slice(0, 1));
      if (image) updateSlide(id, item => ({ ...item, image: image.src }));
      else setNotice({ tone: "error", text: "这张照片没能添加。" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error && error.message ? error.message : "照片保存失败。" });
    } finally {
      setBusy(false);
    }
  };
  const removePhoto = () => updateSlide(slide.id, item => {
    const next = { ...item };
    delete next.image;
    return next;
  });
  const removeSlide = () => { if (slides.length > 1) save(slides.filter(item => item.id !== slide.id)); };
  const addSlide = () => {
    if (slides.length >= MAX_SLIDES) return;
    const used = new Set(slides.map(item => item.id));
    let n = slides.length + 1;
    while (used.has(`slide-${n}`)) n += 1;
    if (save([...slides, { id: `slide-${n}`, text: "新的一页" }])) onJump(slides.length);
  };

  return <div className="vivic-story-editor nodrag" data-story-editor>
    <div className="flex items-center justify-between gap-2">
      <span className="vivic-scene-muted text-xs tabular-nums">第 {current + 1} 页 · 共 {slides.length} 页</span>
      <button type="button" className="vivic-scene-action" onClick={addSlide} disabled={slides.length >= MAX_SLIDES} data-story-add-slide>
        <Plus size={14} aria-hidden />新增一页
      </button>
    </div>
    <input className="vivic-scene-input" maxLength={HEADING_MAX} placeholder="这一页的标题（可选）" aria-label="这一页的标题" {...field("heading")} />
    <textarea className="vivic-scene-input vivic-story-textarea" rows={3} maxLength={TEXT_MAX} placeholder="这一页想说的话" aria-label="这一页的正文" {...field("text")} />
    <div className="flex flex-wrap items-center gap-2">
      {addPhotos && <PhotoPickButton multiple={false} onPick={files => { void setPhoto(files); }} disabled={busy}
        label={busy ? "正在添加…" : slide.image ? "更换照片" : "为这一页添加照片"} />}
      {slide.image && <button type="button" className="vivic-scene-action" onClick={removePhoto}><ImageMinus size={14} aria-hidden />移除照片</button>}
      {slides.length > 1 && <button type="button" className="vivic-scene-action ml-auto" onClick={removeSlide} data-story-remove-slide>
        <Trash2 size={14} aria-hidden />删除这一页
      </button>}
    </div>
    {notice && <p className="m-0 text-xs" role={notice.tone === "error" ? "alert" : "status"}
      style={{ color: notice.tone === "error" ? "var(--vivic-danger)" : "var(--vivic-muted-ink)" }}>{notice.text}</p>}
  </div>;
}
