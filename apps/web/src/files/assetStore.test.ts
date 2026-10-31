import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { clearAllFileAssets, getFileAsset, listFileAssets, putFileBatch, removeFileAssets, removeCanvasFileAssets, type FileAsset } from "./assetStore";

const make = (index: number, bytes = 10_000_000, canvasId = "space"): FileAsset => ({ canvasId, fileId: `file_${index}`, name: `note${index}.txt`, mediaType: "text/plain", sizeBytes: bytes, sha256: String(index).padStart(64, "0"), blob: new Blob([new Uint8Array(bytes)]), text: "原始文字", parseStatus: "ready", createdAt: "2026-10-24T00:00:00Z" });
afterEach(() => clearAllFileAssets());
describe("file original storage and per-space atomic capacity", () => {
  it("removes every original of a permanently deleted Space without touching another Space", async () => {
    await putFileBatch("space", [make(1, 5), make(2, 5)]);
    await putFileBatch("other", [make(1, 5, "other")]);
    await removeCanvasFileAssets("space");
    expect(await listFileAssets("space")).toEqual([]);
    expect(await listFileAssets("other")).toHaveLength(1);
    expect(await getFileAsset("other", "file_1")).toMatchObject({ sizeBytes: 5 });
  });
  it("accepts exactly 10 MB per batch, rejects > 5 and excess bytes without reserving anything", async () => {
    await expect(putFileBatch("space", [make(1, 10_000_001)])).rejects.toThrow("10 MB");
    await expect(putFileBatch("space", Array.from({ length: 6 }, (_, i) => make(i, 1)))).rejects.toThrow("5 个");
    expect(await listFileAssets("space")).toEqual([]);
    await putFileBatch("space", [make(1)]);
    expect((await listFileAssets("space"))[0]!.sizeBytes).toBe(10_000_000);
  });
  it("deduplicates repeated content, preserves original bytes and isolates spaces", async () => {
    const original = make(1, 5), first = await putFileBatch("space", [original]);
    expect(first.addedIds).toEqual(["file_1"]);
    const repeat = await putFileBatch("space", [original, original]);
    expect(repeat.addedIds).toEqual([]); expect(repeat.assets).toHaveLength(2);
    expect(await listFileAssets("space")).toHaveLength(1);
    expect(await getFileAsset("foreign", "file_1")).toBeUndefined();
    const saved = await getFileAsset("space", "file_1");
    expect(new Uint8Array(await saved!.blob.arrayBuffer())).toEqual(new Uint8Array(5));
    await putFileBatch("foreign", [make(1, 5, "foreign")]);
    await removeFileAssets("space", ["file_1"]);
    expect(await getFileAsset("foreign", "file_1")).toBeDefined();
  });
  it("serializes simultaneous batches at 100 MB and aborts the entire overflowing batch", async () => {
    for (let i = 0; i < 9; i++) await putFileBatch("space", [make(i)]);
    const result = await Promise.allSettled([putFileBatch("space", [make(10, 6_000_000)]), putFileBatch("space", [make(11, 6_000_000)])]);
    expect(result.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect((await listFileAssets("space")).reduce((sum, asset) => sum + asset.sizeBytes, 0)).toBe(96_000_000);
    await expect(putFileBatch("space", [make(12, 2_000_000), make(13, 3_000_000)])).rejects.toThrow("100 MB");
    expect(await getFileAsset("space", "file_12")).toBeUndefined();
    expect(await getFileAsset("space", "file_13")).toBeUndefined();
  });
});
