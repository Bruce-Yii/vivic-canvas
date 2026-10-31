import "fake-indexeddb/auto";
import { afterEach, expect, it } from "vitest";
import { canvasStore } from "@/state/canvasStore";
import { clearAllFileAssets, putFileBatch, removeFileAssets } from "./assetStore";
import { createRemoteFileReader } from "./remoteFiles";

afterEach(async () => { await clearAllFileAssets(); canvasStore.reset(); });
it("never reuses cached original bytes after permanent cleanup followed by a card restore", async () => {
  const props = { fileId: "file_test", name: "test.txt", sizeBytes: 4, mediaType: "text/plain" as const, sha256: "a".repeat(64), parseStatus: "ready" as const };
  await putFileBatch("space", [{ ...props, canvasId: "space", text: "test", blob: new Blob(["test"]), createdAt: "2026-10-24T00:00:00Z" }]);
  expect(canvasStore.dispatch({ schemaVersion: "0.6", requestId: "seed-file", canvasId: "space", actions: [{ type: "card.create", card: { id: "card", type: "FileCard", variant: "standard", displayProps: props, sources: [], sourceData: {}, layout: { x: 0, y: 0, width: 320, height: 200, pinned: false }, metadata: { createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z" } } }] }).ok).toBe(true);
  const read = createRemoteFileReader();
  expect((await read("space", "card", 0)).data).toBe("dGVzdA==");
  // The restored card has the same ID/file metadata, but the original is gone.
  await removeFileAssets("space", ["file_test"]);
  await expect(read("space", "card", 0)).rejects.toThrow("file_unavailable");
});
