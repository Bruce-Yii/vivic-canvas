import { z } from "zod";

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_IMAGE_EDGE = 8192;
export const MAX_IMAGE_ATTACHMENTS = 1;
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

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

const shape = z.strictObject({
  type: z.literal("image"),
  mime: z.enum(IMAGE_MIME_TYPES),
  // Plain canonical base64 only. No data: prefix, URLs, paths, whitespace or extra fields.
  data: z.string().min(4).max(MAX_BASE64_LENGTH),
});

function decodeBase64(data: string): Buffer {
  if (data.length > MAX_BASE64_LENGTH || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new ImageInputError("图片必须是规范的 base64 字节，不能是 URL、路径或 data URL。");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) throw new ImageInputError("图片 base64 编码无效。");
  return bytes;
}

/** Bounded base64 + magic + structure + header dimensions. Full decode is a separate mandatory gate below. */
export const ImageAttachmentSchema = shape.superRefine((value, context) => {
  try {
    const info = inspectImageBytes(decodeBase64(value.data));
    if (info.mime !== value.mime) throw new ImageInputError("图片声明类型与实际文件格式不一致。");
  } catch (error) {
    context.addIssue({ code: "custom", path: ["data"], message: imageInputErrorMessage(error) });
  }
});
export const ImageAttachmentsSchema = z.array(ImageAttachmentSchema).max(MAX_IMAGE_ATTACHMENTS, "一次最多发送 1 张图片。");
export type Attachment = z.infer<typeof ImageAttachmentSchema>;
export interface DecodedImageSize { width: number; height: number }
/** Must actually decode pixels locally, enforce resource limits and ignore embedded external references. */
export type ImageDecoder = (bytes: Uint8Array, mime: ImageMime) => Promise<DecodedImageSize>;

export function imageInputErrorMessage(error: unknown): string {
  return error instanceof ImageInputError ? error.message : "图片校验失败，请重新选择有效的 PNG、JPEG 或 WebP 图片。";
}

/** Fail closed without a real server decoder; structural validation alone must never authorize forwarding. */
export async function validateImageAttachment(input: unknown, decode?: ImageDecoder): Promise<{
  attachment: Attachment; bytes: Uint8Array; width: number; height: number;
}> {
  const parsed = ImageAttachmentSchema.safeParse(input);
  if (!parsed.success) {
    // Only our own constant messages are exposed; raw Zod errors may contain attacker-controlled keys.
    const reason = parsed.error.issues.find(issue => issue.code === "custom")?.message;
    throw new ImageInputError(reason ?? "图片校验失败：仅接受不超过 4 MiB 的静态 PNG、JPEG、WebP base64 附件，类型和尺寸必须有效。");
  }
  if (!decode) throw new ImageInputError("图片分析暂不可用：本机尚未配置安全的图片解码器。");
  const attachment = parsed.data, bytes = decodeBase64(attachment.data), header = inspectImageBytes(bytes);
  let size: DecodedImageSize;
  try { size = await decode(bytes, attachment.mime); }
  catch { throw new ImageInputError("图片无法解码或文件已损坏。"); }
  assertImageDimensions(size?.width, size?.height);
  if (size.width !== header.width || size.height !== header.height) throw new ImageInputError("图片解码尺寸与文件头不一致。");
  return { attachment, bytes, width: size.width, height: size.height };
}

export function assertImageAnalysisAvailable(visionAvailable: boolean): void {
  if (visionAvailable !== true) throw new ImageInputError("当前没有可用的视觉模型，无法分析图片。");
}
