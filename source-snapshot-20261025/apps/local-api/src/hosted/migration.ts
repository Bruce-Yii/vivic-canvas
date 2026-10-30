import { createHash } from "node:crypto";
import { z } from "zod";
import { CardRecordSchema, FILE_LIMITS, isReadableFile, type CardRecord, type SceneImage } from "@vivic/contracts";
import { definitionKey, definitionRef, revalidateDefinition, validateInstance, type CardDefinition } from "@vivic/card-runtime";
import type { HostedSpaceStore, SpaceIdentity } from "../space/store.js";
import { SpaceError } from "../space/errors.js";
import { arrangeHostedCards, hostedImageSources } from "../space/executor.js";
import type { HostedAsset } from "./assets.js";
import { hostedBody, hostedForm, hostedJson } from "./http.js";

const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const requestId = z.string().min(1).max(128);
const LegacyAssetSchema = z.strictObject({ legacyId: id, kind: z.enum(["file", "image"]),
  name: z.string().trim().min(1).max(240).regex(/^[^\p{Cc}]+$/u), mediaType: z.string().min(1).max(160),
  sizeBytes: z.int().min(0).max(FILE_LIMITS.batchBytes), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().max(FILE_LIMITS.textChars).optional(), parseStatus: z.enum(["ready", "partial", "empty", "unsupported", "error"]).optional(),
  pageCount: z.int().min(1).max(100000).optional() });
const RecordSchema = z.object({ schemaVersion: z.literal(1).optional(), id: z.string().min(1).max(128),
  title: z.string().min(1).max(120), version: z.int().min(0), updatedAt: z.iso.datetime(),
  cardsById: z.record(z.string().min(1).max(128), CardRecordSchema), cardOrder: z.array(z.string().min(1).max(128)).max(1000),
  viewport: z.strictObject({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().finite() }),
  focusHistory: z.array(z.string().min(1).max(128)).max(20),
  processedRequestIds: z.array(z.string().min(1).max(128)).max(500).optional(), recovery: z.unknown().optional(),
}).passthrough().refine(value => Object.keys(value.cardsById).length <= 1000
  && value.cardOrder.length === Object.keys(value.cardsById).length && new Set(value.cardOrder).size === value.cardOrder.length
  && Object.entries(value.cardsById).every(([key, card]) => key === card.id && value.cardOrder.includes(key)), "卡片编号、顺序和内容不一致。");
const BeginSchema = z.strictObject({ requestId, expectedVersion: z.int().min(0), record: RecordSchema,
  definitions: z.array(z.unknown()).max(32).optional(), assets: z.array(LegacyAssetSchema).max(1000).refine(items => new Set(items.map(item => item.legacyId)).size === items.length).optional() });
