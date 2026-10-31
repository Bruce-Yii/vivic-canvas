import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import type { GalleryCard, SceneImage } from "@/contracts";
import { SceneCardShell, SceneEmpty } from "../SceneCardShell";
import { useCardEditor } from "../cardContext";
import { MediaImage, PhotoPickButton } from "../MediaImage";
import { Lightbox } from "../Lightbox";
import type { CardViewProps } from "../types";
import "./GalleryCardView.css";

const MAX_IMAGES = 36;
const GAP = 6;
/** Shorter than this, a tile is not worth showing; the "+N" tile takes over. */
const MIN_TILE = 56;
/** Wall width from which the masonry uses three columns. */
const WIDE_WALL = 360;
const NOT_SAVED = "没有保存，请检查控制权后重试。";

type Images = GalleryCard["displayProps"]["images"];
interface Size { width: number; height: number }
interface PlacedTile { index: number; height: number }
interface Notice { tone: "info" | "error"; text: string }

/** Width / height of a tile; extreme panoramas are cropped rather than shown as slivers. */
const ratioOf = (image: SceneImage) =>
  image.width && image.height ? Math.min(2.4, Math.max(0.5, image.width / image.height)) : 4 / 3;

/**
 * Display wall: shortest-column masonry over the exact reserved box. Only the
 * leading photos that fit are placed; when some are hidden every column ends
 * flush with the bottom edge and the last tile of the rightmost column carries
 * the "+N" overlay.
 */
function planWall(images: Images, size: Size, wantColumns: number) {
  const count = Math.max(1, Math.min(wantColumns, images.length));
  const columnWidth = Math.max(1, (size.width - GAP * (count - 1)) / count);
  const columns: PlacedTile[][] = Array.from({ length: count }, () => []);
  const bottoms: number[] = new Array<number>(count).fill(0);
  const minTile = Math.min(MIN_TILE, size.height);
  let shown = 0;
  for (let index = 0; index < images.length; index += 1) {
    let column = 0;
    for (let c = 1; c < count; c += 1) if (bottoms[c]! < bottoms[column]! - 0.5) column = c;
    const top = columns[column]!.length ? bottoms[column]! + GAP : 0;
    const room = size.height - top;
    if (shown > 0 && room < minTile) break;
    const height = Math.max(1, Math.min(columnWidth / ratioOf(images[index]!), room));
    columns[column]!.push({ index, height });
    bottoms[column] = top + height;
    shown += 1;
  }
  const hidden = images.length - shown;
  columns.forEach((column, c) => {
    const extra = size.height - bottoms[c]!;
    const content = column.reduce((sum, tile) => sum + tile.height, 0);
    if (!column.length || extra <= 0 || (hidden === 0 && extra > content * 0.35)) return;
    const scale = (content + extra) / content;
    column.forEach(tile => { tile.height *= scale; });
  });
  const lastColumn = [...columns].reverse().find(column => column.length);
  return { columns, hidden, moreIndex: hidden > 0 ? lastColumn?.at(-1)?.index : undefined };
}

