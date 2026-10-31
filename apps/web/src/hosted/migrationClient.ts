import type { CardRecord, HostedSpaceSnapshot } from "@vivic/contracts";
import { HostedSpaceSnapshotSchema } from "@vivic/contracts";
import { errorMessage, HostedApiError, hostedRequest } from "./client";
import { readLocal, writeLocal } from "./storage";
import type { CanvasRecord } from "@/persistence/canvasRecord";
import type { StoredCardDefinition } from "@/persistence/db";

export interface LegacyAssetMetadata { legacyId: string; kind: "file" | "image"; name: string; mediaType: string; sizeBytes: number; sha256: string; text?: string; parseStatus?: "ready" | "partial" | "empty" | "unsupported" | "error"; pageCount?: number }
export interface LegacyAsset { metadata: LegacyAssetMetadata; blob: Blob }
export interface MigrationStatus { ok: true; requestId: string; status: "staging" | "succeeded"; expectedVersion: number; received: { legacyId: string; assetId: string }[]; missing: { legacyId: string; kind: "file" | "image"; expected?: LegacyAssetMetadata }[]; snapshot?: HostedSpaceSnapshot }
export interface LegacySource { record: CanvasRecord; definitions: StoredCardDefinition[]; assets: LegacyAsset[]; missing: string[] }
export interface MigrationReceipt { requestId: string; sourceId: string; expectedVersion?: number; sourceHash?: string }
export const migrationKey = (spaceId: string) => `vivic.hosted.import.${encodeURIComponent(spaceId)}`;
const importPath = (spaceId: string, requestId: string) => `/api/space/spaces/${encodeURIComponent(spaceId)}/imports/${encodeURIComponent(requestId)}`;
export function readMigration(spaceId: string): MigrationReceipt | null { try { const value = JSON.parse(readLocal(migrationKey(spaceId)) || "null"); return value && typeof value.requestId === "string" && typeof value.sourceId === "string" ? value : null; } catch { return null; } }
const checked = (result: MigrationStatus) => { if (result.snapshot) result.snapshot = HostedSpaceSnapshotSchema.parse(result.snapshot); return result; };
export async function migrationStatus(spaceId: string, requestId: string) { return checked(await hostedRequest<MigrationStatus>(importPath(spaceId, requestId))); }
export async function beginMigration(spaceId: string, requestId: string, expectedVersion: number, source: LegacySource) {
  const body = { requestId, expectedVersion, record: source.record, definitions: source.definitions, assets: source.assets.map(asset => asset.metadata) }, sourceHash = await textHash(JSON.stringify(body)), previous = readMigration(spaceId);
  if (previous?.requestId === requestId && previous.sourceHash && previous.sourceHash !== sourceHash) throw new HostedApiError(409, "migration-source-changed", "旧来源已发生变化，请保留原请求查询，不会覆盖原导入内容。");
  writeLocal(migrationKey(spaceId), JSON.stringify({ requestId, sourceId: source.record.id, expectedVersion, sourceHash }));
  return checked(await hostedRequest<MigrationStatus>(`/api/space/spaces/${encodeURIComponent(spaceId)}/import`, body, "POST", AbortSignal.timeout(60000)));
}
export async function replayMigration(spaceId: string, source: LegacySource) { const receipt = readMigration(spaceId); if (!receipt || typeof receipt.expectedVersion !== "number" || !receipt.sourceHash) throw new HostedApiError(409, "migration-receipt", "缺少原请求校验信息，请继续查询原导入状态。"); return beginMigration(spaceId, receipt.requestId, receipt.expectedVersion, source); }
export async function stageMigrationAssets(spaceId: string, requestId: string, assets: LegacyAsset[]) {
  const form = new FormData(); form.append("manifest", JSON.stringify(assets.map(asset => asset.metadata))); assets.forEach(asset => form.append("files", new File([asset.blob], asset.metadata.name, { type: asset.metadata.mediaType })));
  const response = await fetch(`${importPath(spaceId, requestId)}/assets`, { method: "POST", credentials: "same-origin", cache: "no-store", body: form, signal: AbortSignal.timeout(60000) });
  const result = await response.json() as MigrationStatus & { code?: string; message?: string };
  if (!response.ok || result.ok !== true) throw new HostedApiError(response.status, result.code ?? "migration-assets", result.message ?? "原件暂存未完成。");
  return checked(result);
}
export async function commitMigration(spaceId: string, requestId: string) { return checked(await hostedRequest<MigrationStatus>(`${importPath(spaceId, requestId)}/commit`, {})); }
export async function readLegacySources() {
  const { openVivicDB } = await import("@/persistence/db"), db = await openVivicDB();
  try { return { records: await db.getAllCanvases(), definitions: await db.loadCardDefinitions() }; } finally { db.close(); }
}
/** Enumerate only renderer-backed image slots, never arbitrary note/source text. */
export function legacyImageReferences(card: CardRecord): string[] {
  let sources: string[];
  switch (card.type) {
    case "GalleryCard": sources = card.displayProps.images.map(image => image.src); break;
    case "PhotoCoverCard": sources = card.displayProps.image ? [card.displayProps.image.src] : []; break;
    case "BookCard": sources = card.displayProps.cover ? [card.displayProps.cover] : []; break;
    case "NewsCard": case "LinkPreviewCard": sources = card.displayProps.image ? [card.displayProps.image] : []; break;
    case "StoryCarouselCard": sources = card.displayProps.slides.flatMap(slide => slide.image ? [slide.image] : []); break;
    default: sources = [];
  }
  return [...new Set(sources.filter(source => /^media:[A-Za-z0-9_-]{1,80}$/.test(source)))];
}
export async function inspectLegacySource(record: CanvasRecord, definitions: StoredCardDefinition[]): Promise<LegacySource> {
  const [{ listFileAssets }, { getMediaAsset }] = await Promise.all([import("@/files/assetStore"), import("@/cards/scene/mediaStore")]);
  const assets: LegacyAsset[] = [], missing: string[] = [], fileAssets = await listFileAssets(record.id), imageIds = new Set<string>();
  for (const asset of fileAssets) { if (await blobHash(asset.blob) !== asset.sha256) { missing.push(asset.fileId); continue; } assets.push({ blob: asset.blob, metadata: { legacyId: asset.fileId, kind: "file", name: asset.name, mediaType: asset.mediaType, sizeBytes: asset.blob.size, sha256: asset.sha256, text: asset.text, parseStatus: asset.parseStatus, ...(asset.pageCount ? { pageCount: asset.pageCount } : {}) } }); }
  for (const card of Object.values(record.cardsById)) { if (card.type === "FileCard" && !assets.some(asset => asset.metadata.legacyId === card.displayProps.fileId)) missing.push(card.displayProps.fileId); legacyImageReferences(card).forEach(source => imageIds.add(source.slice(6))); }
  for (const id of imageIds) { const image = await getMediaAsset(`media:${id}`); if (!image) { missing.push(id); continue; } const mediaType = image.blob.type, extension = mediaType === "image/jpeg" ? "jpg" : mediaType === "image/png" ? "png" : "webp";
    assets.push({ blob: image.blob, metadata: { legacyId: id, kind: "image", name: `photo-${id}.${extension}`, mediaType, sizeBytes: image.blob.size, sha256: await blobHash(image.blob) } }); }
  return { record, definitions, assets, missing: [...new Set(missing)] };
}
export async function pickedLegacyAsset(file: File, missing: MigrationStatus["missing"][number]): Promise<LegacyAsset> {
  const expected = missing.expected;
  let metadata: LegacyAssetMetadata = expected ?? { legacyId: missing.legacyId, kind: missing.kind, name: file.name, mediaType: file.type, sizeBytes: file.size, sha256: await blobHash(file) };
  if (file.size !== metadata.sizeBytes || await blobHash(file) !== metadata.sha256) throw new HostedApiError(400, "migration-original", "所选原件与旧卡片的大小或哈希不一致。");
  if (metadata.kind === "file" && ["application/pdf", "text/markdown"].includes(metadata.mediaType) && metadata.text === undefined) { const { prepareFileAsset } = await import("@/files/parse"), parsed = await prepareFileAsset(new File([file], metadata.name, { type: metadata.mediaType }), "migration"); metadata = { ...metadata, text: parsed.text, parseStatus: parsed.parseStatus, ...(parsed.pageCount ? { pageCount: parsed.pageCount } : {}) }; }
  return { blob: file, metadata };
}
async function blobHash(blob: Blob) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map(value => value.toString(16).padStart(2, "0")).join(""); }
async function textHash(text: string) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, "0")).join(""); }
export { errorMessage };
