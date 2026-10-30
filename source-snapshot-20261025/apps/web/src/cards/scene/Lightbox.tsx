import { useState, type CSSProperties, type KeyboardEvent, type SyntheticEvent } from "react";
import { Dialog } from "radix-ui";
import { motion, useReducedMotion } from "motion/react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { SceneImage } from "@/contracts";
import { useDisplayPreferences } from "@/state/canvasStore";
import { MediaImage } from "./MediaImage";

const CAPTION_MAX = 160;

interface LightboxProps {
  images: SceneImage[];
  /** Index being viewed; null keeps the viewer closed. */
  index: number | null;
  onIndexChange: (index: number | null) => void;
  /** Dialog title (the card title). */
  title: string;
  altOf: (image: SceneImage, index: number) => string;
  /** User page only: save a caption (undefined clears it). */
  onCaptionChange?: (index: number, caption: string | undefined) => boolean;
  onCloseAutoFocus?: (event: Event) => void;
}

// Portal content still bubbles React events to the canvas node that owns it;
// keep clicks and arrow keys from selecting or nudging that node.
const stop = (event: SyntheticEvent) => event.stopPropagation();
const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
const frameStyle = (image: SceneImage): CSSProperties => {
  if (!image.width || !image.height) return { width: "min(100cqw, 92vw)", height: "min(100cqh, 86vh)" };
  const ratio = image.width / image.height;
  return { width: `min(100cqw, 92vw, calc(100cqh * ${ratio}), calc(86vh * ${ratio}))`, aspectRatio: `${image.width} / ${image.height}` };
};

/**
 * Full-screen photo viewer shared by the photo cards. Browsing is allowed on
 * both surfaces; the caption field only exists when the owner passes an
 * editor. The surface is intrinsically dark, so it always uses dark tokens.
 */
export function Lightbox({ images, index, onIndexChange, title, altOf, onCaptionChange, onCloseAutoFocus }: LightboxProps) {
  const systemReduced = useReducedMotion();
  const preferences = useDisplayPreferences();
  const reduced = Boolean(systemReduced || preferences.reducedMotion);
  const count = images.length;
  const open = index !== null && count > 0;
  const current = open ? Math.min(Math.max(0, index), count - 1) : 0;
  const image = open ? images[current] : undefined;
  const viewKey = image ? `${current}:${image.src}` : "";
  const [draft, setDraft] = useState<{ key: string; text: string } | null>(null);
  const captionDraft = draft && draft.key === viewKey ? draft.text : null;

  const commit = () => {
    if (!draft) return;
    setDraft(null);
    if (draft.key !== viewKey || !image || !onCaptionChange) return;
    const caption = draft.text.trim().slice(0, CAPTION_MAX) || undefined;
    if (caption !== image.caption) onCaptionChange(current, caption);
  };
  const go = (delta: number) => {
    if (count < 2) return;
    commit();
    onIndexChange((current + delta + count) % count);
  };
  const close = () => { commit(); onIndexChange(null); };
  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (isTyping(event.target)) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); go(-1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); go(1); }
  };
  const navButton = "absolute top-1/2 z-10 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/24 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

  return <Dialog.Root open={open} onOpenChange={next => { if (!next) close(); }}>
    <Dialog.Portal>
      <div className="dark" onClick={stop} onDoubleClick={stop} onPointerDown={stop} onMouseDown={stop} onContextMenu={stop} onWheel={stop}>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/85" data-scene-lightbox-overlay />
        <Dialog.Content aria-describedby={undefined} data-scene-lightbox data-scene-lightbox-index={current}
          className="nodrag nopan nowheel fixed inset-0 z-[91] flex flex-col text-white outline-none"
          onKeyDown={onKeyDown}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={event => {
            // First Esc inside the caption field discards the unsaved edit.
            if (captionDraft !== null && isTyping(event.target)) { event.preventDefault(); setDraft(null); }
          }}
          onClick={event => {
            const target = event.target as HTMLElement;
            if (target === event.currentTarget || target.hasAttribute("data-lightbox-backdrop")) close();
          }}>
          <header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4" data-lightbox-backdrop>
            <Dialog.Title className="m-0 min-w-0 truncate text-sm font-medium text-white/80">{title}</Dialog.Title>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-sm tabular-nums text-white/80" aria-live="polite" data-scene-lightbox-counter>{current + 1} / {count}</span>
              <Dialog.Close asChild>
                <button type="button" aria-label="关闭照片查看" className="grid size-10 place-items-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/24 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
                  <X size={20} aria-hidden />
                </button>
              </Dialog.Close>
            </div>
          </header>
          <div className="relative min-h-0 flex-1" data-lightbox-backdrop>
            <div className="absolute inset-y-0 inset-x-2 grid place-items-center sm:inset-x-16" style={{ containerType: "size" }} data-lightbox-backdrop>
              {image && <motion.div key={viewKey} className="overflow-hidden rounded-[var(--radius-md)]" style={frameStyle(image)}
                initial={{ opacity: 0, scale: reduced ? 1 : 0.985 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: reduced ? 0 : 0.2, ease: "easeOut" }}>
                <MediaImage src={image.src} alt={altOf(image, current)} fit="contain" style={{ background: "transparent" }} />
              </motion.div>}
            </div>
            {count > 1 && <>
              <button type="button" className={`${navButton} left-2 sm:left-4`} aria-label="上一张" onClick={() => go(-1)} data-scene-lightbox-prev><ChevronLeft size={24} aria-hidden /></button>
              <button type="button" className={`${navButton} right-2 sm:right-4`} aria-label="下一张" onClick={() => go(1)} data-scene-lightbox-next><ChevronRight size={24} aria-hidden /></button>
            </>}
          </div>
          <footer className="flex min-h-[4.75rem] shrink-0 flex-col items-center gap-2 px-6 pb-5 pt-3 text-center" data-lightbox-backdrop>
            {image && onCaptionChange
              ? <input className="h-9 w-[min(480px,90vw)] rounded-[var(--radius-md)] border border-white/20 bg-white/10 px-3 text-sm text-white placeholder:text-white/45 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
                value={captionDraft ?? image.caption ?? ""} maxLength={CAPTION_MAX} placeholder="为这张照片写一句说明" aria-label="照片说明"
                onChange={event => setDraft({ key: viewKey, text: event.target.value })}
                onBlur={commit}
                onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur(); }}
                data-scene-lightbox-caption-input />
              : image?.caption && <p className="m-0 line-clamp-3 max-w-[min(720px,92vw)] text-sm leading-relaxed text-white/85 [overflow-wrap:anywhere]" data-scene-lightbox-caption>{image.caption}</p>}
          </footer>
        </Dialog.Content>
      </div>
    </Dialog.Portal>
  </Dialog.Root>;
}
