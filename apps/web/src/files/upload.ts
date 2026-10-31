import { FileCardSchema, type FileCard } from "@vivic/contracts";
import type { ControlHost } from "@/sync/controlHost";
import { newId } from "@/lib/id";
import { putFileBatch, removeFileAssets } from "./assetStore";
import { prepareFileAsset, validateFileBatch } from "./parse";
import { canvasStore } from "@/state/canvasStore";
import { OWNER_ONLINE_BUILD } from "@/online/mode";

/** Blob storage succeeds before the owner's one atomic card batch. No second owner. */
export async function uploadFileCards(host: ControlHost, files: File[], signal?: AbortSignal): Promise<FileCard[]> {
  if (OWNER_ONLINE_BUILD) {
    const canvasId = host.getSnapshot().activeCanvasId;
    if (!canvasId) throw new Error("请先选择空间。");
    signal?.throwIfAborted();
    const [{ uploadFiles }, { invalidateOwnerDB }] = await Promise.all([import("@/hostedAssets/client"), import("@/hosted/ownerDB")]);
    const version = host.getSnapshot().canvases.find(canvas => canvas.id === canvasId)?.version ?? 0;
    await host.flush(canvasId, version);
    const result = await uploadFiles(canvasId, files);
    invalidateOwnerDB(); await host.refreshFromStorage();
    return result.snapshot.space.cards.filter((card): card is FileCard => card.type === "FileCard" && files.some(file => file.name === card.displayProps.name));
  }
  // Serialize the storage → owner-commit boundary across tabs, so rollback
  // cannot delete an original concurrently reused by another uploader.
  if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request("vivic-file-upload", { mode: "exclusive", ...(signal ? { signal } : {}) }, () => uploadBatch(host, files, signal));
  return uploadBatch(host, files, signal);
}
async function uploadBatch(host: ControlHost, files: File[], signal?: AbortSignal): Promise<FileCard[]> {
  validateFileBatch(files);
  const before = host.getSnapshot(), canvasId = before.activeCanvasId;
  const isCurrent = () => { const current = host.getSnapshot(); return !signal?.aborted && current.ready && current.ownerMode === "owner" && current.ownerId === before.ownerId && current.activeCanvasId === canvasId; };
  if (!canvasId || !isCurrent()) throw new Error("请先回到电脑控制页");
  const incoming = [];
  for (const file of files) incoming.push(await prepareFileAsset(file, canvasId, signal));
  if (!isCurrent()) throw new Error("空间或控制权已变化，文件未上传");
  const batch = await putFileBatch(canvasId, incoming);
  if (!isCurrent()) { await removeFileAssets(canvasId, batch.addedIds); throw new Error("空间或控制权已变化，文件未上传"); }
  const stamp = new Date().toISOString();
  // Originals and cards have separate lifetimes (delete/undo retains bytes).
  // Reuse an existing card by content within this Space; after deletion a new
  // upload may deliberately restore a card for the still-retained original.
  const represented = new Set(canvasStore.getState().cards.flatMap(entry => !entry.exitingRequestId && entry.record.type === "FileCard" ? [entry.record.displayProps.sha256] : []));
  const unique = batch.assets.filter(asset => { if (represented.has(asset.sha256)) return false; represented.add(asset.sha256); return true; });
  if (!unique.length) return [];
  const cards = unique.map((asset, index) => FileCardSchema.parse({
    id: newId("filecard"), type: "FileCard", variant: "standard", sources: [], sourceData: {},
    displayProps: { fileId: asset.fileId, name: asset.name, mediaType: asset.mediaType, sizeBytes: asset.sizeBytes, sha256: asset.sha256,
      previewText: asset.text.slice(0, 1600), parseStatus: asset.parseStatus, ...(asset.pageCount ? { pageCount: asset.pageCount } : {}) },
    layout: { x: index * 280, y: 0, width: 240, height: 176, pinned: false }, metadata: { createdAt: stamp, updatedAt: stamp },
  }));
  const result = host.dispatch({ schemaVersion: "0.6", requestId: newId("fileupload"), canvasId, actions: cards.map(card => ({ type: "card.create" as const, card })) });
  if (!result.ok) { await removeFileAssets(canvasId, batch.addedIds); throw new Error("文件卡片没有保存，请重试"); }
  const version = host.getSnapshot().canvases.find(canvas => canvas.id === canvasId)?.version;
  if (version === undefined) throw new Error("文件保存结果待确认，请检查 Space");
  try { await host.flush(canvasId, version); }
  catch { throw new Error("文件已读取，但卡片保存结果待确认，请检查 Space 后再试"); }
  return cards;
}
