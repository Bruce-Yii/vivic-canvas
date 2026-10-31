import { useEffect, useRef, useState } from "react";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { Button } from "@/components/ui/button";
import type { ControlHost } from "@/sync/controlHost";
import { FILE_ACCEPT } from "./parse";
import { uploadFileCards } from "./upload";
import "./files.css";

export function FileUploadButton({ host, disabled = false, compact = false, onPick, onStatus }: { host: ControlHost; disabled?: boolean; compact?: boolean; onPick?(): void; onStatus?(message: string): void }) {
  const input = useRef<HTMLInputElement>(null), busyRef = useRef(false), abort = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  useEffect(() => () => abort.current?.abort(), []);
  return <div className="vivic-file-upload">
    <input ref={input} type="file" accept={FILE_ACCEPT} multiple hidden aria-label="选择文件" onChange={async event => {
      const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = "";
      if (!files.length || disabled || busyRef.current) return;
      onPick?.(); onStatus?.("正在读取文件…");
      busyRef.current = true; setBusy(true); setMessage(""); abort.current = new AbortController();
      try { const cards = await uploadFileCards(host, files, abort.current.signal); const value = cards.length ? `已保存 ${cards.length} 张文件卡片到 Space${cards.length < files.length ? "，重复文件已跳过" : ""}` : "文件已在此 Space 中，未重复新增卡片"; setMessage(value); onStatus?.(value); }
      catch (error) { const value = error instanceof Error ? error.message : "文件上传失败，请重试"; setMessage(value); onStatus?.(value); }
      finally { busyRef.current = false; setBusy(false); abort.current = null; }
    }} />
    <Button variant="ghost" size="sm" disabled={disabled || busy} onClick={() => input.current?.click()} data-vivic-upload-files><HarkIcon name="file" size={16} />{busy ? "正在读取…" : "上传文件"}</Button>
    <span className="vivic-file-limit">PDF / MD · 最多 5 个 · 合计 10 MB</span>
    {!compact && message && <p role="status" className="vivic-file-message">{message}</p>}
  </div>;
}
