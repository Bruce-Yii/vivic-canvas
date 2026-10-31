import { FILE_LIMITS, type FileCard } from "@vivic/contracts";

export interface FileAsset {
  canvasId: string; fileId: string; name: string; mediaType: FileCard["displayProps"]["mediaType"];
  sizeBytes: number; sha256: string; blob: Blob; text: string;
  parseStatus: FileCard["displayProps"]["parseStatus"]; pageCount?: number; createdAt: string;
}
export const FILE_DB_NAME = "vivic-files";
let opening: Promise<IDBDatabase> | undefined;
const listeners = new Set<() => void>();
export const subscribeFileAssets = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const changed = () => listeners.forEach(listener => listener());
const request = <T>(value: IDBRequest<T>) => new Promise<T>((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("文件保存失败")); });
function open(): Promise<IDBDatabase> {
  if (!opening) opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("此浏览器不支持本地文件保存")); return; }
    const req = indexedDB.open(FILE_DB_NAME, 1);
    req.onupgradeneeded = () => { const store = req.result.createObjectStore("assets", { keyPath: ["canvasId", "fileId"] }); store.createIndex("canvasId", "canvasId"); };
    req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); opening = undefined; }; resolve(req.result); };
    req.onerror = () => reject(new Error("无法打开文件存储"));
  }).catch(error => { opening = undefined; throw error; });
  return opening;
}
export async function listFileAssets(canvasId: string): Promise<FileAsset[]> {
  const db = await open(); return request(db.transaction("assets").objectStore("assets").index("canvasId").getAll(canvasId));
}
export async function getFileAsset(canvasId: string, fileId: string): Promise<FileAsset | undefined> {
  const db = await open(); return request(db.transaction("assets").objectStore("assets").get([canvasId, fileId]));
}
export async function hasFileAsset(canvasId: string, fileId: string): Promise<boolean> {
  const db = await open(); return (await request(db.transaction("assets").objectStore("assets").getKey([canvasId, fileId]))) !== undefined;
}
/** Quota and de-duplication share the same write transaction across tabs. */
export async function putFileBatch(canvasId: string, incoming: FileAsset[]): Promise<{ assets: FileAsset[]; addedIds: string[] }> {
  if (!incoming.length || incoming.length > FILE_LIMITS.count || incoming.reduce((sum, asset) => sum + asset.sizeBytes, 0) > FILE_LIMITS.batchBytes
    || incoming.some(asset => asset.canvasId !== canvasId || asset.sizeBytes !== asset.blob.size || asset.sizeBytes < 0 || asset.text.length > FILE_LIMITS.textChars)) throw new Error("每次最多 5 个文件，合计不超过 10 MB");
  const db = await open(), tx = db.transaction("assets", "readwrite"), completion = done(tx);
  const store = tx.objectStore("assets");
  const existing = await request<FileAsset[]>(store.index("canvasId").getAll(canvasId));
  const seen = new Map(existing.map(asset => [asset.sha256, asset]));
  let bytes = existing.reduce((sum, asset) => sum + asset.sizeBytes, 0);
  const assets: FileAsset[] = [], addedIds: string[] = [];
  for (const asset of incoming) {
    const same = seen.get(asset.sha256);
    if (same) { assets.push(same); continue; }
    bytes += asset.sizeBytes;
    if (bytes > FILE_LIMITS.spaceBytes) { tx.abort(); await completion.catch(() => {}); throw new Error("这个 Space 的文件容量已达到 100 MB，请先清理未使用的原件"); }
    store.add(asset); seen.set(asset.sha256, asset); assets.push(asset); addedIds.push(asset.fileId);
  }
  await completion; changed(); return { assets, addedIds };
}
export async function removeFileAssets(canvasId: string, fileIds: string[]): Promise<void> {
  const db = await open(), tx = db.transaction("assets", "readwrite"), completion = done(tx);
  for (const fileId of new Set(fileIds)) tx.objectStore("assets").delete([canvasId, fileId]);
  await completion; changed();
}
/** A permanently deleted Space owns no recoverable file references. */
export async function removeCanvasFileAssets(canvasId: string): Promise<void> {
  const db = await open(), tx = db.transaction("assets", "readwrite"), completion = done(tx), store = tx.objectStore("assets");
  const keys = await request(store.index("canvasId").getAllKeys(canvasId));
  for (const key of keys) store.delete(key);
  await completion; changed();
}
/** Local reset explicitly clears originals as well as previews. */
export async function clearAllFileAssets(): Promise<void> {
  const db = await open(), tx = db.transaction("assets", "readwrite"), completion = done(tx);
  tx.objectStore("assets").clear(); await completion; changed();
}
export const fileSizeLabel = (bytes: number) => bytes < 1_000_000 ? `${Math.max(0.1, bytes / 1000).toFixed(bytes < 1000 ? 1 : 0)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
export function downloadFileAsset(asset: FileAsset): void {
  const url = URL.createObjectURL(new Blob([asset.blob], { type: "application/octet-stream" }));
  const link = document.createElement("a"); link.href = url; link.download = asset.name; link.rel = "noopener";
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
