/** Control-tab memory only. No network, persistence, context or Display integration. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_IMAGE_EDGE = 8192;
export const MAX_IMAGE_ATTACHMENTS = 1;
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

export class ImageInputError extends Error {
  constructor(message: string) { super(message); this.name = "ImageInputError"; }
}
const invalid = (): never => { throw new ImageInputError("图片格式不支持或文件已损坏，仅接受 PNG、JPEG、WebP。"); };

export function assertImageDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) invalid();
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_IMAGE_PIXELS) {
    throw new ImageInputError("图片尺寸过大：每边最多 8192 像素，总计最多 1600 万像素。");
  }
}

/** Structural preflight, NOT a pixel decoder. Kept independent of browser/filesystem/network APIs. */
export function inspectImageBytes(bytes: Uint8Array): { mime: ImageMime; width: number; height: number } {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new ImageInputError("单张图片必须非空且不超过 4 MiB。");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, count: number) => String.fromCharCode(...bytes.subarray(start, start + count));
  let mime: ImageMime, width = 0, height = 0;
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) {
    mime = "image/png";
    let offset = 8, data = false, end = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset), kind = text(offset + 4, 4);
      if (length > bytes.length - offset - 12) invalid();
      if (offset === 8) {
        if (kind !== "IHDR" || length !== 13) invalid();
        width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
        const depth = bytes[offset + 16], color = bytes[offset + 17];
        const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (!depths[color]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) invalid();
        assertImageDimensions(width, height);
      } else if (kind === "IHDR") invalid();
      if (kind === "acTL") throw new ImageInputError("暂不支持动画图片，请上传静态图片。");
      if (kind === "IDAT" && length > 0) data = true;
      offset += length + 12;
      if (kind === "IEND") { if (length !== 0 || offset !== bytes.length) invalid(); end = true; break; }
    }
    if (!data || !end) invalid();
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    mime = "image/jpeg";
    let offset = 2, scan = false;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) invalid();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0 || marker === 216 || marker === 217 || marker === 1 || (marker >= 208 && marker <= 215)) invalid();
      if (offset + 2 > bytes.length) invalid();
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) invalid();
      // Browser-compatible Huffman baseline / extended sequential / progressive only.
      if ([192, 193, 194].includes(marker)) {
        if (width || length < 11 || bytes[offset + 2] !== 8) invalid();
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5);
        const components = bytes[offset + 7];
        if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) invalid();
        assertImageDimensions(width, height);
      }
      if (marker === 218) {
        if (!width || length < 8 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217 || offset + length >= bytes.length - 2) invalid();
        scan = true; break;
      }
      offset += length;
    }
    if (!scan) invalid();
  } else if (bytes.length >= 20 && text(0, 4) === "RIFF" && text(8, 4) === "WEBP") {
    mime = "image/webp";
    if (view.getUint32(4, true) + 8 !== bytes.length) invalid();
    let offset = 12, frame = false, extended = false;
    while (offset + 8 <= bytes.length) {
      const kind = text(offset, 4), length = view.getUint32(offset + 4, true), p = offset + 8;
      if (length > bytes.length - p || p + length + (length % 2) > bytes.length) invalid();
      if (kind === "ANIM" || kind === "ANMF") throw new ImageInputError("暂不支持动画图片，请上传静态图片。");
      if (kind === "VP8X") {
        if (offset !== 12 || length !== 10) invalid();
        if (bytes[p] & 2) throw new ImageInputError("暂不支持动画图片，请上传静态图片。");
        extended = true;
        width = 1 + bytes[p + 4] + (bytes[p + 5] << 8) + (bytes[p + 6] << 16);
        height = 1 + bytes[p + 7] + (bytes[p + 8] << 8) + (bytes[p + 9] << 16);
        assertImageDimensions(width, height);
      }
      if (kind === "VP8 " || kind === "VP8L") {
        if (frame) invalid();
        let w: number, h: number;
        if (kind === "VP8 ") {
          if (length < 10 || (bytes[p] & 1) !== 0 || text(p + 3, 3) !== "\x9d\x01\x2a") invalid();
          w = view.getUint16(p + 6, true) & 0x3fff; h = view.getUint16(p + 8, true) & 0x3fff;
        } else {
          if (length < 5 || bytes[p] !== 47 || (bytes[p + 4] >> 5) !== 0) invalid();
          const bits = view.getUint32(p + 1, true);
          w = (bits & 0x3fff) + 1; h = ((bits >>> 14) & 0x3fff) + 1;
        }
        assertImageDimensions(w, h);
        if (extended && (w !== width || h !== height)) invalid();
        width = w; height = h; frame = true;
      }
      offset = p + length + (length % 2);
    }
    if (!frame || offset !== bytes.length) invalid();
  } else return invalid();
  assertImageDimensions(width, height);
  return { mime, width, height };
}