const BatchSchema = z.array(LegacyAssetSchema).min(1).max(FILE_LIMITS.count);
type LegacyAsset = z.infer<typeof LegacyAssetSchema>;
interface Requirement { legacyId: string; kind: "file" | "image"; expected?: LegacyAsset; asset?: HostedAsset }
interface InstalledDefinition { key: string; definition: CardDefinition; enabled: boolean }
interface MigrationManifest {
  protocolVersion: "vivic-space-import-v1"; requestId: string; fingerprint: string; expectedVersion: number;
  state: "staging" | "succeeded"; record: z.infer<typeof RecordSchema>; rawRecord: unknown; rawDefinitions: unknown[];
  definitions: InstalledDefinition[]; requirements: Requirement[]; committedVersion?: number;
}
export interface HostedMigrationAssetService {
  stageLegacyAsset(accountId: string, spaceId: string, input: Omit<LegacyAsset, "legacyId"> & { bytes: Uint8Array }, deviceId: string): Promise<HostedAsset>;
  get(accountId: string, spaceId: string, id: string): HostedAsset;
  bytesFor(accountId: string, spaceId: string, asset: HostedAsset): Uint8Array;
  list(accountId: string, spaceId: string): HostedAsset[];
}
function fail(status: number, code: string, message: string, version?: number): never { throw new SpaceError(status, code, message, version); }
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
};
const keyFor = (spaceId: string, importId: string) => `migration:${spaceId}:${importId}`;
function sameAssetIdentity(left: LegacyAsset, right: LegacyAsset): boolean {
  return left.legacyId === right.legacyId && left.kind === right.kind && left.name === right.name && left.mediaType === right.mediaType
    && left.sizeBytes === right.sizeBytes && left.sha256 === right.sha256;
}
function dataBudget(raw: unknown) {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: raw, depth: 0 }]; let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++nodes > 200000 || depth > 64) fail(413, "migration-complexity", "迁移内容层级或条目过多。");
    if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) fail(400, "migration-fields", "迁移内容包含不支持的字段。");
      stack.push({ value: child, depth: depth + 1 });
    }
  }
}
function sourceReferences(cards: CardRecord[], declared: LegacyAsset[]): Requirement[] {
  const requirements = new Map<string, Requirement>();
  const add = (legacyId: string, kind: Requirement["kind"], expected?: LegacyAsset) => {
    const previous = requirements.get(legacyId);
    if (previous && (previous.kind !== kind || previous.expected && expected && !sameAssetIdentity(previous.expected, expected))) {
      fail(409, "legacy-asset-conflict", "同一个旧原件编号对应不同内容，请先在源数据中核对。");
    }
    requirements.set(legacyId, { ...previous, legacyId, kind, ...(expected ? { expected } : {}) });
  };
  for (const card of cards) {
    if (card.type === "FileCard") add(card.displayProps.fileId, "file", {
      legacyId: card.displayProps.fileId, kind: "file", name: card.displayProps.name, mediaType: card.displayProps.mediaType,
      sizeBytes: card.displayProps.sizeBytes, sha256: card.displayProps.sha256,
    });
    for (const source of hostedImageSources(card)) if (source.startsWith("media:")) add(source.slice(6), "image");
  }
  for (const asset of declared) add(asset.legacyId, asset.kind, asset);
  const result = [...requirements.values()].sort((a, b) => a.legacyId.localeCompare(b.legacyId));
  const uniqueBytes = new Map(result.flatMap(item => item.expected ? [[`${item.kind}:${item.expected.sha256}`, item.expected.sizeBytes] as const] : []));
  if (result.length > 1000 || [...uniqueBytes.values()].reduce((sum, size) => sum + size, 0) > FILE_LIMITS.spaceBytes) fail(413, "migration-quota", "迁移原件超过Space的100MB容量限制。");
  return result;
}
async function checkedDefinitions(raw: unknown[]): Promise<InstalledDefinition[]> {
  let bytes = 0; const definitions: InstalledDefinition[] = [], versions = new Map<string, string>();
  for (const entry of raw) {
    const size = Buffer.byteLength(JSON.stringify(entry)); bytes += size;
    if (size > 2 * 1024 * 1024 || bytes > 4 * 1024 * 1024) fail(413, "migration-definitions-size", "卡片包定义超过迁移限制。");
    try {
      const wrapped = object(entry) && Object.hasOwn(entry, "definition");
      const definition = await revalidateDefinition(wrapped ? entry.definition : entry), key = definitionKey(definitionRef(definition));
      if (wrapped && entry.key !== undefined && entry.key !== key || wrapped && entry.enabled !== undefined && typeof entry.enabled !== "boolean") throw new Error("Definition identity differs.");
      const version = `${definition.manifest.id}@${definition.manifest.version}`, old = versions.get(version);
      if (old && old !== definition.hash) fail(409, "migration-definition-conflict", "同ID和版本的卡片包包含不同内容。");
      versions.set(version, definition.hash);
      if (!definitions.some(item => item.key === key)) definitions.push({ key, definition, enabled: wrapped ? entry.enabled !== false : true });
    } catch (error) {
      if (error instanceof SpaceError) throw error;
      fail(400, "migration-definition-invalid", "卡片包定义、哈希或声明式能力校验失败，源数据未更改。");
    }
  }
  return definitions;
}

