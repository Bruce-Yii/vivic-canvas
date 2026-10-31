import type { ControlHost } from "@/sync/controlHost";
import { canvasStore } from "@/state/canvasStore";
import { getMediaAsset } from "@/cards/scene/mediaStore";
import { FILE_CHUNK_BYTES, type ImagePreview } from "@vivic/mobile-console-prototype/protocol";
import type { ExistingCard } from "@vivic/mobile-console-prototype/vivicHostAdapter";

type ImageRef = { ref: string; alt: string; id: string };
/** Only the two requested visible image fields. Never walk sourceData or remote URLs. */
export function visibleImageRefs(card: ExistingCard["record"]): ImageRef[] {
  const p = card.displayProps as { images?: Array<{ src?: string; alt?: string }>; cover?: string; title?: string } | undefined;
  if (!p) return [];
  const values = card.type === "GalleryCard" ? (p.images ?? []).slice(0, 8).map((image, index) => ({ ref: image.src ?? "", alt: (image.alt ?? `照片 ${index + 1}`).slice(0, 120), id: `photo_${index}` }))
    : card.type === "BookCard" && p.cover ? [{ ref: p.cover, alt: (p.title ?? "书籍封面").slice(0, 120), id: "cover" }] : [];
  return values.filter(image => /^media:[A-Za-z0-9_-]{1,80}$/.test(image.ref));
}
type Projected = { fingerprint: string; images: ImagePreview[]; notice?: string; bytes: Map<string, { ref: string; blob: Blob }> };
/** At most 32 × 256 KiB of sanitized thumbnails, owned by the active connector. */
export function createMobileImageProjection(host: ControlHost) {
  let entries = new Map<string, Projected>(), generation = 0;
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | undefined;
  const fingerprint = (canvasId: string, record: ExistingCard["record"]) => JSON.stringify([canvasId, visibleImageRefs(record)]);
  const refresh = async () => {
    const current = ++generation, canvasId = host.getSnapshot().activeCanvasId;
    if (!canvasId) { entries.clear(); return; }
    const previous = entries; entries = new Map();
    const cards = canvasStore.getState().cards.filter(entry => !entry.exitingRequestId && ["GalleryCard", "BookCard"].includes(entry.record.type));
    let count = 0;
    for (const { record } of cards) {
      if (current !== generation) return;
      const refs = visibleImageRefs(record), key = fingerprint(canvasId, record), reused = previous.get(record.id);
      const entry: Projected = { fingerprint: key, images: [], bytes: new Map() };
      entries.set(record.id, entry);
      if (count + refs.length > 32) { entry.notice = "手机图片预览已达本 Space 的 32 张限额，请在电脑查看其余图片。"; continue; }
      count += refs.length;
      if (reused?.fingerprint === key && reused.images.length === refs.length) { entries.set(record.id, reused); continue; }
      if (!refs.length) { entry.notice = "暂无可共享的本地图片；远程链接请在电脑查看。"; continue; }
      entry.notice = "正在准备只读图片预览…";
      listeners.forEach(listener => listener());
      for (const image of refs) {
        let bitmap: ImageBitmap | undefined;
        try {
          const asset = await getMediaAsset(image.ref);
          if (!asset || !["image/jpeg", "image/png", "image/webp"].includes(asset.blob.type) || asset.blob.size > 16_000_000
            || !Number.isFinite(asset.width * asset.height) || asset.width <= 0 || asset.height <= 0 || asset.width * asset.height > 40_000_000) throw new Error("image_limit");
          bitmap = await createImageBitmap(asset.blob);
          if (current !== generation) return;
          if (bitmap.width * bitmap.height > 40_000_000) throw new Error("image_limit");
          const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
          const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          const context = canvas.getContext("2d"); if (!context) throw new Error("image_canvas"); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          const encode = (quality: number) => new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("image_encode")), "image/jpeg", quality));
          let blob = await encode(.8); if (blob.size > 262144) blob = await encode(.5);
          if (blob.size > 262144) throw new Error("image_limit");
          const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
          if (current !== generation) return;
          entry.images.push({ id: image.id, alt: image.alt, name: `${image.id}.jpg`, mediaType: "image/jpeg", sizeBytes: blob.size,
            sha256: [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join(""), parseStatus: "ready", width: canvas.width, height: canvas.height });
          entry.bytes.set(image.id, { ref: image.ref, blob });
        } catch { entry.notice = "部分图片暂无法读取或超过预览限制，请在电脑检查原图。"; }
        finally { bitmap?.close(); }
      }
      if (entry.images.length === refs.length) entry.notice = undefined;
      listeners.forEach(listener => listener());
    }
    listeners.forEach(listener => listener());
  };
  return {
    projectImages: (record: ExistingCard["record"]) => {
      const entry = entries.get(record.id), canvasId = host.getSnapshot().activeCanvasId;
      return entry && canvasId && entry.fingerprint === fingerprint(canvasId, record) ? { images: entry.images, imageNotice: entry.notice } : { images: [], imageNotice: "正在准备图片预览…" };
    },
    async readImageChunk(canvasId: string, cardId: string, imageId: string, offset: number) {
      const record = canvasStore.getState().cards.find(entry => !entry.exitingRequestId && entry.record.id === cardId)?.record;
      const entry = entries.get(cardId), image = entry?.images.find(image => image.id === imageId), bytes = entry?.bytes.get(imageId);
      if (!record || host.getSnapshot().activeCanvasId !== canvasId || !entry || entry.fingerprint !== fingerprint(canvasId, record) || !image || !bytes
        || !await getMediaAsset(bytes.ref) || !Number.isSafeInteger(offset) || offset < 0 || offset > image.sizeBytes) throw new Error("image_scope_changed");
      const chunk = new Uint8Array(await bytes.blob.slice(offset, offset + FILE_CHUNK_BYTES).arrayBuffer());
      return { data: btoa(String.fromCharCode(...chunk)), totalBytes: image.sizeBytes, sha256: image.sha256, name: image.name, mediaType: image.mediaType };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!unsubscribe) { const a = canvasStore.subscribe(() => void refresh()), b = host.subscribe(() => void refresh()); unsubscribe = () => { a(); b(); }; void refresh(); }
      return () => { listeners.delete(listener); if (!listeners.size) { unsubscribe?.(); unsubscribe = undefined; ++generation; entries.clear(); } };
    },
  };
}
