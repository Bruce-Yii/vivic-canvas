import type { HostedSpaceSnapshot, SceneImage } from "@vivic/contracts";
import { HostedSpaceSnapshotSchema } from "@vivic/contracts";
import { HostedApiError, hostedClient, hostedRequest, isUnknownResult } from "@/hosted/client";
import { readLocal, writeLocal } from "@/hosted/storage";
import { newId } from "@/lib/id";
import type { FileAsset } from "@/files/assetStore";

export interface HostedAssetRecord {
  id: string; kind: "file" | "image"; name: string; mediaType: string; sizeBytes: number; sha256: string;
  text: string; parseStatus: "ready" | "partial" | "empty" | "unsupported" | "error"; pageCount?: number; width?: number; height?: number;
}
interface UploadResult { ok: true; snapshot: HostedSpaceSnapshot; assets: HostedAssetRecord[]; addedCardIds?: string[] }
export const assetPath = (spaceId: string, assetId?: string) => `/api/space/spaces/${encodeURIComponent(spaceId)}/assets${assetId ? `/${encodeURIComponent(assetId)}` : ""}`;
export const uploadKey = (spaceId: string) => `vivic.hosted.upload.${encodeURIComponent(spaceId)}`;
const fileError = (message: string) => new HostedApiError(400, "file-selection", message);
export const getAssetList = (spaceId: string, signal?: AbortSignal) => hostedRequest<{ assets: HostedAssetRecord[] }>(assetPath(spaceId), undefined, "GET", signal);
export const deleteAsset = (spaceId: string, assetId: string) => hostedRequest(assetPath(spaceId, assetId), undefined, "DELETE");
export async function verifyAssetContent(spaceId: string, assetId: string, expectedHash?: string, signal?: AbortSignal): Promise<{ asset: HostedAssetRecord; blob: Blob; bytes: Uint8Array<ArrayBuffer> }> {
  if (!/^(file|image)_[a-f0-9]{64}$/.test(assetId)) throw fileError("原件标识无效，请重新上传原文件。");
  const { asset } = await hostedRequest<{ asset: HostedAssetRecord }>(assetPath(spaceId, assetId), undefined, "GET", signal);
  if (asset.id !== assetId || !/^[a-f0-9]{64}$/.test(asset.sha256) || (expectedHash && asset.sha256 !== expectedHash) || asset.sizeBytes > 10_000_000 || asset.sizeBytes < 0) throw fileError("原件身份与卡片不一致，未打开文件。");
  const response = await fetch(`${assetPath(spaceId, assetId)}/content`, { credentials: "same-origin", cache: "no-store", signal: signal ?? AbortSignal.timeout(20000) });
  if (!response.ok) throw new HostedApiError(response.status, "asset-unavailable", "原文件暂不可用，或此设备的授权已撤销。");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
  if (bytes.byteLength !== asset.sizeBytes || hash !== asset.sha256 || response.headers.get("X-Content-SHA256") !== asset.sha256 || response.headers.get("content-type")?.split(";")[0] !== asset.mediaType) throw fileError("原件完整性校验未通过，未提供文件。");
  return { asset, bytes, blob: new Blob([bytes], { type: asset.mediaType }) };
}
export async function queryUpload(spaceId: string, requestId: string) {
  const result = await hostedRequest<UploadResult>(`/api/space/spaces/${encodeURIComponent(spaceId)}/uploads/${encodeURIComponent(requestId)}`);
  result.snapshot = HostedSpaceSnapshotSchema.parse(result.snapshot); writeLocal(uploadKey(spaceId), ""); return result;
}
export async function uploadFiles(spaceId: string, files: File[], signal?: AbortSignal): Promise<UploadResult> {
  if (readLocal(uploadKey(spaceId))) throw fileError("上次上传结果尚待确认，请在原件管理中查询原请求。");
  const { prepareFileAsset, validateFileBatch } = await import("@/files/parse");
  try { validateFileBatch(files); } catch (error) { throw fileError(error instanceof Error ? error.message : "请选择 PDF 或 Markdown 文件。"); }
  const prepared: FileAsset[] = [];
  for (const file of files) prepared.push(await prepareFileAsset(file, spaceId, signal));
  signal?.throwIfAborted();
  const current = await hostedClient.snapshot(spaceId, signal), requestId = newId("upload"), form = new FormData();
  form.append("requestId", requestId); form.append("expectedVersion", String(current.space.version));
  form.append("manifest", JSON.stringify(prepared.map(asset => ({ name: asset.name, sha256: asset.sha256, text: asset.text, parseStatus: asset.parseStatus, ...(asset.pageCount ? { pageCount: asset.pageCount } : {}) }))));
  files.forEach((file, index) => form.append("files", file, prepared[index]!.name));
  writeLocal(uploadKey(spaceId), requestId);
  try { const response = await fetch(assetPath(spaceId), { method: "POST", body: form, credentials: "same-origin", cache: "no-store", signal: signal ?? AbortSignal.timeout(60000) });
    const result = await response.json() as UploadResult & { code?: string; message?: string };
    if (!response.ok || result.ok !== true) throw new HostedApiError(response.status, result.code ?? "upload-failed", result.message ?? "上传没有完成。");
    result.snapshot = HostedSpaceSnapshotSchema.parse(result.snapshot); writeLocal(uploadKey(spaceId), ""); return result;
  } catch (error) { if (!isUnknownResult(error)) writeLocal(uploadKey(spaceId), ""); throw error; }
}
export async function uploadPhotos(spaceId: string, files: File[]): Promise<SceneImage[]> {
  if (!files.length || files.length > 5 || files.reduce((sum, file) => sum + file.size, 0) > 10_000_000 || files.some(file => !["image/jpeg", "image/png", "image/webp"].includes(file.type))) throw fileError("每次最多 5 张 JPEG、PNG 或 WebP 图片，合计不超过 10 MB。");
  const form = new FormData(); files.forEach(file => form.append("files", file));
  const response = await fetch(`/api/space/spaces/${encodeURIComponent(spaceId)}/photos`, { method: "POST", body: form, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(60000) });
  const result = await response.json() as { images?: SceneImage[]; message?: string; code?: string };
  if (!response.ok || !result.images) throw new HostedApiError(response.status, result.code ?? "photos-failed", result.message ?? "图片上传没有完成。");
  if (result.images.some(image => !/^media:image_[a-f0-9]{64}$/.test(image.src))) throw fileError("图片引用校验未通过。");
  return result.images;
}
