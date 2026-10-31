import { FILE_CHUNK_BYTES, type FileChunkData } from "@vivic/mobile-console-prototype/protocol";
import { canvasStore } from "@/state/canvasStore";
import { getFileAsset, hasFileAsset, type FileAsset } from "./assetStore";

/** Bounded one-original cache; each chunk still checks the active owner card and lease. */
export function createRemoteFileReader() {
  let cached: FileAsset | undefined, expires = 0;
  return async (canvasId: string, cardId: string, offset: number): Promise<FileChunkData> => {
    const card = canvasStore.getState().cards.find(entry => !entry.exitingRequestId && entry.record.id === cardId)?.record;
    if (card?.type !== "FileCard") throw new Error("file_not_found");
    const props = card.displayProps;
    // A retained Blob must never resurrect a permanently cleaned original,
    // including a cleanup made in another tab followed by a card undo.
    if (!await hasFileAsset(canvasId, props.fileId)) { cached = undefined; throw new Error("file_unavailable"); }
    if (!cached || cached.canvasId !== canvasId || cached.fileId !== props.fileId || Date.now() >= expires) {
      cached = await getFileAsset(canvasId, props.fileId); expires = Date.now() + 60_000;
    }
    const asset = cached;
    if (!asset || asset.sha256 !== props.sha256 || asset.blob.size !== props.sizeBytes || offset < 0 || offset > asset.sizeBytes || !Number.isSafeInteger(offset)) throw new Error("file_unavailable");
    const bytes = new Uint8Array(await asset.blob.slice(offset, offset + FILE_CHUNK_BYTES).arrayBuffer());
    return { data: btoa(String.fromCharCode(...bytes)), totalBytes: asset.sizeBytes, sha256: asset.sha256, name: asset.name, mediaType: asset.mediaType };
  };
}
