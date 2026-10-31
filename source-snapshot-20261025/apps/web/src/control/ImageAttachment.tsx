import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ImageInputError, imageFilesFromTransfer, prepareImageAttachment } from "@/ai/attachments";
import type { Attachment, PreparedImageAttachment } from "@/ai/attachments";

/** Pieces a composer can place itself; the paste/drop group still wraps all of them. */
export interface ImageAttachmentParts {
  /** A draft, decode or error is present, so preview/status are worth showing. */
  active: boolean;
  trigger: ReactNode;
  remove: ReactNode;
  preview: ReactNode;
  status: ReactNode;
}

export interface ImageAttachmentProps {
  disabled?: boolean;
  /** Current canvas id + controller ownership epoch. Change either to discard the draft. */
  ownerKey: string;
  /** Change on explicit send completion/cancellation/clear. Never store attachment in canvas state. */
  resetKey?: string | number;
  onChange: (attachment: Attachment | null) => void;
  onProcessingChange?: (processing: boolean) => void;
  /** Must reflect verified capability; defaults to unavailable. Selection is still a local draft. */
  visionAvailable?: boolean;
  menuTrigger?: boolean;
  /** Composer layout: wrap the whole input so pasting into it attaches; omit for the standalone panel. */
  children?: (parts: ImageAttachmentParts) => ReactNode;
}

/** Control-only attachment picker. Parent owns the explicit Send action; this component never sends. */
export function ImageAttachment({ disabled = false, ownerKey, resetKey, onChange, onProcessingChange, visionAvailable = false, menuTrigger = false, children }: ImageAttachmentProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const current = useRef<PreparedImageAttachment | null>(null);
  const pending = useRef<AbortController | null>(null);
  const version = useRef(0);
  const callbacks = useRef({ onChange, onProcessingChange }); callbacks.current = { onChange, onProcessingChange };
  const [preview, setPreview] = useState<PreparedImageAttachment | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const release = () => {
    version.current++;
    pending.current?.abort(); pending.current = null;
    current.current?.dispose(); current.current = null;
    if (input.current) input.current.value = "";
    callbacks.current.onChange(null);
    callbacks.current.onProcessingChange?.(false);
  };
  const clear = () => { release(); setPreview(null); setProcessing(false); setError(null); };

  // Layout cleanup invalidates pending work before a new owner can act; also handles unmount.
  useLayoutEffect(() => {
    release(); setPreview(null); setProcessing(false); setError(null);
    return release;
    // Callback refs avoid resetting the draft when a parent's inline callback changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey, resetKey, disabled]);

  const select = async (files: File[]) => {
    if (disabled) return;
    clear();
    const token = version.current, controller = new AbortController();
    pending.current = controller; setProcessing(true); callbacks.current.onProcessingChange?.(true);
    try {
      const result = await prepareImageAttachment(files, { signal: controller.signal });
      if (token !== version.current || controller.signal.aborted) { result.dispose(); return; }
      current.current = result; setPreview(result); callbacks.current.onChange(result.attachment);
    } catch (cause) {
      if (token === version.current && !controller.signal.aborted) {
        setError(cause instanceof ImageInputError ? cause.message : "图片处理失败，请重新选择图片。");
      }
    } finally {
      if (token === version.current) {
        pending.current = null; setProcessing(false); callbacks.current.onProcessingChange?.(false);
      }
    }
  };

  const note = processing ? "正在本地处理图片…" : preview ? "图片已在本地就绪，点击发送后才会交给模型。" : "可在此粘贴、拖入或选择 PNG / JPEG / WebP；最多 1 张，4 MiB。";
  const parts: ImageAttachmentParts = {
    active: Boolean(preview || processing || error),
    trigger: <>
      <Input ref={input} id={id} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only w-px! h-px! p-0!" disabled={disabled}
        aria-label="选择图片附件" onChange={event => {
          const files = Array.from(event.target.files ?? []); event.target.value = "";
          if (files.length) void select(files);
        }} />
      {children ? <button type="button" className={menuTrigger ? "vivic-menu-action" : "vivic-composer-icon"} disabled={disabled} onClick={() => input.current?.click()}
        aria-label="添加图片" title="添加图片（也可粘贴或拖入）"><HarkIcon name={menuTrigger ? "photo" : "add"} size={18} />{menuTrigger && "添加图片"}</button>
        : <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => input.current?.click()}>
          <HarkIcon name="photo" className="h-4 w-4" aria-hidden="true" />添加图片
        </Button>}
    </>,
    remove: (preview || processing) ? <Button type="button" variant="ghost" size="sm" onClick={clear} aria-label="取消图片附件" className={children ? "vivic-chip" : undefined}>
      <HarkIcon name="close" className="h-4 w-4" aria-hidden="true" />{processing ? "取消处理" : "移除"}
    </Button> : null,
    preview: preview ? <img src={preview.previewUrl} alt="待发送图片预览" className={children ? "vivic-attachment-thumb" : "mt-2 max-h-40 max-w-full rounded-md object-contain"} /> : null,
    status: <>
      <p id={`${id}-note`} className={children ? "vivic-composer-note" : "mt-2 text-xs text-neutral-500"} role="status" aria-live="polite">
        {note}{!visionAvailable && " 当前没有可用的视觉模型，无法分析图片。"}
      </p>
      {error && <p className={children ? "vivic-composer-note vivic-composer-note-error" : "mt-2 text-xs text-red-700"} role="alert">{error}</p>}
    </>,
  };

  return <div className={children ? "vivic-attachment-group" : "mt-3 rounded-lg border border-neutral-200 p-3"} role="group" aria-label="图片附件"
    aria-describedby={`${id}-note`} aria-disabled={disabled} aria-busy={processing} tabIndex={children || disabled ? -1 : 0}
    onPaste={event => {
      if (disabled) return;
      const files = imageFilesFromTransfer(event.clipboardData);
      if (files.length) { event.preventDefault(); void select(files); }
    }}
    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? "none" : "copy"; }}
    onDrop={event => {
      event.preventDefault();
      if (disabled) return;
      const files = imageFilesFromTransfer(event.dataTransfer);
      if (!files.length) { clear(); setError("请拖入本地图片文件，不接受链接或网页内容。"); return; }
      void select(files);
    }}>
    {children ? children(parts) : <>
      <div className="flex items-center gap-2">{parts.trigger}{parts.remove}</div>
      {parts.preview}
      {parts.status}
    </>}
  </div>;
}
