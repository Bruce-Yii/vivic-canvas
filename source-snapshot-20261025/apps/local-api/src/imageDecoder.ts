import { Buffer } from "node:buffer";
import sharp from "sharp";
import type { Sharp } from "sharp";
import {
  ImageInputError, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, assertImageDimensions, inspectImageBytes,
} from "./images.js";
import type { ImageDecoder as DecoderFunction, ImageMime } from "./images.js";

export type ImageDecoder = DecoderFunction;
export const MAX_CONCURRENT_IMAGE_DECODES = 2;
export const IMAGE_DECODE_TIMEOUT_SECONDS = 3;
export const IMAGE_DECODE_WALL_TIMEOUT_MS = 5000;

// Sharp's cache is process-wide. Disable it so this module does not retain image operations/pixels.
// Do not change sharp.concurrency(): it controls threads per image, not the number of admitted jobs.
sharp.cache(false);
let inFlight = 0;
const timeoutError = () => new ImageInputError("图片解码超时，请尝试更小的图片。");
const formatForMime: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" };

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
/** libvips can stop reading after the final pixels, leaving an IEND CRC unchecked. Check every chunk. */
function verifyPngChecksums(input: Buffer): void {
  for (let offset = 8; offset < input.length;) {
    // inspectImageBytes has already checked all chunk lengths and the exact container boundary.
    const length = input.readUInt32BE(offset);
    let crc = 0xffffffff;
    for (let index = offset + 4; index < offset + length + 8; index++) crc = (crc >>> 8) ^ crcTable[(crc ^ input[index]) & 255];
    if (((crc ^ 0xffffffff) >>> 0) !== input.readUInt32BE(offset + length + 8)) {
      throw new ImageInputError("PNG 图片校验和（CRC）无效，文件可能已损坏。");
    }
    offset += length + 12;
  }
}

/** Buffer-only, full-pixel decoder for validateImageAttachment(input, decodeImage). No queue or I/O. */
export const decodeImage: ImageDecoder = async (bytes, mime) => {
  // Runtime checks also protect direct callers that bypass the request schema or TypeScript.
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageInputError("单张图片必须是非空字节且不超过 4 MiB，不能使用路径或 URL。");
  }
  if (inFlight >= MAX_CONCURRENT_IMAGE_DECODES) throw new ImageInputError("图片解码繁忙，最多同时处理 2 张图片，请稍后重试。");

  // Private snapshot: caller mutation during metadata()/decode must not change validated bytes.
  const input = Buffer.from(bytes);
  let header: ReturnType<typeof inspectImageBytes>;
  try {
    header = inspectImageBytes(input);
    if (header.mime !== mime) throw new ImageInputError("图片声明类型与实际文件格式不一致。");
    if (header.mime === "image/png") verifyPngChecksums(input);
  } catch (error) { input.fill(0); throw error; }

  inFlight++;
  let expired = false;
  let hadWarning = false;
  let pipeline: Sharp | undefined;
  const work = (async () => {
    let pixels: Buffer | undefined;
    try {
      pipeline = sharp(input, {
        failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS, limitInputChannels: 4,
        sequentialRead: true, animated: false, autoOrient: false,
      }).timeout({ seconds: IMAGE_DECODE_TIMEOUT_SECONDS });
      // Some tiny corrupt JPEGs resolve with pixels AND a warning even with failOn:'warning'.
      // Retain only a boolean, never potentially sensitive native warning text.
      pipeline.on("warning", () => { hadWarning = true; });
      const metadata = await pipeline.metadata();
      if (expired) throw timeoutError();
      if (hadWarning) throw new ImageInputError("图片无法完整解码或文件已损坏。");
      assertImageDimensions(metadata.width, metadata.height);
      if (metadata.format !== formatForMime[mime] || metadata.width !== header.width || metadata.height !== header.height) {
        throw new ImageInputError("图片解码尺寸或格式与文件头不一致。");
      }
      if ((metadata.pages ?? 1) !== 1 || metadata.channels < 1 || metadata.channels > 4) {
        throw new ImageInputError("仅支持不超过 4 通道的单帧静态图片。");
      }
      // metadata() alone never validates compressed pixels. Force every pixel to be decoded.
      const result = await pipeline.raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
      pixels = result.data;
      if (expired) throw timeoutError();
      if (hadWarning) throw new ImageInputError("图片无法完整解码或文件已损坏。");
      const { width, height, channels, format } = result.info;
      assertImageDimensions(width, height);
      if (width !== header.width || height !== header.height || format !== "raw" || channels < 1 || channels > 4 ||
          pixels.byteLength !== width * height * channels) {
        throw new ImageInputError("图片完整解码结果与文件头不一致。");
      }
      return { width, height };
    } catch (error) {
      if (error instanceof ImageInputError) throw error;
      if (error instanceof Error && /timeout|timed out/i.test(error.message)) throw timeoutError();
      throw new ImageInputError("图片无法完整解码或文件已损坏。");
    } finally {
      // Do not persist or return pixels. Native internal allocations are freed by Sharp/libvips.
      pixels?.fill(0); pixels = undefined;
      pipeline?.removeAllListeners("warning"); pipeline?.destroy(); pipeline = undefined;
      input.fill(0);
      // A wall-time rejection MUST NOT admit a third native job while this one still runs.
      inFlight--;
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(timeoutError()); }, IMAGE_DECODE_WALL_TIMEOUT_MS);
  });
  // Sharp's native timeout excludes libuv queue time. Bound caller waiting separately, retaining
  // the slot until work actually settles; Promise.race also observes any late work rejection.
  try { return await Promise.race([work, deadline]); }
  finally { clearTimeout(timer); }
};