export function createHostedMigrationService(options: { store: HostedSpaceStore; assetService: HostedMigrationAssetService }) {
  const { store, assetService } = options;
  const accountDefinitions = (accountId: string): InstalledDefinition[] => store.getAccountValue<InstalledDefinition[]>(accountId, "hostedDefinitions") ?? [];
  const load = (identity: SpaceIdentity, spaceId: string, importId: string): MigrationManifest => {
    store.assertDeviceActive(identity.accountId, identity.device.id); store.getSnapshot(identity.accountId, spaceId);
    const persisted = store.getAccountValue<Omit<MigrationManifest, "record">>(identity.accountId, keyFor(spaceId, importId));
    if (!persisted) fail(404, "migration-not-found", "没有此迁移记录。");
    const record = RecordSchema.safeParse(persisted.rawRecord);
    if (!record.success) fail(503, "migration-inconsistent", "迁移源记录校验失败，未确认完成。");
    return { ...persisted, record: record.data };
  };
  const save = (identity: SpaceIdentity, spaceId: string, manifest: MigrationManifest) => {
    // One raw source is sufficient on disk; the validated working view is rebuilt on resume.
    const { record: _record, ...persisted } = manifest;
    store.setAccountValue(identity.accountId, keyFor(spaceId, manifest.requestId), persisted);
  };
  function status(identity: SpaceIdentity, spaceId: string, manifest: MigrationManifest, deduplicated = false): Response {
    const received = manifest.requirements.filter(item => item.asset).map(item => ({ legacyId: item.legacyId, assetId: item.asset!.id }));
    const missing = manifest.requirements.filter(item => !item.asset).map(({ legacyId, kind, expected }) => ({ legacyId, kind, ...(expected ? { expected } : {}) }));
    const receipt = manifest.state === "succeeded" ? store.getReceipt(identity.accountId, spaceId, manifest.requestId) : null;
    if (manifest.state === "succeeded" && !receipt) fail(503, "migration-inconsistent", "迁移回执暂不可用，未确认完成。");
    return hostedJson({ ok: true, requestId: manifest.requestId, status: manifest.state, fingerprint: manifest.fingerprint,
      expectedVersion: manifest.expectedVersion, received, missing, ...(deduplicated ? { deduplicated: true } : {}),
      ...(receipt ? { snapshot: receipt.snapshot, receipt: receipt.receipt } : {}) }, manifest.state === "succeeded" ? 200 : 202);
  }
  function existingBindings(identity: SpaceIdentity, spaceId: string, manifest: MigrationManifest) {
    const existing = assetService.list(identity.accountId, spaceId);
    for (const required of manifest.requirements) {
      if (required.asset || !required.expected) continue;
      // Only exact originals may bypass staging. Images transformed by the asset host require their persistent mapping.
      const asset = existing.find(item => item.kind === required.kind && item.sha256 === required.expected!.sha256
        && item.mediaType === required.expected!.mediaType && item.sizeBytes === required.expected!.sizeBytes);
      if (asset) { assetService.bytesFor(identity.accountId, spaceId, asset); required.asset = asset; }
    }
  }
  function remapCard(card: CardRecord, requirements: Requirement[]): CardRecord {
    const assets = new Map(requirements.map(item => [item.legacyId, item.asset!]));
    const source = (value: string): string => {
      if (!value.startsWith("media:")) return value;
      const asset = assets.get(value.slice(6));
      if (!asset || asset.kind !== "image") fail(409, "migration-assets-missing", "图片原件尚未完整上传，未保存卡片。");
      return `media:${asset.id}`;
    };
    const image = (value: SceneImage): SceneImage => {
      const src = source(value.src), asset = value.src.startsWith("media:") ? assets.get(value.src.slice(6)) : undefined;
      return { ...value, src, ...(asset?.width ? { width: asset.width } : {}), ...(asset?.height ? { height: asset.height } : {}) };
    };
    let displayProps: unknown = card.displayProps;
    // Use the same closed renderer slots as ownership validation. Ordinary text and raw source metadata are not image references.
    switch (card.type) {
      case "GalleryCard": displayProps = { ...card.displayProps, images: card.displayProps.images.map(image) }; break;
      case "PhotoCoverCard": if (card.displayProps.image) displayProps = { ...card.displayProps, image: image(card.displayProps.image) }; break;
      case "NewsCard": case "LinkPreviewCard": if (card.displayProps.image) displayProps = { ...card.displayProps, image: source(card.displayProps.image) }; break;
      case "BookCard": if (card.displayProps.cover) displayProps = { ...card.displayProps, cover: source(card.displayProps.cover) }; break;
      case "StoryCarouselCard": displayProps = { ...card.displayProps, slides: card.displayProps.slides.map(slide => slide.image ? { ...slide, image: source(slide.image) } : slide) }; break;
    }
    let next = { ...card, displayProps, layout: { ...card.layout, surface: "display" as const } };
    if (card.type === "FileCard") {
      const asset = assets.get(card.displayProps.fileId);
      if (!asset || asset.kind !== "file") fail(409, "migration-assets-missing", "文件原件尚未完整上传，未保存卡片。");
      const { previewText: _previewText, pageCount: _pageCount, ...original } = card.displayProps;
      next = { ...next, displayProps: { ...original, fileId: asset!.id, name: asset!.name, mediaType: asset!.mediaType,
        sizeBytes: asset!.sizeBytes, sha256: asset!.sha256, parseStatus: isReadableFile(asset!.mediaType) ? asset!.parseStatus : "unsupported",
        ...(isReadableFile(asset!.mediaType) && asset!.text ? { previewText: asset!.text.slice(0, 1600) } : {}),
        ...(asset!.pageCount ? { pageCount: asset!.pageCount } : {}) } };
    }
    const parsed = CardRecordSchema.safeParse(next);
    return parsed.success ? parsed.data : fail(400, "migration-card-invalid", "原件映射后的卡片未通过校验。");
  }
  function finalize(identity: SpaceIdentity, spaceId: string, importId: string): Response {
    return store.transaction(() => {
      const manifest = load(identity, spaceId, importId);
      if (manifest.state === "succeeded") return status(identity, spaceId, manifest, true);
      existingBindings(identity, spaceId, manifest);
      if (manifest.requirements.some(item => !item.asset)) { save(identity, spaceId, manifest); return status(identity, spaceId, manifest); }
      const snapshot = store.getSnapshot(identity.accountId, spaceId);
      if (snapshot.space.version !== manifest.expectedVersion) fail(409, "version-conflict", "目标Space已更新，迁移暂停，原件和进度已保留。", snapshot.space.version);
      for (const requirement of manifest.requirements) {
        const current = assetService.get(identity.accountId, spaceId, requirement.asset!.id);
        if (current.sha256 !== requirement.asset!.sha256 || current.sizeBytes !== requirement.asset!.sizeBytes) fail(409, "migration-asset-conflict", "已暂存的原件内容发生变化，迁移已停止。");
        assetService.bytesFor(identity.accountId, spaceId, current);
      }
      const source = manifest.record.cardOrder.map(cardId => remapCard(manifest.record.cardsById[cardId]!, manifest.requirements));
      const document = store.getSpaceDocument(identity.accountId, spaceId), existingDefinitions = Array.isArray(document.definitions) ? document.definitions as InstalledDefinition[] : [];
      const definitions = [...existingDefinitions];
      const installed = accountDefinitions(identity.accountId);
      for (const incoming of manifest.definitions) {
        const conflict = [...definitions, ...installed].find(item => item.definition.manifest.id === incoming.definition.manifest.id
          && item.definition.manifest.version === incoming.definition.manifest.version && item.definition.hash !== incoming.definition.hash);
        if (conflict) fail(409, "migration-definition-conflict", "目标Space已有相同ID和版本但内容不同的卡片包。");
        if (!definitions.some(item => item.key === incoming.key)) definitions.push(incoming);
        if (!installed.some(item => item.key === incoming.key)) installed.push(incoming);
      }
      for (const card of source) {
        if (card.type === "ExtensionCard") {
          const definition = [...definitions, ...installed].find(item => item.key === definitionKey(card.displayProps.def));
          if (!definition) fail(409, "migration-definition-missing", "扩展卡片缺少完整且有效的包定义，迁移未完成。");
          try { validateInstance(definition!.definition, card.displayProps); }
          catch { fail(400, "migration-instance-invalid", "扩展卡片内容与包定义不一致。"); }
        }
        const existing = snapshot.space.cards.find(item => item.id === card.id);
        if (existing && canonical(existing) !== canonical(card)) fail(409, "migration-card-conflict", "目标Space已有相同编号但内容不同的卡片，迁移已停止。");
      }
      const existingIds = new Set(snapshot.space.cards.map(card => card.id));
      const cards = arrangeHostedCards([...snapshot.space.cards, ...source.filter(card => !existingIds.has(card.id))]);
      if (cards.length > 1000) fail(413, "space-card-limit", "迁移后卡片数量超过1000张。");
      const archives = object(document.legacyMigrations) ? document.legacyMigrations : {};
      const result = store.replaceSpaceDocument(identity.accountId, spaceId, { requestId: manifest.requestId, expectedVersion: manifest.expectedVersion,
        ...(snapshot.space.cards.length ? {} : { title: manifest.record.title }), document: { ...document, cards,
          viewport: document.viewport ?? manifest.record.viewport, focusHistory: document.focusHistory ?? manifest.record.focusHistory,
          definitions, legacyMigrations: { ...archives, [manifest.requestId]: { fingerprint: manifest.fingerprint,
            record: manifest.rawRecord, definitions: manifest.rawDefinitions, assets: manifest.requirements.map(item => ({ legacyId: item.legacyId, expected: item.expected, asset: item.asset })) } } } }, identity.device.id);
      manifest.state = "succeeded"; manifest.committedVersion = result.receipt.version; save(identity, spaceId, manifest);
      store.setAccountValue(identity.accountId, "hostedDefinitions", installed);
      return status(identity, spaceId, manifest);
    });
  }
  async function begin(request: Request, identity: SpaceIdentity, spaceId: string) {
    const raw = await hostedBody(request, MAX_IMPORT_BYTES); dataBudget(raw);
    const parsed = BeginSchema.safeParse(raw);
    if (!parsed.success) return fail(400, "migration-invalid", "旧Space内容、卡片或迁移参数未通过校验，源数据未更改。");
    const input = parsed.data, rawRecord = (raw as { record: unknown }).record, rawDefinitions = input.definitions ?? [];
    const definitions = await checkedDefinitions(rawDefinitions);
    request.signal.throwIfAborted();
    const fingerprint = hash(canonical({ expectedVersion: input.expectedVersion, record: rawRecord, definitions: rawDefinitions,
      assets: [...(input.assets ?? [])].sort((a, b) => a.legacyId.localeCompare(b.legacyId)) }));
    return store.transaction(() => {
      store.assertDeviceActive(identity.accountId, identity.device.id); const snapshot = store.getSnapshot(identity.accountId, spaceId);
      if (store.getAccountValue(identity.accountId, keyFor(spaceId, input.requestId))) {
        const previous = load(identity, spaceId, input.requestId);
        if (previous.fingerprint !== fingerprint) fail(409, "request-id-conflict", "此迁移编号已绑定其他内容。");
        if (previous.state === "succeeded") return status(identity, spaceId, previous, true);
        existingBindings(identity, spaceId, previous); save(identity, spaceId, previous);
        return previous.requirements.every(item => item.asset) ? finalize(identity, spaceId, previous.requestId) : status(identity, spaceId, previous, true);
      }
      if (snapshot.space.version !== input.expectedVersion) fail(409, "version-conflict", "目标Space已更新，请先检查最新内容。", snapshot.space.version);
      const manifest: MigrationManifest = { protocolVersion: "vivic-space-import-v1", requestId: input.requestId, fingerprint, expectedVersion: input.expectedVersion,
        state: "staging", record: input.record, rawRecord, rawDefinitions, definitions,
        requirements: sourceReferences(input.record.cardOrder.map(cardId => input.record.cardsById[cardId]!), input.assets ?? []) };
      existingBindings(identity, spaceId, manifest); save(identity, spaceId, manifest);
      return manifest.requirements.every(item => item.asset) ? finalize(identity, spaceId, manifest.requestId) : status(identity, spaceId, manifest);
    });
  }
  async function stage(request: Request, identity: SpaceIdentity, spaceId: string, importId: string) {
    load(identity, spaceId, importId);
    const form = await hostedForm(request, FILE_LIMITS.batchBytes + 1000000), files = form.getAll("files");
    let manifest: LegacyAsset[];
    try { manifest = BatchSchema.parse(JSON.parse(String(form.get("manifest") ?? "[]"))); }
    catch { return fail(400, "migration-assets-invalid", "迁移原件批次清单无效。"); }
    if (files.length !== manifest.length || files.some(file => !(file instanceof File))
      || new Set(manifest.map(item => item.legacyId)).size !== manifest.length) fail(400, "migration-assets-invalid", "原件批次不完整或编号重复。");
    if ((files as File[]).reduce((sum, file) => sum + file.size, 0) > FILE_LIMITS.batchBytes) fail(413, "migration-batch-size", "每批最多5个原件，合计不超过10MB。");
    for (let index = 0; index < manifest.length; index++) {
      const metadata = manifest[index]!, file = files[index] as File, bytes = new Uint8Array(await file.arrayBuffer());
      if (file.name !== metadata.name || file.type !== metadata.mediaType || bytes.byteLength !== metadata.sizeBytes || hash(bytes) !== metadata.sha256) fail(400, "migration-asset-integrity", "原件名称、类型、大小或哈希与清单不一致。");
      const already = store.transaction(() => {
        const current = load(identity, spaceId, importId);
        const required = current.requirements.find(item => item.legacyId === metadata.legacyId);
        if (!required || required.kind !== metadata.kind) fail(400, "migration-asset-unexpected", "此原件不在迁移清单中。");
        if (required!.expected && (!sameAssetIdentity(required!.expected, metadata)
          || required!.asset && canonical(required!.expected) !== canonical(metadata)
          || (["text", "parseStatus", "pageCount"] as const).some(key => required!.expected![key] !== undefined && required!.expected![key] !== metadata[key]))) {
          fail(409, "legacy-asset-conflict", "同一个旧原件编号已经绑定不同内容。");
        }
        required!.expected = metadata; save(identity, spaceId, current); return Boolean(required!.asset);
      });
      request.signal.throwIfAborted();
      if (already) continue;
      const { legacyId: _legacyId, ...input } = metadata;
      const asset = await assetService.stageLegacyAsset(identity.accountId, spaceId, { ...input, bytes }, identity.device.id);
      request.signal.throwIfAborted();
      store.transaction(() => {
        const current = load(identity, spaceId, importId), required = current.requirements.find(item => item.legacyId === metadata.legacyId);
        if (!required?.expected || canonical(required.expected) !== canonical(metadata)) fail(409, "migration-asset-conflict", "迁移原件清单发生变化。");
        if (required.asset && required.asset.id !== asset.id) fail(409, "migration-asset-conflict", "同一个旧原件编号映射到不同原件。");
        required.asset = asset; save(identity, spaceId, current);
      });
    }
    return status(identity, spaceId, load(identity, spaceId, importId));
  }
  async function handle(request: Request, identity: SpaceIdentity): Promise<Response | null> {
    const url = new URL(request.url), match = /^\/api\/space\/spaces\/([A-Za-z0-9_-]{1,128})\/(import|imports\/([^/]{1,384})(?:\/(assets|commit))?)$/.exec(url.pathname);
    const definitionsRoute = url.pathname === "/api/space/definitions";
    if (!match && !definitionsRoute) return null;
    store.assertDeviceActive(identity.accountId, identity.device.id);
    if (url.search) fail(400, "migration-query", "迁移接口不接受查询参数。");
    const site = request.headers.get("sec-fetch-site");
    if (request.headers.has("authorization") || request.headers.get("origin") !== null && request.headers.get("origin") !== url.origin
      || site !== null && !["same-origin", "none"].includes(site) || request.method !== "GET" && request.headers.get("origin") !== url.origin) fail(403, "same-origin-required", "迁移需要同源确认。");
    if (definitionsRoute) return request.method === "GET" ? hostedJson({ definitions: accountDefinitions(identity.accountId) }) : fail(405, "method-not-allowed", "此定义操作不可用。");
    const spaceId = match![1]!;
    store.getSnapshot(identity.accountId, spaceId);
    if (match![2] === "import" && request.method === "POST") return begin(request, identity, spaceId);
    let importId: string;
    try { importId = decodeURIComponent(match![3] ?? ""); } catch { return fail(400, "migration-invalid", "迁移编号无效。"); }
    if (!requestId.safeParse(importId).success) fail(400, "migration-invalid", "迁移编号无效。");
    if (!match![4] && request.method === "GET") return status(identity, spaceId, load(identity, spaceId, importId));
    if (match![4] === "assets" && request.method === "POST") return stage(request, identity, spaceId, importId);
    if (match![4] === "commit" && request.method === "POST") {
      if (!z.strictObject({}).safeParse(await hostedBody(request)).success) fail(400, "migration-invalid", "迁移确认参数无效。");
      request.signal.throwIfAborted(); return finalize(identity, spaceId, importId);
    }
    return fail(405, "method-not-allowed", "此迁移操作不可用。");
  }
  return { handle };
}
