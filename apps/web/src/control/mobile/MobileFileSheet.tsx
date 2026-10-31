import { useEffect, useRef, useState } from "react";
import type { MobileClient } from "@vivic/mobile-console-prototype/client";
import type { CardSnapshot } from "@vivic/mobile-console-prototype/protocol";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { Button } from "@/components/ui/button";
import { fileSizeLabel } from "@/files/assetStore";
import { FileDocument, fileTypeLabel } from "@/files/FileDocument";
import { nativeFiles, saveNativeFile } from "./saveNativeFile";
import "@/files/files.css";

type Original = Awaited<ReturnType<NonNullable<MobileClient["readFile"]>>>;
/** User opening the file authorizes its scoped memory-only read, not a download. */
export function MobileFileSheet({ card, client, online, onClose }: { card: CardSnapshot; client: MobileClient; online: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), abort = useRef<AbortController | null>(null);
  const [file, setFile] = useState<Original | null>(null), [blob, setBlob] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [progress, setProgress] = useState(0), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  useEffect(() => { const focused = document.activeElement as HTMLElement | null; dialog.current?.showModal?.(); return () => { abort.current?.abort(); focused?.focus(); }; }, []);
  useEffect(() => {
    const controller = new AbortController(); abort.current = controller;
    if (!online || !client.readFile || !card.file) return () => controller.abort();
    setBusy(true); setError(""); setFile(null); setBlob(null);
    void client.readFile(card.id, (received, total) => setProgress(total ? Math.round(received / total * 100) : 100), controller.signal)
      .then(original => { if (!controller.signal.aborted) { setFile(original); setBlob(new Blob([original.bytes], { type: original.mediaType })); } })
      .catch(value => { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : "文件打开失败"); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [card.id, card.file?.sha256, client, online, retry]);
  const download = async () => {
    if (saving || !online || !file || !card.file) return;
    setSaving(true); setError(""); const controller = new AbortController(); abort.current = controller;
    try {
      if (nativeFiles()?.saveFile) await saveNativeFile(file.bytes, file.name, file.mediaType, card.file.sha256, controller.signal);
      else {
        const url = URL.createObjectURL(new Blob([file.bytes], { type: "application/octet-stream" })), link = document.createElement("a");
        link.href = url; link.download = file.name; link.rel = "noopener"; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (value) { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : "下载失败"); }
    finally { setSaving(false); }
  };
  useEffect(() => { if (!online) abort.current?.abort(); }, [online]);
  return <dialog ref={dialog} className="mobile-settings-sheet mobile-file-sheet" aria-labelledby="mobile-file-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className="mobile-sheet-handle" /><header className="mobile-sheet-heading"><h2 id="mobile-file-title">{card.file?.name ?? card.title}</h2><Button variant="ghost" size="icon" className="mobile-icon-button" aria-label="关闭文件" onClick={onClose}><HarkIcon name="close" size={20} /></Button></header>
    <div className="mobile-file-reader-toolbar"><span>{fileTypeLabel(card.file?.mediaType ?? "")} · {fileSizeLabel(card.file?.sizeBytes ?? 0)}</span><Button variant="ghost" size="icon" aria-label="下载原文件" disabled={!online || !file || saving} onClick={() => void download()}><HarkIcon name="download" size={18} /></Button></div>
    <div className="mobile-file-reader-content">{blob ? <FileDocument blob={blob} mediaType={file!.mediaType} /> : <p className="vivic-file-loading" role="status">{busy ? "正在打开 " + progress + "%" : online ? "文件暂不可用" : "电脑连接已断开"}</p>}</div>
    {error && <div className="mobile-file-reader-error"><p role="alert" className="mobile-hint">{error}</p><Button variant="ghost" disabled={!online || busy} onClick={() => setRetry(v => v + 1)}>重新打开</Button></div>}
  </dialog>;
}