/** Box of the display wall; estimated from the card layout until measured. */
function useWallSize(node: HTMLElement | null, fallback: Size): Size {
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    if (!node) return;
    // clientWidth/Height ignore the canvas zoom transform.
    const read = () => {
      const width = node.clientWidth, height = node.clientHeight;
      if (width > 0 && height > 0) setSize(prev => prev && prev.width === width && prev.height === height ? prev : { width, height });
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return size ?? fallback;
}

function GalleryTile({ image, index, alt, style, more = 0, onOpen, onRemove }: {
  image: SceneImage; index: number; alt: string; style: CSSProperties; more?: number;
  onOpen: (index: number, trigger: HTMLElement) => void; onRemove?: (index: number) => void;
}) {
  return <div className="vivic-gallery-tile" style={style} data-gallery-tile={index}>
    <button type="button" className="vivic-gallery-open nodrag nopan" onClick={event => onOpen(index, event.currentTarget)}
      aria-label={more ? `查看照片：${alt}（另有 ${more} 张未显示）` : `查看照片：${alt}`}>
      <MediaImage src={image.src} alt={alt} />
      {image.caption && !more && <span className="vivic-gallery-caption" aria-hidden>{image.caption}</span>}
      {more > 0 && <span className="vivic-gallery-more" aria-hidden data-gallery-more={more}>+{more} 张</span>}
    </button>
    {onRemove && <button type="button" className="vivic-gallery-remove nodrag nopan" aria-label={`删除照片：${alt}`} onClick={() => onRemove(index)} data-gallery-remove={index}>
      <X size={14} aria-hidden />
    </button>}
  </div>;
}

export function GalleryCardView({ card, height }: CardViewProps<"GalleryCard">) {
  const { title, images } = card.displayProps;
  const editor = useCardEditor(card);
  const display = editor.mode === "display";
  const [wall, setWall] = useState<HTMLDivElement | null>(null);
  const size = useWallSize(display ? wall : null, {
    width: Math.max(1, card.layout.width - 46),
    height: Math.max(1, (height ?? 240) - 62),
  });
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const lastViewed = useRef(0);
  // Async photo storage must append to the newest list, not the one at click time.
  const latest = useRef(images);
  useEffect(() => { latest.current = images; });

  const altOf = (image: SceneImage, index: number) => image.alt ?? image.caption ?? `${title} · 第 ${index + 1} 张`;
  const view = (index: number | null) => { if (index !== null) lastViewed.current = index; setOpenIndex(index); };
  const open = (index: number, trigger: HTMLElement) => { opener.current = trigger; view(index); };
  const save = (next: Images) => {
    const ok = editor.patch({ images: next });
    setNotice(ok ? null : { tone: "error", text: NOT_SAVED });
    return ok;
  };
  const remove = (index: number) => { save(images.filter((_, i) => i !== index)); };
  const setCaption = (index: number, caption: string | undefined) => save(latest.current.map((image, i) => {
    if (i !== index) return image;
    const next = { ...image };
    if (caption) next.caption = caption; else delete next.caption;
    return next;
  }));
  const addPhotos = editor.addPhotos;
  const add = async (files: File[]) => {
    if (!addPhotos) return;
    const room = MAX_IMAGES - latest.current.length;
    if (room <= 0) { setNotice({ tone: "info", text: `照片墙最多 ${MAX_IMAGES} 张。` }); return; }
    const picked = files.slice(0, room);
    setBusy(true);
    setNotice(null);
    try {
      const added = await addPhotos(picked);
      if (added.length && !save([...latest.current, ...added].slice(0, MAX_IMAGES))) return;
      const skipped = files.length - added.length;
      if (files.length > room) setNotice({ tone: "info", text: `照片墙最多 ${MAX_IMAGES} 张，已添加 ${added.length} 张。` });
      else if (skipped > 0) setNotice({ tone: "error", text: `有 ${skipped} 张照片没能添加。` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error && error.message ? error.message : "照片保存失败。" });
    } finally {
      setBusy(false);
    }
  };
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    const tile = wall?.querySelector<HTMLElement>(`[data-gallery-tile="${lastViewed.current}"] .vivic-gallery-open`);
    const target = tile ?? (opener.current?.isConnected ? opener.current : null);
    target?.focus({ preventScroll: true });
  };

  const canAdd = editor.editable && Boolean(addPhotos);
  const picker = (label = "添加照片") => <PhotoPickButton onPick={files => { void add(files); }} multiple
    disabled={busy || images.length >= MAX_IMAGES} label={busy ? "正在添加…" : label} />;
  const status = notice && <p className="m-0 text-xs" role={notice.tone === "error" ? "alert" : "status"}
    style={{ color: notice.tone === "error" ? "var(--vivic-danger)" : "var(--vivic-muted-ink)" }} data-gallery-notice>{notice.text}</p>;

  let body;
  if (!images.length) {
    body = <div className="vivic-gallery-empty">
      <SceneEmpty action={canAdd ? picker() : undefined}>还没有照片</SceneEmpty>
      {status}
    </div>;
  } else if (display) {
    const plan = planWall(images, size, size.width >= WIDE_WALL ? 3 : 2);
    body = <div ref={setWall} className="vivic-gallery-wall" data-gallery-wall="display" data-gallery-hidden={plan.hidden || undefined}>
      {plan.columns.map((column, c) => <div key={c} className="vivic-gallery-column">
        {column.map(tile => <GalleryTile key={`${tile.index}:${images[tile.index]!.src}`} image={images[tile.index]!} index={tile.index}
          alt={altOf(images[tile.index]!, tile.index)} style={{ height: tile.height }} onOpen={open}
          more={tile.index === plan.moreIndex ? plan.hidden : 0} />)}
      </div>)}
    </div>;
  } else {
    body = <div ref={setWall} className="vivic-gallery-scroll vivic-scene-scroll nowheel" data-gallery-wall="control">
      <div className="vivic-gallery-masonry" data-count={Math.min(images.length, 3)}>
        {images.map((image, index) => <GalleryTile key={`${index}:${image.src}`} image={image} index={index} alt={altOf(image, index)}
          style={{ aspectRatio: ratioOf(image) }} onOpen={open} onRemove={editor.editable ? remove : undefined} />)}
      </div>
    </div>;
  }

  // The empty state carries its own picker and notice.
  const footer = !images.length ? undefined : canAdd ? <>
    {picker()}
    <span className="tabular-nums" data-gallery-count>{images.length} / {MAX_IMAGES}</span>
    {status && <div className="basis-full">{status}</div>}
  </> : status || undefined;

  return <SceneCardShell card={card} height={height} title={title} badge={images.length ? `${images.length} 张` : undefined} footer={footer}>
    {body}
    <Lightbox images={images} index={openIndex} onIndexChange={view} title={title} altOf={altOf}
      onCaptionChange={editor.editable ? setCaption : undefined} onCloseAutoFocus={restoreFocus} />
  </SceneCardShell>;
}
