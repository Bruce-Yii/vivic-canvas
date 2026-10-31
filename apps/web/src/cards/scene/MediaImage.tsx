import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ImageOff, ImagePlus } from "lucide-react";
import { useMediaUrl } from "./media";
import { PHOTO_ACCEPT } from "./photos";

/**
 * <img> for a scene image reference. Missing local blobs, broken URLs and
 * absent images all fall back to the same quiet placeholder — never a broken
 * image icon and never a layout jump.
 */
export function MediaImage({ src, alt, className, style, placeholder, fit = "cover" }: {
  src?: string; alt?: string; className?: string; style?: CSSProperties; placeholder?: ReactNode; fit?: "cover" | "contain";
}) {
  const { url, status } = useMediaUrl(src);
  const [failed, setFailed] = useState<string | null>(null);
  const broken = !url || failed === url;
  if (broken) {
    return <div className={`vivic-scene-placeholder ${className ?? ""}`} style={style} data-scene-image-placeholder={status === "loading" ? "loading" : src ? "missing" : "empty"} role={alt ? "img" : undefined} aria-label={alt}>
      {status === "loading" ? null : placeholder ?? (src ? <span className="inline-flex items-center gap-1"><ImageOff size={14} aria-hidden />图片暂不可用</span> : null)}
    </div>;
  }
  return <img src={url} alt={alt ?? ""} className={`vivic-scene-img ${className ?? ""}`} style={{ objectFit: fit, ...style }}
    loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(url)} data-scene-image />;
}

/** Control-only file picker; the parent decides how many photos fit. */
export function PhotoPickButton({ onPick, disabled, label = "添加照片", multiple = true }: {
  onPick: (files: File[]) => void; disabled?: boolean; label?: string; multiple?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <input ref={input} type="file" accept={PHOTO_ACCEPT} multiple={multiple} className="sr-only" tabIndex={-1} aria-hidden
      onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) onPick(files); }} />
    <button type="button" className="vivic-scene-action nodrag" disabled={disabled} onClick={() => input.current?.click()} data-scene-add-photo>
      <ImagePlus size={14} aria-hidden />{label}
    </button>
  </>;
}
