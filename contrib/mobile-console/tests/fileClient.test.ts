import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFileClient } from "../fileClient";
import { FILE_CHUNK_BYTES, MAX_FRAME_BYTES, parseFrame, type CanvasSnapshot, type Frame, type Welcome } from "../protocol";

function setup(bytes = new Uint8Array(50_000).fill(65)) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const welcome: Welcome = { v: 1, type: "welcome", sessionId: "session", deviceId: "phone", computerId: "computer", epoch: "epoch", expiresAt: Date.now() + 60000, permissions: ["file.read"], token: "test-only-file-read-token" };
  const snapshot: CanvasSnapshot = { computerName: "TEST", ownerAvailable: true, ownerEpoch: "owner", activeCanvasId: "space", version: 2, canvases: [{ id: "space", title: "Space", version: 2 }], cards: [{ id: "card", type: "FileCard", title: "test.txt", pinned: false, file: { name: "test.txt", mediaType: "text/plain", sizeBytes: bytes.length, sha256, parseStatus: "ready" } }] };
  const sent: Frame[] = [];
  const client = createFileClient({ context: () => ({ welcome, snapshot, deviceId: "phone" }), send: frame => { sent.push(frame); return true; }, now: Date.now, minimumChunkDelayMs: 0 });
  const chunk = (patch: Partial<Extract<Frame, { type: "file.chunk" }>> = {}): Frame => {
    const req = sent.at(-1) as Extract<Frame, { type: "file.request" }>;
    return { v: 1, type: "file.chunk", sessionId: "session", epoch: "epoch", deviceId: "computer", forDeviceId: "phone", requestId: req.requestId, cardId: "card", offset: req.offset,
      chunk: { data: Buffer.from(bytes.slice(req.offset, req.offset + FILE_CHUNK_BYTES)).toString("base64"), totalBytes: bytes.length, sha256, name: "test.txt", mediaType: "text/plain" }, ...patch };
  };
  return { client, bytes, sha256, sent, chunk, welcome, snapshot };
}
describe("phone bounded original download", () => {
  it.each(["owner", "canvas", "version", "hash", "permission"])("rejects an in-flight final chunk after %s changes", async change => {
    const value = setup(new Uint8Array([1, 2, 3]));
    const result = value.client.read("card"); const frame = value.chunk();
    if (change === "owner") value.snapshot.ownerEpoch = "replacement-owner";
    if (change === "canvas") value.snapshot.activeCanvasId = "different-space";
    if (change === "version") value.snapshot.version++;
    if (change === "hash") value.snapshot.cards[0]!.file!.sha256 = "f".repeat(64);
    if (change === "permission") value.welcome.permissions = [];
    value.client.receive(frame);
    await expect(result).rejects.toThrow("会话已变化");
  });
  it("rechecks scope after asynchronous digest and cancels invalidating snapshots immediately", async () => {
    const a = setup(new Uint8Array([1, 2, 3])), pending = a.client.read("card");
    a.client.receive(a.chunk()); a.snapshot.ownerEpoch = "replacement-owner";
    await expect(pending).rejects.toThrow("会话已变化");
    const b = setup(), pendingSnapshot = b.client.read("card"); b.snapshot.version++; b.client.reconcile();
    await expect(pendingSnapshot).rejects.toThrow("会话已变化");
  });
  it("pulls one chunk at a time under the frame limit and returns only fully checksum-verified bytes", async () => {
    const { client, bytes, sent, chunk } = setup();
    const downloaded = client.read("card");
    for (let i = 0; i < 4; i++) {
      const frame = chunk(); expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(MAX_FRAME_BYTES);
      expect(parseFrame(frame)).not.toBeNull(); expect(client.receive(frame)).toBe(true);
    }
    const file = await downloaded;
    expect(file.bytes).toEqual(bytes); expect(sent).toHaveLength(4);
    expect(sent.every(frame => frame.type === "file.request")).toBe(true);
  });
  it("rejects wrong offsets and checksums, and cancels revoked or aborted reads", async () => {
    const a = setup(); const read = a.client.read("card"); a.client.receive(a.chunk({ offset: 9 })); await expect(read).rejects.toThrow("分段响应");
    const b = setup(new Uint8Array([1, 2, 3])); const wrong = b.client.read("card"); const frame = b.chunk() as Extract<Frame, { type: "file.chunk" }>;
    frame.chunk.data = Buffer.from([3, 2, 1]).toString("base64"); b.client.receive(frame); await expect(wrong).rejects.toThrow("完整性");
    const c = setup(); const abort = new AbortController(), pending = c.client.read("card", undefined, abort.signal); abort.abort(); await expect(pending).rejects.toThrow("取消");
    const d = setup(); const revoked = d.client.read("card"); d.client.cancel("revoked"); await expect(revoked).rejects.toThrow("revoked");
  });
  it("refuses reads without the explicit file grant and ignores cross-device responses", async () => {
    const a = setup(); a.welcome.permissions = ["card.pin"]; await expect(a.client.read("card")).rejects.toThrow("不可下载"); expect(a.sent).toHaveLength(0);
    const b = setup(); const file = b.client.read("card"); expect(b.client.receive(b.chunk({ forDeviceId: "other" }))).toBe(false); b.client.cancel("stopped"); await expect(file).rejects.toThrow("stopped");
  });
});
