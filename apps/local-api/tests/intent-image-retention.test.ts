import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp, { type Sharp } from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_LIMITS, NewsCardSchema, type Action, type CardRecord } from "@vivic/contracts";
import { createHostedAssetService } from "../src/hosted/assets.js";
import { HostedSpaceStore, type SpaceIdentity } from "../src/space/store.js";
import { imageAnalysisContract } from "../src/cards/imageAnalysis.js";
import type { CardBuildContext } from "../src/cards/types.js";
import { ImageAttachmentSchema, MAX_IMAGE_BYTES, type Attachment } from "../src/images.js";
import { pngChunk, testPng } from "./images.fixture.js";

const stamp = new Date("2026-10-29T10:00:00Z");
const stores: HostedSpaceStore[] = [], folders: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.dispose();
  for (const folder of folders.splice(0)) {
    const absolute = fs.realpathSync(folder);
    expect(path.dirname(absolute)).toBe(fs.realpathSync(tmpdir()));
    expect(path.basename(absolute)).toMatch(/^vivic-intent-image-/);
    fs.rmSync(absolute, { recursive: true, force: true });
  }
});

const attachment = (bytes = testPng(2, 1, true)): Attachment => ({ type: "image", mime: "image/png", data: bytes.toString("base64") });
const context = (trustedImageRef?: string): CardBuildContext => ({
  canvasId: "test-space", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory: [], cards: [], ...(trustedImageRef === undefined ? {} : { trustedImageRef }),
});
const slots = { headline: "图中有两块色彩", summary: "图片展示蓝色与橙色像素。", keyPoints: ["蓝色在左", "橙色在右"] };
const fixture = async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "vivic-intent-image-")); folders.push(dir);
  const store = new HostedSpaceStore({ dataDir: dir, inviteCode: "test-image-invitation", now: () => stamp.getTime() }); stores.push(store);
  const { identity } = await store.register({ invite: "test-image-invitation", username: "test_image", password: "test-image-password" });
  const accountId = identity.accountId, deviceId = identity.device.id, spaceId = store.listSpaces(accountId)[0]!.id;
  const assets = createHostedAssetService({ store, dataDir: dir, now: () => stamp.getTime() });
  const persist = (input = attachment(), signal?: AbortSignal) => assets.persistIntentImage(accountId, spaceId, input, deviceId, signal);
  return { dir, store, identity, accountId, deviceId, spaceId, assets, persist };
};
type Fixture = Awaited<ReturnType<typeof fixture>>;
const binaryFiles = (dir: string) => fs.readdirSync(path.join(dir, "assets"), { recursive: true }).filter(name => String(name).endsWith(".bin"));
const apply = (f: Fixture, actions: Action[], spaceId = f.spaceId) => {
  const requestId = randomUUID();
  return f.store.applyEnvelope(f.accountId, spaceId, { requestId, expectedVersion: f.store.getSnapshot(f.accountId, spaceId).space.version,
    envelope: { schemaVersion: "0.6", requestId, canvasId: spaceId, actions } }, f.deviceId);
};
const build = async (ref: string) => {
  const result = await imageAnalysisContract.build(slots, context(ref), stamp);
  if (!Array.isArray(result)) throw new Error("TEST expected actions");
  return result;
};
function quota(f: Fixture, sizeBytes: number) {
  const sha256 = "f".repeat(64), id = `file_${sha256}`;
  // Synthetic existing index entry tests accounting without allocating a 100MB fixture.
  f.store.setAccountValue(f.accountId, `assets:${f.spaceId}`, { ...f.store.getAccountValue(f.accountId, `assets:${f.spaceId}`) as object,
    [id]: { id, sha256, sizeBytes, kind: "file", name: "TEST-quota.md", mediaType: "text/markdown", text: "",
      parseStatus: "empty", createdAt: stamp.toISOString() } });
}

