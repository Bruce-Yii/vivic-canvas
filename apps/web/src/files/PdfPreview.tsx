import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { Button } from "@/components/ui/button";

export function PdfPreview({ blob }: { blob: Blob }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pageViewport = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null), [page, setPage] = useState(1), [error, setError] = useState("");
  const [fitSize, setFitSize] = useState({ width: 0, height: 0 });
  const [renderedPage, setRenderedPage] = useState(0);
  useEffect(() => {
    let active = true;
    let failed = false, destroyed = false;
    let task: PDFDocumentLoadingTask | undefined;
    const destroy = () => {
      if (!task || destroyed) return;
      destroyed = true;
      void task.destroy().catch(() => {});
    };
    const fail = (message: string) => {
      if (!active || failed) return;
      failed = true;
      clearTimeout(timer);
      setError(message);
      destroy();
    };
    // The deadline also covers module/byte loading; destroy need not settle to end the UI wait.
    const timer = setTimeout(() => fail("PDF 打开超时，仍可下载原文件"), 20_000);
    setDocument(null); setPage(1); setError(""); setRenderedPage(0);
    void (async () => {
      try {
        const [{ getDocument, GlobalWorkerOptions }, { default: workerUrl }, bytes] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"), blob.arrayBuffer()]);
        if (!active || failed) return;
        GlobalWorkerOptions.workerSrc = workerUrl;
        task = getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, useWasm: false, maxImageSize: 16_000_000, verbosity: 0 });
        task.onPassword = () => fail("加密 PDF 请下载后在本机打开");
        const pdf = await task.promise; clearTimeout(timer);
        if (active && !failed) setDocument(pdf);
      } catch { fail("PDF 预览不可用，仍可下载原文件"); }
    })();
    return () => { active = false; clearTimeout(timer); destroy(); };
  }, [blob]);
  useEffect(() => {
    const node = pageViewport.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setFitSize(current => current.width === rect.width && current.height === rect.height
        ? current : { width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [document, error]);
  useEffect(() => {
    if (!document || !canvas.current || fitSize.width < 1 || fitSize.height < 1) return;
    let active = true;
    let cancel: (() => void) | undefined;
    const node = canvas.current;
    void document.getPage(page).then(pdfPage => {
      if (!active) return;
      const initial = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(1, fitSize.width / initial.width, fitSize.height / initial.height);
      const viewport = pdfPage.getViewport({ scale });
      node.width = Math.ceil(viewport.width); node.height = Math.ceil(viewport.height);
      const task = pdfPage.render({ canvas: node, viewport }); cancel = () => task.cancel();
      return task.promise.then(() => { if (active) setRenderedPage(page); });
    }).catch(() => { if (active) setError("这一页暂时无法预览"); });
    return () => { active = false; cancel?.(); };
  }, [document, page, fitSize]);
  const changePage = (delta: number) => {
    setError("");
    setPage(value => value + delta);
    const scroll = pageViewport.current?.closest<HTMLElement>(".vivic-file-reading-scroll,.mobile-file-reader-content");
    if (scroll) scroll.scrollTop = 0;
  };
  return <div className="vivic-file-pdf">
    {document && <div className="vivic-file-pages"><Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => changePage(-1)}>上一页</Button><span>{page} / {document.numPages}</span><Button variant="ghost" size="sm" disabled={page >= document.numPages} onClick={() => changePage(1)}>下一页</Button></div>}
    {!document && !error && <p className="vivic-file-loading" role="status">正在打开 PDF…</p>}
    {error ? <p role="status">{error}</p> : <div className="vivic-file-pdf-page-viewport" ref={pageViewport}>
      <canvas ref={canvas} aria-label={`PDF 第 ${page} 页`} data-pdf-ready={renderedPage === page || undefined} />
    </div>}
  </div>;
}
