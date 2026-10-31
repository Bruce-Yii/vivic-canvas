import { zipSync } from "fflate";
import { z } from "zod";
import { canonicalJson, definitionKey, definitionRef, PACKAGE_LIMITS, readPackageZip, revalidateDefinition, type CardDefinition } from "@vivic/card-runtime";
import type { HostedSpaceStore, SpaceIdentity } from "../space/store.js";
import { SpaceError } from "../space/errors.js";
import { hostedBody, hostedForm, hostedJson } from "./http.js";
import { compareCardVersions } from "../cards/catalog.js";

export interface HostedDefinitionRow { key: string; definition: CardDefinition; enabled: boolean }
const LIMITS = { installed: 32, enabled: 16 } as const;
const packageId = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
function fail(status: number, code: string, message: string): never { throw new SpaceError(status, code, message); }
function reference(key: string) {
  const match = /^([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*)@(\d+\.\d+\.\d+)#([a-f0-9]{64})$/.exec(key);
  if (!match || match[1]!.length > 80 || match[2]!.length > 32) fail(503, "definitions-inconsistent", "卡片包索引需要检查，未修改已有定义。");
  return { id: match[1]!, version: match[2]!, hash: match[3]! };
}
/** Parsed fields inside definition remain untrusted until revalidateDefinition rebuilds them. */
export function hostedDefinitionRows(store: HostedSpaceStore, accountId: string): HostedDefinitionRow[] {
  const rows = store.getAccountValue<HostedDefinitionRow[]>(accountId, "hostedDefinitions") ?? [];
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.key !== "string" || typeof row.enabled !== "boolean" || !row.definition)
    || new Set(rows.map(row => row.key)).size !== rows.length) fail(503, "definitions-inconsistent", "卡片包索引需要检查，未修改已有定义。");
  for (const row of rows) reference(row.key);
  return rows;
}
/** Legacy excess is retained; a write must not increase an already exceeded limit. */
export function mergeHostedDefinitions(before: HostedDefinitionRow[], incoming: HostedDefinitionRow[], replaceExisting = false): HostedDefinitionRow[] {
  const next = [...before];
  for (const row of incoming) {
    const ref = reference(row.key), index = next.findIndex(item => item.key === row.key);
    const disablingUnchanged = index >= 0 && !row.enabled && canonicalJson(row.definition) === canonicalJson(next[index]!.definition);
    if (!disablingUnchanged && row.key !== definitionKey(definitionRef(row.definition))) fail(400, "invalid-definition", "卡片包编号与完整定义不一致。");
    if (index < 0 && next.some(item => { const other = reference(item.key); return other.id === ref.id && other.version === ref.version && other.hash !== ref.hash; }))
      fail(409, "definition-version-conflict", "同ID和版本已安装不同内容，请使用新的版本号。");
    if (index < 0) next.push(row);
    else if (replaceExisting) next[index] = row;
  }
  if (next.length > LIMITS.installed && next.length > before.length) fail(409, "definition-quota", "每个账号最多安装32个卡片包定义，请先删除未使用的版本。");
  const enabledBefore = before.filter(row => row.enabled).length, enabledAfter = next.filter(row => row.enabled).length;
  if (enabledAfter > LIMITS.enabled && enabledAfter > enabledBefore) fail(409, "enabled-definition-quota", "每个账号最多启用16个卡片包，可停用已有包或以enabled=false安装。");
  return next;
}
export function assertDefinitionUnreferenced(store: HostedSpaceStore, accountId: string, key: string): void {
  const ref = reference(key);
  for (const space of store.listSpaces(accountId)) if (store.getSnapshot(accountId, space.id).space.cards.some(card => card.type === "ExtensionCard"
    && card.displayProps.def.id === ref.id && card.displayProps.def.version === ref.version && card.displayProps.def.hash === ref.hash))
    fail(409, "definition-in-use", "当前Space仍有卡片引用此版本，请先删除引用卡片，或仅停用卡片包。");
}
export function saveHostedDefinition(store: HostedSpaceStore, identity: SpaceIdentity, row: HostedDefinitionRow, preserveExisting = false): HostedDefinitionRow {
  return store.transaction(() => {
    store.assertDeviceActive(identity.accountId, identity.device.id);
    const before = hostedDefinitionRows(store, identity.accountId), previous = before.find(item => item.key === row.key);
    const saved = { ...row, ...(preserveExisting && previous ? { enabled: previous.enabled } : {}) };
    store.setAccountValue(identity.accountId, "hostedDefinitions", mergeHostedDefinitions(before, [saved], true));
    return saved;
  });
}
export function deleteHostedDefinition(store: HostedSpaceStore, identity: SpaceIdentity, key: string): void {
  store.transaction(() => {
    store.assertDeviceActive(identity.accountId, identity.device.id);
    const before = hostedDefinitionRows(store, identity.accountId);
    if (!before.some(row => row.key === key)) return;
    assertDefinitionUnreferenced(store, identity.accountId, key);
    store.setAccountValue(identity.accountId, "hostedDefinitions", before.filter(row => row.key !== key));
  });
}
export function assertCardPackageOrigin(request: Request): void {
  const url = new URL(request.url), origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site"), mode = request.headers.get("sec-fetch-mode");
  if (request.headers.has("authorization") || origin !== null && origin !== url.origin || site !== null && !["same-origin", "none"].includes(site)
    || mode !== null && !["cors", "same-origin", "navigate"].includes(mode) || !["GET", "HEAD"].includes(request.method) && origin !== url.origin)
    fail(403, "same-origin-required", "卡片包操作需要同源设备授权。");
}
async function checked(row: HostedDefinitionRow): Promise<CardDefinition> {
  try {
    const definition = await revalidateDefinition(row.definition);
    if (definitionKey(definitionRef(definition)) !== row.key) throw new Error("identity differs");
    return definition;
  } catch { return fail(503, "definition-integrity", "卡片包内容或哈希校验失败，请重新安装原包。"); }
}
/** Internal account capability: never accepts browser definitions or cached validated flags. */
export async function readEnabledCardDefinitions(store: HostedSpaceStore, accountId: string): Promise<CardDefinition[]> {
  const before = hostedDefinitionRows(store, accountId), fingerprint = canonicalJson(before);
  const definitions: CardDefinition[] = [];
  const current = new Map<string, HostedDefinitionRow>();
  for (const row of before.filter(row => row.enabled)) {
    const ref = reference(row.key), prior = current.get(ref.id);
    if (!prior || compareCardVersions(ref.version, reference(prior.key).version) >= 0) current.set(ref.id, row);
  }
  for (const row of [...current.values()].slice(0, LIMITS.enabled)) definitions.push(await checked(row));
  if (canonicalJson(hostedDefinitionRows(store, accountId)) !== fingerprint) fail(409, "definitions-changed", "启用的卡片包已变化，请重新读取。");
  return definitions;
}
function selected(store: HostedSpaceStore, accountId: string, id: string, hash?: string): HostedDefinitionRow {
  const rows = hostedDefinitionRows(store, accountId).filter(row => { const ref = reference(row.key); return ref.id === id && (hash === undefined || ref.hash === hash); });
  if (!rows.length) fail(404, "definition-not-found", "卡片包不存在或不属于此账号。");
  if (rows.length !== 1) fail(409, "definition-hash-required", "此卡片包有多个版本，请明确hash。");
  return rows[0]!;
}

