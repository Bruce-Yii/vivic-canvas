import type { SceneImage } from "@/contracts";
import { putMedia } from "./media";

/** Photos the user explicitly adds on their own page; decoded and re-encoded locally. */
export const PHOTO_MAX_BYTES = 25 * 1024 * 1024;
export const PHOTO_MAX_PIXELS = 50_000_000;
export const PHOTO_EDGE = 1920;
const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];
export const PHOTO_ACCEPT = ACCEPTED.join(",");

export class PhotoInputError extends Error {
  constructor(message: string) { super(message); this.name = "PhotoInputError"; }
}

function decode(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const done = () => URL.revokeObjectURL(url);
    const timer = setTimeout(() => { done(); reject(new PhotoInputError("照片解码超时，请换一张较小的照片。")); }, 20_000);
    image.onload = () => { clearTimeout(timer); done(); resolve(image); };
    image.onerror = () => { clearTimeout(timer); done(); reject(new PhotoInputError("照片无法解码或文件已损坏。")); };
    image.src = url;
  });
}

const encode = (canvas: HTMLCanvasElement, type: string, quality: number) => new Promise<Blob | null>(resolve => {
  try { canvas.toBlob(resolve, type, quality); } catch { resolve(null); }
});

/** Decode, bound, downscale and re-encode (drops EXIF/GPS), then store locally. */
export async function storePhoto(file: File): Promise<SceneImage> {
  if (file.type && !ACCEPTED.includes(file.type)) throw new PhotoInputError("仅支持 PNG、JPEG、WebP 照片。");
  if (!file.size || file.size > PHOTO_MAX_BYTES) throw new PhotoInputError("单张照片需小于 25 MB。");
  const image = await decode(file);
  const width = image.naturalWidth, height = image.naturalHeight;
  if (!width || !height || width * height > PHOTO_MAX_PIXELS || Math.max(width, height) > 16_384) throw new PhotoInputError("照片尺寸过大。");
  const scale = Math.min(1, PHOTO_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new PhotoInputError("当前浏览器不支持本地照片处理。");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.removeAttribute("src");
  let blob = await encode(canvas, "image/webp", 0.86);
  if (!blob || blob.type !== "image/webp") blob = await encode(canvas, "image/jpeg", 0.86);
  const size = { width: canvas.width, height: canvas.height };
  canvas.width = 0; canvas.height = 0;
  if (!blob) throw new PhotoInputError("浏览器无法生成照片缩略图。");
  const src = await putMedia(blob, size);
  return { src, ...size };
}

export async function storePhotos(files: File[], limit: number): Promise<{ images: SceneImage[]; errors: string[] }> {
  const images: SceneImage[] = [], errors: string[] = [];
  for (const file of files.slice(0, Math.max(0, limit))) {
    try { images.push(await storePhoto(file)); }
    catch (error) { errors.push(error instanceof PhotoInputError ? error.message : "照片保存失败。"); }
  }
  if (files.length > limit) errors.push(`本卡最多再添加 ${Math.max(0, limit)} 张照片。`);
  return { images, errors };
}
