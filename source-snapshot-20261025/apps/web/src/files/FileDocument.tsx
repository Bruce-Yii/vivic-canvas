import { useEffect, useState } from "react";
import { PdfPreview } from "./PdfPreview";
import { readOriginalText } from "./parse";
import { DocumentText } from "./DocumentText";
import { isReadableFile } from "@vivic/contracts";

export const fileTypeLabel = (mediaType: string) => mediaType === "application/pdf" ? "PDF" : mediaType.includes("wordprocessingml") ? "Word 文档"
  : mediaType === "text/markdown" ? "Markdown" : mediaType === "text/csv" ? "CSV" : mediaType === "application/json" ? "JSON" : "文本";

export function FileDocument({ blob, mediaType }: { blob: Blob; mediaType: string }) {
  const [text, setText] = useState<string | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (mediaType !== "text/markdown") return;
    const controller = new AbortController(); setText(null); setError("");
    void readOriginalText(blob, mediaType, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.parseStatus === "error" || result.parseStatus === "unsupported") setError("暂时无法打开正文，可以下载原文件查看。");
      else setText(result.text);
    }).catch(() => { if (!controller.signal.aborted) setError("文件打开失败，可以下载原文件查看。"); });
    return () => controller.abort();
  }, [blob, mediaType]);
  if (!isReadableFile(mediaType)) return <p className="vivic-file-hint" role="status">仅支持 PDF 和 Markdown 阅读。此文件可下载后查看。</p>;
  if (mediaType === "application/pdf") return <PdfPreview blob={blob} />;
  if (error) return <p className="vivic-file-message" role="status">{error}</p>;
  if (text === null) return <p className="vivic-file-loading" role="status">正在打开文件…</p>;
  return <article className="vivic-document-page" aria-label="文件只读预览">
    {text.trim() ? <DocumentText key={mediaType} text={text} markdown={mediaType === "text/markdown"} /> : <p className="vivic-file-hint">这是一份空文档。</p>}
  </article>;
}