/** Only this object belongs in a single, explicitly sent request. Never persist it. */
export interface Attachment { type: "image"; mime: ImageMime; data: string }
export interface PreparedImageAttachment {
  attachment: Attachment;
  previewUrl: string;
  width: number;
  height: number;
  /** Idempotent: call on replace, cancel, send completion, owner change and unmount. */
  dispose: () => void;
}
export const IMAGE_PREVIEW_EDGE = 1600;
const PROCESS_TIMEOUT_MS = 15_000;
const cancelled = () => new DOMException("图片处理已取消。", "AbortError");
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw cancelled(); };

/** Scoped DOM clipboard/drop files only. Never reads clipboard or fetches text/HTML URLs. */
export function imageFilesFromTransfer(transfer: Pick<DataTransfer, "files" | "items">): File[] {
  const files = Array.from(transfer.files ?? []);
  if (files.length) return files;
  return Array.from(transfer.items ?? []).filter(item => item.kind === "file")
    .map(item => item.getAsFile()).filter((file): file is File => file !== null);
}

function decodeImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); image.onload = null; image.onerror = null; };
    const fail = (error: Error) => { cleanup(); image.removeAttribute("src"); reject(error); };
    const abort = () => fail(cancelled());
    const timer = setTimeout(() => fail(new ImageInputError("图片解码超时，请尝试更小的图片。")), PROCESS_TIMEOUT_MS);
    image.onload = () => { cleanup(); resolve(image); };
    image.onerror = () => fail(new ImageInputError("图片无法解码或文件已损坏。"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    image.src = url;
  });
}

function encodeCanvas(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(cancelled()); };
    const timer = setTimeout(() => { cleanup(); reject(new ImageInputError("图片重编码超时，请尝试更小的图片。")); }, PROCESS_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try {
      canvas.toBlob(blob => {
        cleanup();
        if (signal?.aborted) reject(cancelled());
        else if (!blob) reject(new ImageInputError("浏览器无法生成安全的图片缩略图。"));
        else resolve(blob);
      }, "image/png");
    } catch { cleanup(); reject(new ImageInputError("浏览器无法重编码图片。")); }
  });
}

function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += 32768) parts.push(String.fromCharCode(...bytes.subarray(start, start + 32768)));
  return btoa(parts.join(""));
}

/** Actual local decode, pixel limits, canvas thumbnail + metadata removal. Selection NEVER sends. */
export async function prepareImageAttachment(files: readonly File[], options: { signal?: AbortSignal } = {}): Promise<PreparedImageAttachment> {
  const { signal } = options;
  checkAbort(signal);
  if (files.length !== 1) throw new ImageInputError("一次请选择 1 张图片。");
  const file = files[0];
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new ImageInputError("单张图片必须非空且不超过 4 MiB。");
  // MIME is only an extra check; empty MIME from a local file is permitted if bytes pass.
  if (file.type && !(IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) invalid();
  const original = new Uint8Array(await file.arrayBuffer());
  checkAbort(signal);
  const info = inspectImageBytes(original);
  if (file.type && file.type !== info.mime) throw new ImageInputError("图片声明类型与实际文件格式不一致。");
  const sourceUrl = URL.createObjectURL(new Blob([original], { type: info.mime }));
  let image: HTMLImageElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    image = await decodeImage(sourceUrl, signal);
    checkAbort(signal);
    const width = image.naturalWidth, height = image.naturalHeight;
    assertImageDimensions(width, height);
    // EXIF orientation may swap JPEG axes; all other header/decode differences fail closed.
    if (!(width === info.width && height === info.height) &&
        !(info.mime === "image/jpeg" && width === info.height && height === info.width)) {
      throw new ImageInputError("图片解码尺寸与文件头不一致。");
    }
    const scale = Math.min(1, IMAGE_PREVIEW_EDGE / Math.max(width, height));
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new ImageInputError("当前浏览器不支持安全图片处理。");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await encodeCanvas(canvas, signal);
    checkAbort(signal);
    if (!blob.size || blob.size > MAX_IMAGE_BYTES) throw new ImageInputError("重编码后的图片超过 4 MiB，请裁小后重试。");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    checkAbort(signal);
    const encoded = inspectImageBytes(bytes);
    if (encoded.mime !== "image/png" || encoded.width !== canvas.width || encoded.height !== canvas.height) {
      throw new ImageInputError("浏览器生成的图片格式或尺寸无效。");
    }
    // Always use the re-encoded blob, never original bytes or the original filename.
    const attachment: Attachment = { type: "image", mime: "image/png", data: toBase64(bytes) };
    const previewUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    let disposed = false;
    return { attachment, previewUrl, width: encoded.width, height: encoded.height, dispose: () => {
      if (!disposed) { disposed = true; URL.revokeObjectURL(previewUrl); }
    } };
  } finally {
    URL.revokeObjectURL(sourceUrl);
    image?.removeAttribute("src");
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
