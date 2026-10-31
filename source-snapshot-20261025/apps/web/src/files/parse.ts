import { FILE_LIMITS, type FileCard } from "@vivic/contracts";
import type { FileAsset } from "./assetStore";

export const FILE_ACCEPT = ".md,.pdf";
const types: Record<string, FileCard["displayProps"]["mediaType"]> = {
  md: "text/markdown", pdf: "application/pdf",
};
export function validateFileBatch(files: File[]): void {
  if (!files.length || files.length > FILE_LIMITS.count || files.reduce((sum, file) => sum + file.size, 0) > FILE_LIMITS.batchBytes) throw new Error("每次最多 5 个文件，合计不超过 10 MB");
  for (const file of files) {
    if (!types[file.name.split(".").pop()?.toLowerCase() ?? ""]) throw new Error("只支持 PDF 和 Markdown（.md）文件");
    if (!file.name.trim() || file.name.length > 240 || /[\p{Cc}]/u.test(file.name)) throw new Error("文件名过长或包含不可见字符，请重命名后上传");
  }
}
export interface ParsedText { text: string; parseStatus: FileCard["displayProps"]["parseStatus"]; pageCount?: number }

function parseTextWorker(bytes: ArrayBuffer, signal?: AbortSignal, limit: number = FILE_LIMITS.textChars): Promise<ParsedText> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" });
    const stop = () => { clearTimeout(timeout); worker.terminate(); signal?.removeEventListener("abort", aborted); };
    const aborted = () => { stop(); reject(new Error("文件读取已取消")); };
    const timeout = setTimeout(() => { stop(); resolve({ text: "", parseStatus: "error" }); }, 12_000);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    worker.onerror = () => { stop(); resolve({ text: "", parseStatus: "error" }); };
    worker.onmessage = (event: MessageEvent<{ error?: boolean; text?: string; partial?: boolean }>) => {
      stop();
      if (event.data.error) { resolve({ text: "", parseStatus: "error" }); return; }
      const text = (event.data.text ?? "").slice(0, limit), partial = event.data.partial === true;
      resolve({ text, parseStatus: partial ? "partial" : text.trim() ? "ready" : "empty" });
    };
    worker.postMessage({ bytes, limit }, [bytes]);
  });
}

/** Read original bytes, separately from the bounded AI extract. */
export async function readOriginalText(blob: Blob, mediaType: string, signal?: AbortSignal): Promise<ParsedText> {
  signal?.throwIfAborted();
  if (mediaType !== "text/markdown") return { text: "", parseStatus: "unsupported" };
  const result = await parseTextWorker(await blob.arrayBuffer(), signal, FILE_LIMITS.batchBytes);
  signal?.throwIfAborted();
  return result;
}

/** PDF.js performs parsing in its own worker. No annotation, script or external link is executed. */
async function parsePdf(bytes: ArrayBuffer, signal?: AbortSignal): Promise<ParsedText> {
  const [{ getDocument, GlobalWorkerOptions }, { default: workerUrl }] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")]);
  GlobalWorkerOptions.workerSrc = workerUrl;
  const task = getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, useWasm: false, verbosity: 0 });
  const cancel = () => { void task.destroy().catch(() => {}); };
  const timeout = setTimeout(cancel, 20_000);
  signal?.addEventListener("abort", cancel, { once: true });
  let pageCount: number | undefined;
  try {
    signal?.throwIfAborted();
    // Never request a password, fetch URLs, attachments or render active annotations.
    task.onPassword = cancel;
    const document = await task.promise; pageCount = document.numPages;
    let text = "", last = 0;
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 100); pageNumber++) {
      signal?.throwIfAborted();
      const page = await document.getPage(pageNumber), content = await page.getTextContent();
      text += `[第 ${pageNumber} 页]\n` + content.items.map(item => "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "").join("") + "\n\n";
      page.cleanup(); last = pageNumber;
      if (text.length >= FILE_LIMITS.textChars) break;
    }
    const partial = last < document.numPages || text.length > FILE_LIMITS.textChars;
    const hasText = text.replace(/\[第 \d+ 页\]/g, "").trim().length > 0;
    return { text: text.slice(0, FILE_LIMITS.textChars), pageCount, parseStatus: partial ? "partial" : hasText ? "ready" : "empty" };
  } catch { signal?.throwIfAborted(); return { text: "", parseStatus: "error", ...(pageCount ? { pageCount } : {}) }; }
  finally { clearTimeout(timeout); signal?.removeEventListener("abort", cancel); await task.destroy().catch(() => {}); }
}

export async function prepareFileAsset(file: File, canvasId: string, signal?: AbortSignal): Promise<FileAsset> {
  validateFileBatch([file]); signal?.throwIfAborted();
  const bytes = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
  const extension = file.name.split(".").pop()!.toLowerCase(), mediaType = types[extension]!;
  const result = extension === "pdf" ? await parsePdf(bytes, signal) : await parseTextWorker(bytes, signal);
  signal?.throwIfAborted();
  return { canvasId, fileId: `file_${sha256}`, name: file.name.trim(), mediaType, sizeBytes: file.size, sha256, blob: file,
    ...result, createdAt: new Date().toISOString() };
}