/** The parent hosted service authenticates the cookie before calling this adapter. */
export async function cardPackageRoute(store: HostedSpaceStore, request: Request, identity: SpaceIdentity): Promise<Response | null> {
  const url = new URL(request.url), base = "/api/space/cards";
  if (url.pathname !== base && !url.pathname.startsWith(base + "/")) return null;
  assertCardPackageOrigin(request); store.assertDeviceActive(identity.accountId, identity.device.id);
  const match = /^\/api\/space\/cards(?:\/([^/]+)(?:\/(package))?)?$/.exec(url.pathname);
  if (!match) fail(404, "not-found", "没有此卡片包接口。");
  for (const key of url.searchParams.keys()) if (key !== "hash") fail(400, "invalid-package-query", "卡片包接口仅接受hash参数。");
  const hashes = url.searchParams.getAll("hash");
  if (hashes.length > 1 || hashes.length && !sha.safeParse(hashes[0]).success) fail(400, "invalid-package-query", "卡片包hash无效。");
  const hash = hashes[0], { accountId, device } = identity;
  if (!match[1]) {
    if (url.search) fail(400, "invalid-package-query", "卡片包列表和上传不接受查询参数。");
    if (request.method === "GET") return hostedJson({ definitions: hostedDefinitionRows(store, accountId) });
    if (request.method !== "POST") fail(405, "method-not-allowed", "此卡片包操作不可用。");
    const form = await hostedForm(request, PACKAGE_LIMITS.compressedBytes + 64 * 1024);
    if ([...form.keys()].some(key => !["file", "enabled"].includes(key)) || form.getAll("file").length !== 1 || form.getAll("enabled").length > 1)
      fail(400, "invalid-card-package-upload", "请上传单个.vivicard文件。");
    const file = form.get("file"), enabled = form.get("enabled");
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".vivicard") || !file.size || enabled !== null && enabled !== "true" && enabled !== "false")
      fail(400, "invalid-card-package-upload", "需要.vivicard文件和可选enabled=true/false。");
    if (file.size > PACKAGE_LIMITS.compressedBytes) fail(413, "card-package-size", "卡片包最多1MiB。");
    let definition: CardDefinition;
    try { definition = await readPackageZip(new Uint8Array(await file.arrayBuffer())); }
    catch { return fail(400, "invalid-card-package", "卡片包ZIP、内容、示例或声明式能力校验失败。"); }
    request.signal.throwIfAborted(); store.assertDeviceActive(accountId, device.id);
    const key = definitionKey(definitionRef(definition)), existed = hostedDefinitionRows(store, accountId).some(row => row.key === key);
    const record = saveHostedDefinition(store, identity, { key, definition, enabled: enabled !== "false" }, true);
    return hostedJson({ ok: true, record, ...(existed ? { deduplicated: true } : {}) });
  }
  let id: string;
  try { id = decodeURIComponent(match[1]!); } catch { return fail(400, "invalid-package-id", "卡片包编号无效。"); }
  if (!packageId.test(id) || id.length > 80) fail(400, "invalid-package-id", "卡片包编号无效。");
  if (match[2] && request.method === "GET") {
    const row = selected(store, accountId, id, hash), definition = await checked(row);
    const bytes = zipSync(Object.fromEntries(Object.entries(definition.files).map(([name, value]) => [name, new TextEncoder().encode(canonicalJson(value))])), { level: 6 });
    let roundTrip: CardDefinition;
    try { roundTrip = await readPackageZip(bytes); } catch { return fail(503, "package-export-integrity", "导出卡片包校验失败，未提供下载。"); }
    if (roundTrip.hash !== definition.hash) fail(503, "package-export-integrity", "导出卡片包哈希不一致，未提供下载。");
    request.signal.throwIfAborted(); store.assertDeviceActive(accountId, device.id); selected(store, accountId, id, definition.hash);
    return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/zip", "cache-control": "no-store", "x-content-type-options": "nosniff",
      "content-length": String(bytes.byteLength), "content-disposition": `attachment; filename="${definition.manifest.id}-${definition.manifest.version}.vivicard"` } });
  }
  if (!match[2] && request.method === "PATCH") {
    const parsed = z.strictObject({ enabled: z.boolean(), hash: sha.optional() }).safeParse(await hostedBody(request));
    if (!parsed.success || hash !== undefined && parsed.data.hash !== undefined && parsed.data.hash !== hash) fail(400, "invalid-package-update", "需要enabled及明确一致的hash。");
    const row = selected(store, accountId, id, parsed.data.hash ?? hash);
    const definition = parsed.data.enabled ? await checked(row) : row.definition;
    request.signal.throwIfAborted(); store.assertDeviceActive(accountId, device.id);
    selected(store, accountId, id, reference(row.key).hash);
    return hostedJson({ ok: true, record: saveHostedDefinition(store, identity, { ...row, definition, enabled: parsed.data.enabled }) });
  }
  if (!match[2] && request.method === "DELETE") {
    if (!hash) fail(400, "definition-hash-required", "删除卡片包需要明确hash。");
    const row = selected(store, accountId, id, hash);
    request.signal.throwIfAborted(); deleteHostedDefinition(store, identity, row.key);
    return hostedJson({ ok: true });
  }
  return fail(405, "method-not-allowed", "此卡片包操作不可用。");
}
