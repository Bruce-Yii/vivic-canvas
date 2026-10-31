import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { FILE_LIMITS, FileCardSchema, type CardRecord, type SceneImage } from "@vivic/contracts";
import type { HostedSpaceStore, SpaceIdentity } from "../space/store.js";
import { hostedImageSources } from "../space/executor.js";
import { SpaceError } from "../space/errors.js";
import { validateImageAttachment, type Attachment } from "../images.js";
import { decodeImage } from "../imageDecoder.js";
import { boundedBytes, hostedBody, hostedForm, hostedJson } from "./http.js";

export interface HostedAsset {
  id: string; kind: "file" | "image"; name: string; mediaType: string; sizeBytes: number; sha256: string;
  text: string; parseStatus: "ready" | "partial" | "empty" | "unsupported" | "error"; createdAt: string;
  pageCount?: number; width?: number; height?: number;
}
type AssetIndex = Record<string, HostedAsset>;
type IncomingImage = { asset: HostedAsset; bytes: Uint8Array };
const Deletions = z.record(z.string().regex(/^(?:file|image)_[a-f0-9]{64}$/), z.strictObject({
  id: z.string().regex(/^(?:file|image)_[a-f0-9]{64}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.int().min(0), requestedAt: z.iso.datetime(),
}));
type DeleteIntents = z.infer<typeof Deletions>;
const Manifest = z.array(z.strictObject({ name: z.string().trim().min(1).max(240).regex(/^[^\p{Cc}]+$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().max(FILE_LIMITS.textChars),
  parseStatus: z.enum(["ready", "partial", "empty", "unsupported", "error"]), pageCount: z.int().positive().max(100000).optional() })).min(1).max(FILE_LIMITS.count);
const Write = z.strictObject({ requestId: z.string().min(1).max(128), expectedVersion: z.int().min(0) });
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const assetKey = (spaceId: string) => `assets:${spaceId}`;
const receiptKey = (spaceId: string, requestId: string) => `asset-upload:${spaceId}:${requestId}`;
const deletionKey = (spaceId: string) => `asset-deletions:${spaceId}`;
function fail(status: number, code: string, message: string): never { throw new SpaceError(status, code, message); }

export function createHostedAssetService(options: { store: HostedSpaceStore; dataDir: string; now?: () => number }) {
  const { store } = options, now = options.now ?? Date.now;
  const root = path.resolve(options.dataDir, "assets"); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const physicalWrites: string[][] = [];
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Asset root cannot be a link");
  const index = (accountId: string, spaceId: string): AssetIndex => {
    store.getSnapshot(accountId, spaceId);
    return store.getAccountValue<AssetIndex>(accountId, assetKey(spaceId)) ?? {};
  };
  const physical = (accountId: string, spaceId: string, asset: HostedAsset) => {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("Invalid stored asset hash");
    return path.join(root, hash(`${accountId}\n${spaceId}`), `${asset.sha256}.bin`);
  };
  const pending = (accountId: string, spaceId: string): DeleteIntents => {
    const value = Deletions.safeParse(store.getAccountValue(accountId, deletionKey(spaceId)) ?? {});
    if (!value.success || Object.entries(value.data).some(([id, intent]) => intent.id !== id || !id.endsWith(`_${intent.sha256}`)))
      fail(503, "asset-delete-inconsistent", "原件删除日志需要检查，未释放容量或删除文件。");
    return value.data;
  };
  const assertNotDeleting = (accountId: string, spaceId: string, id: string) => {
    if (pending(accountId, spaceId)[id]) fail(409, "asset-deletion-pending", "此原件正在删除，请先重试原删除操作或等待服务恢复。");
  };
  const assertShaNotDeleting = (accountId: string, spaceId: string, sha256: string) => {
    if (Object.values(pending(accountId, spaceId)).some(intent => intent.sha256 === sha256))
      fail(409, "asset-deletion-pending", "相同原件的删除尚未完成，请先重试删除，再重新上传。");
  };
  function assertDeleteAllowed(accountId: string, spaceId: string, asset: HostedAsset) {
    const cards = store.getSnapshot(accountId, spaceId).space.cards;
    if (cards.some(card => card.type === "FileCard" && card.displayProps.fileId === asset.id
      || hostedImageSources(card).includes(`media:${asset.id}`))) fail(409, "asset-in-use", "原件仍被卡片使用，请先删除引用卡片。");
    if (store.hasAssetHistoryReference(accountId, spaceId, asset.id))
      fail(409, "asset-in-history", "可撤销记录仍引用此原件，已保留以便恢复。请稍后再清理。");
    for (const { value } of store.iterateAccountValues(accountId, `migration:${spaceId}:`)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) fail(503, "migration-inconsistent", "迁移记录需要检查，未删除原件。");
      const migration = value as { state?: unknown; requirements?: unknown };
      if (migration.state === "succeeded") continue;
      if (migration.state !== "staging" || !Array.isArray(migration.requirements)) fail(503, "migration-inconsistent", "迁移记录需要检查，未删除原件。");
      for (const item of migration.requirements) {
        if (!item || typeof item !== "object" || Array.isArray(item)) fail(503, "migration-inconsistent", "迁移原件记录需要检查，未删除原件。");
        const required = item as { asset?: { id?: unknown; sha256?: unknown }; expected?: { sha256?: unknown } };
        if (required.asset?.id === asset.id || required.asset?.sha256 === asset.sha256 || required.expected?.sha256 === asset.sha256)
          fail(409, "asset-in-migration", "未完成的迁移仍引用此原件，请先完成迁移，暂不能清理。");
      }
    }
  }
  function syncParent(directory: string) {
    // Same platform policy as persistBytes: Node cannot fsync a Windows directory.
    if (process.platform === "win32") return;
    const descriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  }
  function finishDeletion(accountId: string, spaceId: string, id: string, deviceId?: string) {
    return store.transaction(() => {
      if (deviceId) store.assertDeviceActive(accountId, deviceId);
      const intents = pending(accountId, spaceId), intent = intents[id], assets = index(accountId, spaceId), asset = assets[id];
      if (!intent) { if (!asset) return; fail(503, "asset-delete-inconsistent", "缺少原件删除意图，未删除文件。"); }
      if (!asset || asset.sha256 !== intent.sha256 || asset.sizeBytes !== intent.sizeBytes)
        fail(503, "asset-delete-inconsistent", "原件与删除日志不一致，未释放容量。");
      assertDeleteAllowed(accountId, spaceId, asset);
      if (!Object.values(assets).some(other => other.id !== id && other.sha256 === asset.sha256)) {
        const filename = physical(accountId, spaceId, asset), directory = path.dirname(filename);
        if (fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(directory).isSymbolicLink()) fail(503, "asset-delete-path", "原件目录需要检查，未删除文件。");
        let info: fs.Stats | undefined;
        try { info = fs.lstatSync(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (info) {
          if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.sizeBytes || hash(fs.readFileSync(filename)) !== asset.sha256)
            fail(503, "asset-integrity", "原件完整性校验失败，未删除文件或释放容量。");
          const descriptor = fs.openSync(filename, "r+");
          try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
          fs.unlinkSync(filename);
        }
        // A missing byte file is accepted only for a previously committed deletion intent.
        syncParent(directory);
      }
      delete assets[id]; delete intents[id];
      store.setAccountValue(accountId, assetKey(spaceId), assets);
      if (Object.keys(intents).length) store.setAccountValue(accountId, deletionKey(spaceId), intents);
      else store.deleteAccountValue(accountId, deletionKey(spaceId));
    });
  }
  function remove(accountId: string, spaceId: string, id: string, deviceId: string) {
    if (!/^(?:file|image)_[a-f0-9]{64}$/.test(id)) fail(404, "asset-not-found", "原件不存在或不属于此空间。");
    const exists = store.transaction(() => {
      store.assertDeviceActive(accountId, deviceId);
      const assets = index(accountId, spaceId), asset = assets[id], intents = pending(accountId, spaceId);
      if (!asset) { if (intents[id]) fail(503, "asset-delete-inconsistent", "删除日志与资产索引不一致，请检查恢复状态。"); return false; }
      assertDeleteAllowed(accountId, spaceId, asset);
      if (!intents[id]) {
        intents[id] = { id, sha256: asset.sha256, sizeBytes: asset.sizeBytes, requestedAt: new Date(now()).toISOString() };
        store.setAccountValue(accountId, deletionKey(spaceId), intents);
      }
      return true;
    });
    if (exists) finishDeletion(accountId, spaceId, id, deviceId);
    return hostedJson({ ok: true, deleted: true });
  }
  function assetTransaction<T>(body: () => T): T {
    const created: string[] = []; physicalWrites.push(created);
    try { return store.transaction(body); }
    catch (error) {
      // These files were created by this synchronous transaction and never acquired an indexed owner.
      for (const filename of created) try {
        if (filename.startsWith(root + path.sep) && fs.lstatSync(filename).isFile() && !fs.lstatSync(filename).isSymbolicLink()) fs.unlinkSync(filename);
      } catch { /* Startup recovery can report a filesystem that cannot be cleaned. */ }
      throw error;
    } finally { physicalWrites.pop(); }
  }
  function persistBytes(accountId: string, spaceId: string, asset: HostedAsset, bytes: Uint8Array) {
    assertShaNotDeleting(accountId, spaceId, asset.sha256);
    const target = physical(accountId, spaceId, asset), directory = path.dirname(target);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Asset directory cannot be a link");
    if (fs.existsSync(target)) {
      if (fs.lstatSync(target).isSymbolicLink() || hash(fs.readFileSync(target)) !== asset.sha256) throw new Error("Stored asset differs");
      return;
    }
    const temporary = `${target}.${randomUUID()}.tmp`, descriptor = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    try { fs.renameSync(temporary, target); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    physicalWrites.at(-1)?.push(target);
    if (process.platform !== "win32") {
      const directoryDescriptor = fs.openSync(directory, "r");
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    }
  }
  function get(accountId: string, spaceId: string, id: string): HostedAsset {
    if (!/^(?:file|image)_[a-f0-9]{64}$/.test(id)) fail(404, "asset-not-found", "原件不存在或不属于此空间。");
    const asset = index(accountId, spaceId)[id];
    if (!asset) fail(404, "asset-not-found", "原件不存在或不属于此空间。");
    assertNotDeleting(accountId, spaceId, id);
    return asset;
  }
  function bytesFor(accountId: string, spaceId: string, asset: HostedAsset): Uint8Array {
    assertNotDeleting(accountId, spaceId, asset.id);
    const filename = physical(accountId, spaceId, asset);
    if (!fs.existsSync(filename) || fs.lstatSync(filename).isSymbolicLink()) fail(404, "asset-unavailable", "原件暂不可用，请重试或恢复备份。");
    const bytes = fs.readFileSync(filename);
    if (bytes.byteLength !== asset.sizeBytes || hash(bytes) !== asset.sha256) fail(503, "asset-integrity", "原件完整性校验失败，未提供内容。");
    return new Uint8Array(bytes);
  }
  function validateCardImages(accountId: string, spaceId: string, card: CardRecord): CardRecord {
    const controlled = card.type === "GalleryCard" || card.type === "PhotoCoverCard";
    const checked = new Map<string, HostedAsset>();
    let owned: AssetIndex | undefined;
    for (const source of hostedImageSources(card)) {
      if (!source.startsWith("media:")) {
        // Existing model-sourced News/Story/Book/Link images keep their schema-defined HTTPS semantics.
        // Gallery/PhotoCover are user-upload surfaces and accept no external URL or path, even in an envelope.
        if (controlled) fail(400, "controlled-image-required", "图库和照片卡只能使用已上传到当前Space的图片。");
        continue;
      }
      if (!/^media:image_[a-f0-9]{64}$/.test(source)) fail(400, "invalid-image-reference", "图片需要当前Space的受控原件编号。");
      if (checked.has(source)) continue;
      owned ??= index(accountId, spaceId);
      const asset = owned[source.slice("media:".length)];
      if (!asset) fail(404, "asset-not-found", "原件不存在或不属于此空间。");
      if (asset.kind !== "image" || !asset.mediaType.startsWith("image/") || !asset.width || !asset.height) fail(400, "invalid-image-reference", "此原件不是可用图片。");
      bytesFor(accountId, spaceId, asset); checked.set(source, asset);
    }
    const image = (value: SceneImage): SceneImage => {
      const asset = checked.get(value.src);
      return asset ? { ...value, width: asset.width!, height: asset.height! } : value;
    };
    if (card.type === "GalleryCard") return { ...card, displayProps: { ...card.displayProps, images: card.displayProps.images.map(image) } };
    if (card.type === "PhotoCoverCard" && card.displayProps.image) return { ...card, displayProps: { ...card.displayProps, image: image(card.displayProps.image) } };
    return card;
  }
  store.setCardAssetValidator(validateCardImages);
  async function upload(request: Request, identity: SpaceIdentity, spaceId: string) {
    const form = await hostedForm(request, FILE_LIMITS.batchBytes + 1_000_000);
    const parsedWrite = Write.safeParse({ requestId: form.get("requestId"), expectedVersion: Number(form.get("expectedVersion")) });
    if (!parsedWrite.success) fail(400, "invalid-upload", "上传编号或版本无效。");
    const write = parsedWrite.data, files = form.getAll("files");
    if (!files.length || files.length > FILE_LIMITS.count || files.some(value => !(value instanceof File))) fail(400, "upload-count", "每次最多5个文件，合计不超过10MB。");
    const selected = files as File[];
    if (selected.reduce((sum, file) => sum + file.size, 0) > FILE_LIMITS.batchBytes) fail(413, "upload-size", "每次最多5个文件，合计不超过10MB。");
    let manifest: z.infer<typeof Manifest>;
    try { manifest = Manifest.parse(JSON.parse(String(form.get("manifest") ?? "[]"))); }
    catch { fail(400, "upload-manifest", "文件清单无效。"); }
    if (manifest!.length !== selected.length) fail(400, "upload-manifest", "文件清单不完整。");
    const incoming: Array<{ asset: HostedAsset; bytes: Uint8Array }> = [];
    for (let i = 0; i < selected.length; i++) {
      const file = selected[i]!, meta = manifest![i]!, extension = meta.name.split(".").pop()?.toLowerCase();
      if (file.name !== meta.name || !["pdf", "md"].includes(extension ?? "")) fail(400, "file-type", "新上传仅支持PDF和Markdown。");
      const bytes = new Uint8Array(await file.arrayBuffer()), sha256 = hash(bytes);
      if (sha256 !== meta.sha256) fail(400, "upload-integrity", "文件哈希不一致，请重新选择原件。");
      if (extension === "pdf" && !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-"))) fail(400, "file-type", "PDF格式无效。");
      let text = meta.text, parseStatus = meta.parseStatus;
      if (extension === "md") {
        try { const full = new TextDecoder("utf-8", { fatal: true }).decode(bytes); text = full.slice(0, FILE_LIMITS.textChars); parseStatus = full.length > text.length ? "partial" : text.trim() ? "ready" : "empty"; }
        catch { fail(400, "file-encoding", "Markdown需要有效UTF-8编码。"); }
      }
      incoming.push({ bytes, asset: { id: `file_${sha256}`, kind: "file", name: meta.name,
        mediaType: extension === "pdf" ? "application/pdf" : "text/markdown", sizeBytes: bytes.byteLength, sha256,
        text, parseStatus, ...(meta.pageCount ? { pageCount: meta.pageCount } : {}), createdAt: new Date(now()).toISOString() } });
    }
    request.signal.throwIfAborted();
    const fingerprint = hash(JSON.stringify({ expectedVersion: write.expectedVersion, assets: incoming.map(({ asset }) => ({ sha256: asset.sha256, name: asset.name })) }));
    return assetTransaction(() => {
      store.assertDeviceActive(identity.accountId, identity.device.id);
      for (const item of incoming) assertShaNotDeleting(identity.accountId, spaceId, item.asset.sha256);
      const previous = store.getAccountValue<{ fingerprint: string; ids: string[] }>(identity.accountId, receiptKey(spaceId, write.requestId));
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail(409, "request-id-conflict", "这个上传编号已用于其他内容。");
        return hostedJson({ ok: true, deduplicated: true, snapshot: store.getSnapshot(identity.accountId, spaceId), assets: previous.ids.map(id => get(identity.accountId, spaceId, id)) });
      }
      const snapshot = store.getSnapshot(identity.accountId, spaceId);
      if (snapshot.space.version !== write.expectedVersion) fail(409, "version-conflict", "空间已变化，请检查最新内容后重新上传。");
      const assets = index(identity.accountId, spaceId), result: HostedAsset[] = [], cards: CardRecord[] = [];
      let size = Object.values(assets).reduce((sum, asset) => sum + asset.sizeBytes, 0);
      const planned = new Set(Object.keys(assets));
      for (const { asset } of incoming) if (!planned.has(asset.id)) { size += asset.sizeBytes; planned.add(asset.id); }
      if (size > FILE_LIMITS.spaceBytes) fail(413, "space-quota", "Space原件容量已达100MB，请先管理未使用的原件。");
      const represented = new Set(snapshot.space.cards.filter(card => card.type === "FileCard").map(card => card.displayProps.sha256));
      for (const item of incoming) {
        if (!assets[item.asset.id]) {
          persistBytes(identity.accountId, spaceId, item.asset, item.bytes); assets[item.asset.id] = item.asset;
        }
        const asset = assets[item.asset.id]!; result.push(asset);
        if (represented.has(asset.sha256)) continue;
        represented.add(asset.sha256);
        const stamp = new Date(now()).toISOString();
        cards.push(FileCardSchema.parse({ id: `filecard_${randomUUID()}`, type: "FileCard", variant: "standard", sources: [], sourceData: {},
          displayProps: { fileId: asset.id, name: asset.name, mediaType: asset.mediaType, sizeBytes: asset.sizeBytes, sha256: asset.sha256,
            parseStatus: asset.parseStatus, previewText: asset.text.slice(0, 1600), ...(asset.pageCount ? { pageCount: asset.pageCount } : {}) },
          layout: { x: 0, y: 0, width: 240, height: 176, pinned: false, surface: "display" }, metadata: { createdAt: stamp, updatedAt: stamp } }));
      }
      store.setAccountValue(identity.accountId, assetKey(spaceId), assets);
      let next = snapshot;
      // Action batches remain within the existing twelve-action envelope bound.
      if (cards.length) next = store.applyEnvelope(identity.accountId, spaceId, { ...write,
        envelope: { schemaVersion: "0.6", requestId: write.requestId, canvasId: spaceId, actions: cards.map(card => ({ type: "card.create", card })) } }, identity.device.id).snapshot;
      store.setAccountValue(identity.accountId, receiptKey(spaceId, write.requestId), { fingerprint, ids: result.map(asset => asset.id) });
      return hostedJson({ ok: true, snapshot: next, assets: result, addedCardIds: cards.map(card => card.id) });
    });
  }
  async function preparePhoto(bytes: Uint8Array): Promise<IncomingImage> {
    try {
      const image = sharp(Buffer.from(bytes), { limitInputPixels: 50_000_000, failOn: "error" });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height || Math.max(metadata.width, metadata.height) > 16384 || metadata.pages && metadata.pages > 1) fail(400, "photo-dimensions", "图片尺寸或帧数超出支持范围。");
      const { data, info } = await image.rotate().resize(1920, 1920, { fit: "inside", withoutEnlargement: true }).webp({ quality: 86 }).toBuffer({ resolveWithObject: true });
      const sha256 = hash(data);
      return { bytes: data, asset: { id: `image_${sha256}`, kind: "image", name: `photo-${sha256.slice(0, 12)}.webp`, mediaType: "image/webp", sha256,
        sizeBytes: data.byteLength, width: info.width, height: info.height, text: "", parseStatus: "unsupported", createdAt: new Date(now()).toISOString() } };
    } catch (error) { if (error instanceof SpaceError) throw error; fail(400, "photo-decode", "图片无法解码或尺寸过大。"); }
  }
  function persistPhotos(accountId: string, spaceId: string, incoming: IncomingImage[], deviceId: string, signal?: AbortSignal): SceneImage[] {
    signal?.throwIfAborted();
    return assetTransaction(() => {
      store.assertDeviceActive(accountId, deviceId);
      for (const { asset } of incoming) assertShaNotDeleting(accountId, spaceId, asset.sha256);
      const assets = index(accountId, spaceId); let size = Object.values(assets).reduce((sum, asset) => sum + asset.sizeBytes, 0);
      const planned = new Set(Object.keys(assets));
      for (const { asset } of incoming) if (!planned.has(asset.id)) { size += asset.sizeBytes; planned.add(asset.id); }
      if (size > FILE_LIMITS.spaceBytes) fail(413, "space-quota", "Space原件容量已达100MB。");
      for (const { asset, bytes } of incoming) if (!assets[asset.id]) {
        persistBytes(accountId, spaceId, asset, bytes); assets[asset.id] = asset;
      } else bytesFor(accountId, spaceId, assets[asset.id]!);
      signal?.throwIfAborted();
      store.setAccountValue(accountId, assetKey(spaceId), assets);
      return incoming.map(({ asset }): SceneImage => ({ src: `media:${asset.id}`, width: asset.width, height: asset.height }));
    });
  }
  async function photos(request: Request, identity: SpaceIdentity, spaceId: string) {
    const form = await hostedForm(request, FILE_LIMITS.batchBytes + 100_000), files = form.getAll("files");
    if (!files.length || files.length > 5 || files.some(file => !(file instanceof File))) fail(400, "photo-count", "每次最多5张图片。");
    if ((files as File[]).reduce((sum, file) => sum + file.size, 0) > FILE_LIMITS.batchBytes) fail(413, "photo-size", "图片合计不超过10MB。");
    const incoming: IncomingImage[] = [];
    for (const file of files as File[]) {
      if (!file.size || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) fail(400, "photo-type", "仅支持JPEG、PNG或WebP图片。");
      incoming.push(await preparePhoto(new Uint8Array(await file.arrayBuffer())));
    }
    return hostedJson({ images: persistPhotos(identity.accountId, spaceId, incoming, identity.device.id, request.signal) });
  }
  /** Only the current explicit attachment is accepted: never resolve a URL or a previous card's image. */
  async function persistIntentImage(accountId: string, spaceId: string, attachment: Attachment, deviceId: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    store.assertDeviceActive(accountId, deviceId); index(accountId, spaceId);
    const validated = await validateImageAttachment(attachment, decodeImage);
    signal?.throwIfAborted();
    const incoming = await preparePhoto(validated.bytes);
    return persistPhotos(accountId, spaceId, [incoming], deviceId, signal)[0]!.src;
  }
  async function handle(request: Request, identity: SpaceIdentity): Promise<Response | null> {
    const url = new URL(request.url), match = /^\/api\/space\/spaces\/([^/]+)\/(assets|photos|uploads)(?:\/([^/]+))?(?:\/(content))?$/.exec(url.pathname);
    if (!match) return null;
    const [, spaceId, kind, id, content] = match;
    store.assertDeviceActive(identity.accountId, identity.device.id); store.getSnapshot(identity.accountId, spaceId!);
    if (url.search) fail(400, "asset-query", "原件接口不接受查询路径。");
    if (kind === "photos" && !id && request.method === "POST") return photos(request, identity, spaceId!);
    if (kind === "uploads" && id && request.method === "GET") {
      const previous = store.getAccountValue<{ ids: string[] }>(identity.accountId, receiptKey(spaceId!, id));
      if (!previous) fail(404, "upload-not-found", "没有此上传记录，请检查原请求。");
      return hostedJson({ ok: true, snapshot: store.getSnapshot(identity.accountId, spaceId!), assets: previous.ids.map(value => get(identity.accountId, spaceId!, value)) });
    }
    if (kind !== "assets") fail(405, "method-not-allowed", "此操作不可用。");
    if (!id && request.method === "POST") return upload(request, identity, spaceId!);
    if (!id && request.method === "GET") return hostedJson({ assets: Object.values(index(identity.accountId, spaceId!)) });
    if (!id) fail(405, "method-not-allowed", "此操作不可用。");
    if (!content && request.method === "DELETE") return remove(identity.accountId, spaceId!, id!, identity.device.id);
    const asset = get(identity.accountId, spaceId!, id!);
    if (!content && request.method === "GET") return hostedJson({ asset });
    if (content && (request.method === "GET" || request.method === "HEAD")) {
      const bytes = bytesFor(identity.accountId, spaceId!, asset), length = bytes.byteLength;
      let start = 0, end = length - 1, status = 200;
      const headers = new Headers({ "Content-Type": asset.mediaType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Accept-Ranges": "bytes",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`, "X-Content-SHA256": asset.sha256 });
      const range = request.headers.get("range");
      if (range) {
        const selected = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!selected || (!selected[1] && !selected[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${length}` } });
        if (!selected[1]) { start = Math.max(0, length - Number(selected[2])); }
        else { start = Number(selected[1]); if (selected[2]) end = Number(selected[2]); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || end < start || start < 0) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${length}` } });
        end = Math.min(end, length - 1); status = 206; headers.set("Content-Range", `bytes ${start}-${end}/${length}`);
      }
      headers.set("Content-Length", String(Math.max(0, end - start + 1)));
      store.assertDeviceActive(identity.accountId, identity.device.id);
      return new Response(request.method === "HEAD" ? null : bytes.slice(start, end + 1), { status, headers });
    }
    fail(405, "method-not-allowed", "此操作不可用。");
  }
  async function stageLegacyAsset(accountId: string, spaceId: string, input: { kind: "file" | "image"; name: string; mediaType: string;
    sha256: string; sizeBytes: number; bytes: Uint8Array; text?: string; parseStatus?: HostedAsset["parseStatus"]; pageCount?: number }, deviceId: string): Promise<HostedAsset> {
    store.assertDeviceActive(accountId, deviceId); index(accountId, spaceId);
    if (!/^[a-f0-9]{64}$/.test(input.sha256) || input.bytes.byteLength !== input.sizeBytes || hash(input.bytes) !== input.sha256
      || input.sizeBytes > FILE_LIMITS.batchBytes || !input.name.trim() || input.name.length > 240 || /[\p{Cc}]/u.test(input.name))
      fail(400, "migration-integrity", "旧原件的清单、大小或哈希无效。");
    if (input.kind === "image") {
      const form = new FormData(); form.append("files", new File([new Uint8Array(input.bytes)], input.name, { type: input.mediaType }));
      const response = await photos(new Request("https://migration.invalid/", { method: "POST", body: form }),
        { accountId, user: { id: accountId, username: "migration" }, device: { id: deviceId, name: "migration" } }, spaceId);
      const result = await response.json() as { images: SceneImage[] };
      return get(accountId, spaceId, result.images[0]!.src.slice("media:".length));
    }
    if (!["text/plain", "text/markdown", "text/csv", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/json"].includes(input.mediaType))
      fail(400, "legacy-type", "旧原件类型不在下载兼容范围。");
    let text = "", parseStatus: HostedAsset["parseStatus"] = "unsupported";
    if (input.mediaType === "text/markdown") {
      try { const value = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes); text = value.slice(0, FILE_LIMITS.textChars); parseStatus = value.length > text.length ? "partial" : text.trim() ? "ready" : "empty"; }
      catch { fail(400, "file-encoding", "旧Markdown原件编码无效。"); }
    } else if (input.mediaType === "application/pdf") {
      if (!Buffer.from(input.bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-"))) fail(400, "file-type", "旧PDF原件格式无效。");
      text = typeof input.text === "string" ? input.text.slice(0, FILE_LIMITS.textChars) : "";
      parseStatus = text ? (input.parseStatus === "partial" ? "partial" : "ready") : "empty";
    }
    const asset: HostedAsset = { id: `file_${input.sha256}`, kind: "file", name: input.name, mediaType: input.mediaType,
      sizeBytes: input.sizeBytes, sha256: input.sha256, text, parseStatus,
      ...(input.pageCount && Number.isSafeInteger(input.pageCount) && input.pageCount > 0 ? { pageCount: input.pageCount } : {}), createdAt: new Date(now()).toISOString() };
    return assetTransaction(() => {
      store.assertDeviceActive(accountId, deviceId);
      assertShaNotDeleting(accountId, spaceId, asset.sha256);
      const assets = index(accountId, spaceId);
      if (assets[asset.id]) return assets[asset.id]!;
      if (Object.values(assets).reduce((sum, current) => sum + current.sizeBytes, asset.sizeBytes) > FILE_LIMITS.spaceBytes)
        fail(413, "space-quota", "迁移原件超过Space的100MB限制，未完成迁移。");
      persistBytes(accountId, spaceId, asset, input.bytes); assets[asset.id] = asset;
      store.setAccountValue(accountId, assetKey(spaceId), assets); return asset;
    });
  }
  // Only explicit, durable deletion intents are replayed. Never scan or remove old unindexed files.
  let recoveryFailures = 0;
  for (const account of store.listAccounts()) for (const space of store.listSpaces(account.id)) {
    let intents: DeleteIntents;
    try { intents = pending(account.id, space.id); } catch { recoveryFailures++; continue; }
    for (const id of Object.keys(intents)) try { finishDeletion(account.id, space.id, id); } catch { recoveryFailures++; }
  }
  return { handle, get, bytesFor, stageLegacyAsset, persistIntentImage, list: (accountId: string, spaceId: string) => Object.values(index(accountId, spaceId)), physical,
    deletionRecoveryStatus: () => ({ failures: recoveryFailures }) };
}