describe("explicit intent image retention", () => {
  it("retains a verified image in its account and space, strips metadata and survives restart", async () => {
    const f = await fixture(), before = f.store.getSnapshot(f.accountId, f.spaceId);
    const ref = await f.persist();
    expect(ref).toMatch(/^media:image_[a-f0-9]{64}$/);
    const asset = f.assets.get(f.accountId, f.spaceId, ref.slice(6)), bytes = f.assets.bytesFor(f.accountId, f.spaceId, asset);
    expect(asset).toMatchObject({ kind: "image", mediaType: "image/webp", width: 2, height: 1, text: "", createdAt: stamp.toISOString() });
    expect(ref).toBe(`media:image_${createHash("sha256").update(bytes).digest("hex")}`);
    const metadata = await sharp(bytes).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 2, height: 1 });
    expect(metadata.exif).toBeUndefined(); expect(metadata.xmp).toBeUndefined();
    expect(Buffer.from(bytes).includes(Buffer.from("TEST_PRIVATE_METADATA"))).toBe(false);
    expect(f.store.getSnapshot(f.accountId, f.spaceId)).toEqual(before);
    expect(binaryFiles(f.dir)).toHaveLength(1);
    const content = await f.assets.handle(new Request(`https://unit.test/api/space/spaces/${f.spaceId}/assets/${asset.id}/content`), f.identity);
    expect(content!.status).toBe(200); expect(content!.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await content!.arrayBuffer())).toEqual(bytes);
    f.store.dispose();
    const store = new HostedSpaceStore({ dataDir: f.dir, now: () => stamp.getTime() }); stores.push(store);
    const reopened = createHostedAssetService({ store, dataDir: f.dir });
    expect(reopened.get(f.accountId, f.spaceId, asset.id)).toEqual(asset);
    expect(reopened.bytesFor(f.accountId, f.spaceId, asset)).toEqual(bytes);
  });

  it("deduplicates concurrent uploads and the existing photos path without additional quota", async () => {
    const f = await fixture(), [first, second] = await Promise.all([f.persist(), f.persist()]);
    expect(first).toBe(second);
    const form = new FormData(); form.append("files", new File([new Uint8Array(testPng(2, 1, true))], "TEST.png", { type: "image/png" }));
    const response = await f.assets.handle(new Request(`https://unit.test/api/space/spaces/${f.spaceId}/photos`, { method: "POST", body: form }), f.identity);
    expect(await response!.json()).toMatchObject({ images: [{ src: first, width: 2, height: 1 }] });
    const asset = f.assets.list(f.accountId, f.spaceId)[0]!;
    quota(f, FILE_LIMITS.spaceBytes - asset.sizeBytes);
    expect(await f.persist()).toBe(first);
    expect(f.assets.list(f.accountId, f.spaceId)).toHaveLength(2);
    expect(binaryFiles(f.dir)).toHaveLength(1);
  });

  it("rejects new images beyond space capacity without adding bytes or an index entry", async () => {
    const f = await fixture(); quota(f, FILE_LIMITS.spaceBytes);
    await expect(f.persist()).rejects.toMatchObject({ code: "space-quota", status: 413 });
    expect(f.assets.list(f.accountId, f.spaceId)).toHaveLength(1);
    expect(binaryFiles(f.dir)).toHaveLength(0);
  });

  it("rolls back physical writes and the index when the asset transaction fails", async () => {
    const f = await fixture();
    vi.spyOn(f.store, "setAccountValue").mockImplementationOnce(() => { throw new Error("TEST index failure"); });
    await expect(f.persist()).rejects.toThrow("TEST index failure");
    expect(f.assets.list(f.accountId, f.spaceId)).toEqual([]);
    expect(binaryFiles(f.dir)).toHaveLength(0);
    expect(await f.persist()).toMatch(/^media:image_/);
  });

  it("does not bless a corrupt duplicate or bypass a pending asset deletion", async () => {
    const f = await fixture(), ref = await f.persist(), asset = f.assets.get(f.accountId, f.spaceId, ref.slice(6));
    fs.writeFileSync(f.assets.physical(f.accountId, f.spaceId, asset), Buffer.from("TEST corrupt bytes"));
    await expect(f.persist()).rejects.toMatchObject({ code: "asset-integrity" });
    f.store.setAccountValue(f.accountId, `asset-deletions:${f.spaceId}`, { [asset.id]: {
      id: asset.id, sha256: asset.sha256, sizeBytes: asset.sizeBytes, requestedAt: stamp.toISOString(),
    } });
    await expect(f.persist()).rejects.toMatchObject({ code: "asset-deletion-pending" });
  });

  it.each(["png", "jpeg", "webp"] as const)("accepts real static %s pixels through the existing validation gate", async format => {
    const f = await fixture(), bytes = await sharp(testPng()).toFormat(format).toBuffer();
    const ref = await f.persist({ type: "image", mime: `image/${format}`, data: bytes.toString("base64") });
    expect(f.assets.get(f.accountId, f.spaceId, ref.slice(6))).toMatchObject({ kind: "image", width: 2, height: 1 });
  });

  it("rejects corrupt compressed pixels even when structure and metadata pass", async () => {
    const f = await fixture(), bytes = testPng(), offset = 33, length = bytes.readUInt32BE(offset);
    const corrupt = Buffer.concat([bytes.subarray(0, offset), pngChunk("IDAT", Buffer.alloc(length, 255)), bytes.subarray(offset + length + 12)]);
    expect(ImageAttachmentSchema.safeParse(attachment(corrupt)).success).toBe(true);
    expect((await sharp(corrupt).metadata()).width).toBe(2);
    await expect(f.persist(attachment(corrupt))).rejects.toThrow("图片无法解码");
    expect(f.assets.list(f.accountId, f.spaceId)).toEqual([]); expect(binaryFiles(f.dir)).toEqual([]);
  });

  it("rejects CRC damage, MIME spoofing, oversized headers/bytes, URL and historical media references", async () => {
    const f = await fixture(), crc = testPng(); crc[crc.length - 1] ^= 1;
    const invalid: unknown[] = [attachment(crc), { ...attachment(), mime: "image/jpeg" }, attachment(testPng(8193, 1)),
      attachment(testPng(4001, 4000)), attachment(Buffer.alloc(MAX_IMAGE_BYTES + 1)),
      { ...attachment(), data: "https://unit.test/TEST.png" }, { ...attachment(), data: `media:image_${"a".repeat(64)}` },
      { ...attachment(), imageURL: "https://unit.test/TEST.png" }, undefined];
    for (const input of invalid) await expect(f.assets.persistIntentImage(f.accountId, f.spaceId, input as Attachment, f.deviceId)).rejects.toThrow();
    expect(f.assets.list(f.accountId, f.spaceId)).toEqual([]); expect(binaryFiles(f.dir)).toEqual([]);
  });

  it("does not persist an already cancelled request or one cancelled during decode", async () => {
    const f = await fixture(), cancelled = new AbortController(); cancelled.abort();
    await expect(f.persist(attachment(), cancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
    const during = new AbortController(), original = sharp.prototype.metadata;
    vi.spyOn(sharp.prototype, "metadata").mockImplementationOnce(function(this: Sharp) {
      during.abort(); return original.call(this);
    });
    await expect(f.persist(attachment(), during.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.assets.list(f.accountId, f.spaceId)).toEqual([]); expect(binaryFiles(f.dir)).toEqual([]);
  });

  it("rechecks device authorization after asynchronous decoding", async () => {
    const f = await fixture(), original = sharp.prototype.metadata;
    vi.spyOn(sharp.prototype, "metadata").mockImplementationOnce(function(this: Sharp) {
      f.store.revokeDevice(f.accountId, f.deviceId, f.deviceId); return original.call(this);
    });
    await expect(f.persist()).rejects.toMatchObject({ code: "device-revoked", status: 401 });
    expect(f.assets.list(f.accountId, f.spaceId)).toEqual([]); expect(binaryFiles(f.dir)).toEqual([]);
  });

  it("isolates references between spaces and accounts, even when bytes have the same hash", async () => {
    const f = await fixture(), ref = await f.persist(), id = ref.slice(6), firstAsset = f.assets.get(f.accountId, f.spaceId, id);
    const otherSpace = f.store.createSpace(f.accountId, { title: "TEST other space", requestId: "other-space" }, f.deviceId).space.id;
    expect(() => f.assets.get(f.accountId, otherSpace, id)).toThrow();
    const actions = await build(ref);
    expect(() => apply(f, actions, otherSpace)).toThrow();
    const otherRef = await f.assets.persistIntentImage(f.accountId, otherSpace, attachment(), f.deviceId);
    expect(otherRef).toBe(ref);
    expect(f.assets.physical(f.accountId, otherSpace, firstAsset)).not.toBe(f.assets.physical(f.accountId, f.spaceId, firstAsset));
    expect(apply(f, actions, otherSpace).snapshot.space.cards).toHaveLength(1);
    f.store.dispose();
    const store = new HostedSpaceStore({ dataDir: f.dir, inviteCode: "test-other-invitation", now: () => stamp.getTime() }); stores.push(store);
    const { identity: second }: { identity: SpaceIdentity } = await store.register({ invite: "test-other-invitation", username: "test_other", password: "test-other-password" });
    const assets = createHostedAssetService({ store, dataDir: f.dir });
    const secondSpace = store.listSpaces(second.accountId)[0]!.id;
    await expect(assets.persistIntentImage(second.accountId, f.spaceId, attachment(), second.device.id)).rejects.toMatchObject({ code: "space-not-found" });
    await expect(assets.persistIntentImage(f.accountId, f.spaceId, attachment(), second.device.id)).rejects.toMatchObject({ code: "device-revoked" });
    expect(() => assets.get(second.accountId, secondSpace, id)).toThrow();
    const requestId = randomUUID();
    expect(() => store.applyEnvelope(second.accountId, secondSpace, { requestId, expectedVersion: 0,
      envelope: { schemaVersion: "0.6", requestId, canvasId: secondSpace, actions } }, second.device.id)).toThrow();
    expect(await assets.persistIntentImage(second.accountId, secondSpace, attachment(), second.device.id)).toBe(ref);
    expect(assets.physical(second.accountId, secondSpace, firstAsset)).not.toBe(assets.physical(f.accountId, f.spaceId, firstAsset));
  });

  it("saves an analysis NewsCard, protects its image from deletion and restores it through user undo/redo", async () => {
    const f = await fixture(), ref = await f.persist(), actions = await build(ref), result = apply(f, actions);
    const card = result.snapshot.space.cards[0]!;
    expect(card).toMatchObject({ type: "NewsCard", displayProps: { ...slots, image: ref, summaryBy: "ai" }, sources: [], sourceData: {} });
    const command = (value: "history.undo" | "history.redo") => f.store.applyCommand(f.accountId, f.spaceId, {
      requestId: randomUUID(), expectedVersion: f.store.getSnapshot(f.accountId, f.spaceId).space.version, command: { type: value },
    }, f.deviceId);
    const remove = () => f.assets.handle(new Request(`https://unit.test/api/space/spaces/${f.spaceId}/assets/${ref.slice(6)}`, { method: "DELETE" }), f.identity);
    await expect(remove()).rejects.toMatchObject({ code: "asset-in-use" });
    expect(command("history.undo").snapshot.space.cards).toEqual([]);
    await expect(remove()).rejects.toMatchObject({ code: "asset-in-history" });
    expect(command("history.redo").snapshot.space.cards).toEqual([card]);
    expect(() => f.store.applyCommand(f.accountId, f.spaceId, { requestId: randomUUID(), expectedVersion: 3,
      command: { type: "card.update", cardId: card.id, displayProps: { image: "https://unit.test/TEST.png" } } }, f.deviceId)).toThrow("服务结果不可直接修改");
  });

  it("keeps gallery/photo-cover writes restricted to current-space uploaded media", async () => {
    const f = await fixture(), ref = await f.persist(), actions = await build(ref);
    const create = actions[0]; if (create.type !== "card.create") throw new Error("TEST expected card");
    for (const type of ["GalleryCard", "PhotoCoverCard"] as const) {
      const displayProps = type === "GalleryCard" ? { title: "TEST", images: [{ src: "https://unit.test/TEST.png" }] } : { title: "TEST", image: { src: "https://unit.test/TEST.png" } };
      expect(() => apply(f, [{ type: "card.create", card: { ...create.card, id: randomUUID(), type, displayProps } as CardRecord }])).toThrow("只能使用已上传");
    }
    const unowned = `media:image_${"b".repeat(64)}`;
    const forged = { ...create.card, id: randomUUID(), displayProps: { ...slots, image: unowned, summaryBy: "ai" } };
    expect(() => apply(f, [{ type: "card.create", card: NewsCardSchema.parse(forged) }])).toThrow("原件不存在");
  });
});

describe("image analysis contract", () => {
  it("builds a NewsCard with host identity/layout/time and no model image fields", async () => {
    const ref = `media:image_${"a".repeat(64)}`, actions = await build(ref), action = actions[0];
    expect(action.type).toBe("card.create"); if (action.type !== "card.create") return;
    expect(NewsCardSchema.safeParse(action.card).success).toBe(true);
    expect(action.card).toMatchObject({ type: "NewsCard", metadata: { createdAt: stamp.toISOString(), updatedAt: stamp.toISOString() },
      layout: { x: 0, y: 0, width: 380, height: 340, pinned: false }, displayProps: { ...slots, image: ref, summaryBy: "ai" } });
    const next = (await build(ref))[0];
    if (next.type === "card.create") expect(next.card.id).not.toBe(action.card.id);
    expect(imageAnalysisContract.id).toBe("image_analysis");
    expect(imageAnalysisContract.parse).toBeUndefined();
  });

  it("rejects extra model fields, excessive key points and empty analysis", () => {
    for (const key of ["image", "imageURL", "imageUrl", "url", "id", "layout", "metadata", "createdAt", "sourceData", "trustedImageRef"]) {
      expect(imageAnalysisContract.slots.safeParse({ ...slots, [key]: "TEST" }).success).toBe(false);
      expect(() => imageAnalysisContract.build({ ...slots, [key]: "TEST" }, context(`media:image_${"a".repeat(64)}`), stamp)).toThrow();
    }
    for (const invalid of [{ ...slots, keyPoints: Array(6).fill("TEST") }, { ...slots, headline: " " }, { ...slots, summary: " " },
      { ...slots, headline: "x".repeat(201) }, { ...slots, summary: "x".repeat(801) }, { ...slots, keyPoints: ["x".repeat(201)] }]) {
      expect(imageAnalysisContract.slots.safeParse(invalid).success).toBe(false);
    }
    expect(imageAnalysisContract.slots.safeParse({ headline: "TEST", summary: "TEST", keyPoints: Array(5).fill("TEST") }).success).toBe(true);
  });

  it("uses host placement around existing pinned cards and awakens a standby canvas", async () => {
    const ctx = context(`media:image_${"a".repeat(64)}`); ctx.stage = "STANDBY";
    ctx.cards = [{ id: "TEST pinned", type: "NoteCard", displayProps: { text: "TEST" }, sourceDataSummary: {},
      layout: { x: 0, y: 0, width: 400, height: 360, pinned: true } }];
    const original = structuredClone(ctx), actions = await imageAnalysisContract.build(slots, ctx, stamp);
    if (!Array.isArray(actions)) throw new Error("TEST expected actions");
    expect(actions[0]).toEqual({ type: "stage.awaken" });
    const create = actions.find(action => action.type === "card.create");
    expect(create?.card.layout.x).toBeGreaterThanOrEqual(424);
    expect(ctx).toEqual(original);
  });

  it.each([undefined, "", "https://unit.test/TEST.png", `media:file_${"a".repeat(64)}`, "media:image_short"])("rejects absent/invalid trusted image reference %s and never reads historical images", ref => {
    const ctx = context(ref);
    ctx.cards = [{ id: "TEST historical", type: "NewsCard", displayProps: { image: `media:image_${"a".repeat(64)}` }, sourceDataSummary: {}, layout: { x: 0, y: 0 } }];
    expect(() => imageAnalysisContract.build(slots, ctx, stamp)).toThrow("本次请求已留存的可信图片");
  });
});
