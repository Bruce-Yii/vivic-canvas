import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { zipSync, strToU8 } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, definitionKey, definitionRef, parsePackageFiles, readPackageZip, type CardDefinition } from "@vivic/card-runtime";
import { ExtensionCardSchema } from "@vivic/contracts";
import { createSpaceHandler, SpaceError, type SpaceIdentity } from "../src/space/index.js";
import { cardPackageRoute, readEnabledCardDefinitions, type HostedDefinitionRow } from "../src/hosted/cardPackages.js";
import { ownerRoute } from "../src/hosted/owner.js";
import { createHostedMigrationService } from "../src/hosted/migration.js";
import { createHostedAssetService } from "../src/hosted/assets.js";
import { hostedFailure } from "../src/hosted/http.js";

const ORIGIN = "https://unit.test", folders: string[] = [], disposals: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) dispose();
  for (const folder of folders.splice(0)) {
    const absolute = realpathSync(folder);
    expect(path.dirname(absolute)).toBe(realpathSync(tmpdir())); expect(path.basename(absolute)).toMatch(/^vivic-card-packages-/);
    rmSync(absolute, { recursive: true, force: true });
  }
});
const files = (id = "test.package", version = "1.0.0", name = "TEST card package") => {
  const empty = { type: "object", additionalProperties: false, properties: {} };
  return { "manifest.json": { formatVersion: "0.1", id, version, name, description: "TEST declarative package", renderer: "declarative", host: "0.6", capabilities: [] },
    "config.schema.json": empty, "data.schema.json": empty, "state.schema.json": empty,
    "ui.json": { components: [{ component: "Header", text: "TEST" }] }, "examples/default.json": { name: "TEST", config: {}, data: {}, state: {} } };
};
const zip = (input: Record<string, unknown>) => zipSync(Object.fromEntries(Object.entries(input).map(([key, value]) => [key, strToU8(canonicalJson(value))])), { level: 6 });
async function pkg(id = "test.package", version = "1.0.0", name = "TEST card package") {
  const input = files(id, version, name), bytes = zip(input);
  const definition = await parsePackageFiles(Object.fromEntries(Object.entries(input).map(([key, value]) => [key, canonicalJson(value)])));
  return { bytes, definition, key: definitionKey(definitionRef(definition)) };
}
const row = (definition: CardDefinition, enabled = true): HostedDefinitionRow => ({ definition, enabled, key: definitionKey(definitionRef(definition)) });
async function rows(count: number, enabled = 0) {
  return Promise.all(Array.from({ length: count }, async (_, index) => row((await pkg(`test.package-${index}`)).definition, index < enabled)));
}
const sourceRecord = () => ({ schemaVersion: 1, id: "TEST-source", title: "TEST import", version: 0, updatedAt: "2026-10-30T00:00:00.000Z",
  cardsById: {}, cardOrder: [], viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [] });
async function fixture(twoAccounts = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "vivic-card-packages-")); folders.push(dir);
  let space = createSpaceHandler({ origin: ORIGIN, dataDir: dir, inviteCode: "TEST-package-first-invite" });
  const register = async (invite: string, username: string) => {
    const response = await space.fetch(new Request(ORIGIN + "/api/space/register", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ invite, username, password: "TEST-package-registration-password" }) }));
    expect(response.status).toBe(200);
    const body = await response.json() as { user: { id: string; username: string }; device: { id: string; name: string } };
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    return { cookie, identity: { accountId: body.user.id, user: body.user, device: body.device } as SpaceIdentity,
      spaceId: space.store.listSpaces(body.user.id)[0]!.id };
  };
  const first = await register("TEST-package-first-invite", "test_package_first");
  let second: typeof first | undefined;
  if (twoAccounts) {
    space.dispose(); space = createSpaceHandler({ origin: ORIGIN, dataDir: dir, inviteCode: "TEST-package-second-invite" });
    second = await register("TEST-package-second-invite", "test_package_second");
  }
  disposals.push(() => space.dispose());
  const store = space.store, assetService = createHostedAssetService({ store, dataDir: dir });
  const migration = createHostedMigrationService({ store, assetService });
  const send = async (route: string, options: { method?: string; body?: unknown; form?: FormData; cookie?: string | null; headers?: Record<string, string>; signal?: AbortSignal } = {}) => {
    const request = new Request(ORIGIN + route, { method: options.method ?? (options.body === undefined && !options.form ? "GET" : "POST"), signal: options.signal,
      headers: { origin: ORIGIN, ...(options.cookie === null ? {} : { cookie: options.cookie ?? first.cookie }),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
      ...(options.form ? { body: options.form } : options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    const identity = space.authenticate(request);
    if (!identity) return hostedFailure(new SpaceError(401, "login-required", "TEST authentication required"));
    try { return await cardPackageRoute(store, request, identity) ?? await ownerRoute(store, request, identity) ?? await migration.handle(request, identity) ?? await space.fetch(request); }
    catch (error) { return hostedFailure(error); }
  };
  const upload = (bytes: Uint8Array, enabled?: boolean, options: Parameters<typeof send>[1] = {}) => {
    const form = new FormData(); form.append("file", new File([new Uint8Array(bytes)], "TEST.vivicard", { type: "application/zip" }));
    if (enabled !== undefined) form.append("enabled", String(enabled));
    return send("/api/space/cards", { ...options, form });
  };
  const list = async (cookie?: string) => {
    const response = await send("/api/space/cards", { cookie }); expect(response.status).toBe(200);
    return (await response.json() as { definitions: HostedDefinitionRow[] }).definitions;
  };
  const seed = (value: HostedDefinitionRow[]) => store.setAccountValue(first.identity.accountId, "hostedDefinitions", value);
  const ownerPut = (definition: CardDefinition, enabled = true) => send("/api/space/owner/definitions", { method: "PUT", body: { record: row(definition, enabled) } });
  const begin = (definitions: unknown[], requestId = randomUUID()) => send(`/api/space/spaces/${first.spaceId}/import`, {
    body: { requestId, expectedVersion: store.getSnapshot(first.identity.accountId, first.spaceId).space.version, record: sourceRecord(), definitions } });
  return { store, first, second, send, upload, list, seed, ownerPut, begin };
}

describe("account card package routes and legacy write boundaries", () => {
  it("installs, lists, exports a genuine ZIP with the same verified hash, and reads enabled definitions", async () => {
    const f = await fixture(), input = await pkg();
    const response = await f.upload(input.bytes); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, record: { key: input.key, enabled: true, definition: { hash: input.definition.hash } } });
    expect(await f.list()).toEqual([row(input.definition)]);
    expect(await readEnabledCardDefinitions(f.store, f.first.identity.accountId)).toEqual([input.definition]);
    const exported = await f.send("/api/space/cards/test.package/package"); expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toBe("application/zip"); expect(exported.headers.get("cache-control")).toBe("no-store");
    expect(exported.headers.get("content-disposition")).toContain(".vivicard");
    const bytes = new Uint8Array(await exported.arrayBuffer()); expect([...bytes.slice(0, 4)]).toEqual([80, 75, 3, 4]);
    expect((await readPackageZip(bytes)).hash).toBe(input.definition.hash);
  });

  it("reinstalls idempotently without re-enabling a disabled package and rejects same-version content collisions", async () => {
    const f = await fixture(), input = await pkg();
    expect((await f.upload(input.bytes)).status).toBe(200);
    expect((await f.send("/api/space/cards/test.package", { method: "PATCH", body: { enabled: false } })).status).toBe(200);
    const again = await f.upload(input.bytes); expect(await again.json()).toMatchObject({ deduplicated: true, record: { enabled: false } });
    expect(await f.list()).toHaveLength(1); expect(await readEnabledCardDefinitions(f.store, f.first.identity.accountId)).toEqual([]);
    const changed = await pkg("test.package", "1.0.0", "TEST different content");
    expect((await f.upload(changed.bytes)).status).toBe(409); expect((await f.ownerPut(changed.definition)).status).toBe(409);
    expect(await f.list()).toEqual([row(input.definition, false)]);
  });

  it("requires an exact hash for multi-version updates/exports and for deletion", async () => {
    const f = await fixture(), a = await pkg(), b = await pkg("test.package", "2.0.0");
    await f.upload(a.bytes); await f.upload(b.bytes);
    expect((await f.send("/api/space/cards/test.package", { method: "PATCH", body: { enabled: false } })).status).toBe(409);
    expect((await f.send("/api/space/cards/test.package/package")).status).toBe(409);
    expect((await f.send(`/api/space/cards/test.package?hash=${a.definition.hash}`, { method: "PATCH", body: { enabled: false } })).status).toBe(200);
    expect((await f.list()).filter(value => value.enabled).map(value => value.key)).toEqual([b.key]);
    expect((await f.send("/api/space/cards/test.package", { method: "DELETE" })).status).toBe(400);
    expect((await f.send(`/api/space/cards/test.package?hash=${b.definition.hash}`, { method: "DELETE" })).status).toBe(200);
    expect((await f.list()).map(value => value.key)).toEqual([a.key]);
  });

  it("protects exact references in every current Space, including the legacy owner delete path", async () => {
    const f = await fixture(true), a = await pkg(), b = await pkg("test.package", "2.0.0"); await f.upload(a.bytes); await f.upload(b.bytes);
    // Old owner installs could leave two hashes at one version; only the exact referenced hash is protected.
    const legacy = await pkg("test.package", "1.0.0", "TEST legacy alternate hash"); f.seed([...(await f.list()), row(legacy.definition, false)]);
    const other = f.store.createSpace(f.first.identity.accountId, { requestId: randomUUID(), title: "TEST reference space" }, f.first.identity.device.id).space.id;
    const card = ExtensionCardSchema.parse({ id: "TEST-extension", type: "ExtensionCard", variant: "minimal", sources: [], sourceData: {},
      displayProps: { def: definitionRef(a.definition), config: {}, data: {}, state: {} }, layout: { x: 0, y: 0, width: 320, height: 180, pinned: false },
      metadata: { createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" } });
    const requestId = randomUUID(); f.store.applyEnvelope(f.first.identity.accountId, other, { requestId, expectedVersion: 0,
      envelope: { schemaVersion: "0.6", requestId, canvasId: other, actions: [{ type: "card.create", card }] } }, f.first.identity.device.id);
    expect((await f.send(`/api/space/cards/test.package?hash=${a.definition.hash}`, { method: "DELETE" })).status).toBe(409);
    expect((await f.send("/api/space/owner/definitions", { method: "DELETE", body: { key: a.key } })).status).toBe(409);
    expect((await f.send(`/api/space/cards/test.package?hash=${legacy.definition.hash}`, { method: "DELETE" })).status).toBe(200);
    expect((await f.send(`/api/space/cards/test.package?hash=${b.definition.hash}`, { method: "DELETE" })).status).toBe(200);
    expect((await f.send("/api/space/cards/test.package", { method: "PATCH", body: { enabled: false } })).status).toBe(200);
    await f.upload(a.bytes, true, { cookie: f.second!.cookie });
    expect((await f.send(`/api/space/cards/test.package?hash=${a.definition.hash}`, { method: "DELETE", cookie: f.second!.cookie })).status).toBe(200);
    expect(await f.list()).toEqual([row(a.definition, false)]);
  });

  it("isolates accounts and requires authenticated same-origin requests", async () => {
    const f = await fixture(true), a = await pkg(); await f.upload(a.bytes);
    expect((await f.send("/api/space/cards", { cookie: null })).status).toBe(401);
    expect(await f.list(f.second!.cookie)).toEqual([]);
    for (const [route, method, body] of [[`/api/space/cards/test.package/package?hash=${a.definition.hash}`, "GET", undefined],
      ["/api/space/cards/test.package", "PATCH", { enabled: false }], [`/api/space/cards/test.package?hash=${a.definition.hash}`, "DELETE", undefined]] as const) {
      expect((await f.send(route, { cookie: f.second!.cookie, method, body })).status).toBe(404);
    }
    expect([401, 403]).toContain((await f.upload(a.bytes, false, { headers: { origin: "https://foreign.test" } })).status);
    await expect(cardPackageRoute(f.store, new Request(ORIGIN + "/api/space/cards", { method: "POST" }), f.first.identity)).rejects.toMatchObject({ status: 403 });
    await expect(cardPackageRoute(f.store, new Request(ORIGIN + "/api/space/cards", { headers: { origin: "https://foreign.test" } }), f.first.identity)).rejects.toMatchObject({ status: 403 });
  });

  it("enforces the sixteen enabled limit through upload, PATCH, owner and migration", async () => {
    const f = await fixture(), existing = await rows(16, 16), extra = await pkg("test.extra"); f.seed(existing);
    expect((await f.upload(extra.bytes)).status).toBe(409);
    expect((await f.upload(extra.bytes, false)).status).toBe(200);
    expect((await f.send("/api/space/cards/test.extra", { method: "PATCH", body: { enabled: true } })).status).toBe(409);
    expect((await f.ownerPut(extra.definition, true)).status).toBe(409);
    const another = await pkg("test.migration-extra"); expect((await f.begin([row(another.definition)])).status).toBe(409);
    expect((await f.list()).filter(value => value.enabled)).toHaveLength(16);
    expect(f.store.getSnapshot(f.first.identity.accountId, f.first.spaceId).space.version).toBe(0);
  });

  it("enforces thirty-two installed definitions through all three write paths atomically", async () => {
    const f = await fixture(), existing = await rows(32, 16), extra = await pkg("test.extra"); f.seed(existing);
    expect((await f.upload(extra.bytes, false)).status).toBe(409);
    expect((await f.ownerPut(extra.definition, false)).status).toBe(409);
    expect((await f.begin([row(extra.definition, false)])).status).toBe(409);
    expect(await f.list()).toEqual(existing);
    expect(f.store.getSpaceDocument(f.first.identity.accountId, f.first.spaceId).definitions).toBeUndefined();
  });

  it("retains legacy excess, returns at most sixteen enabled definitions, and permits explicit reductions", async () => {
    const f = await fixture(), existing = await rows(33, 18); f.seed(existing);
    expect(await f.list()).toHaveLength(33); expect(await readEnabledCardDefinitions(f.store, f.first.identity.accountId)).toHaveLength(16);
    expect((await f.send("/api/space/cards/test.package-0", { method: "PATCH", body: { enabled: false } })).status).toBe(200);
    expect((await f.ownerPut(existing[1].definition, false)).status).toBe(200);
    expect((await f.send("/api/space/owner/definitions", { method: "DELETE", body: { key: existing[32].key } })).status).toBe(200);
    const after = await f.list(); expect(after).toHaveLength(32); expect(after.filter(value => value.enabled)).toHaveLength(16);
    expect(after.map(value => value.key)).toEqual(existing.slice(0, 32).map(value => value.key));
  });

  it("checks quota again after asynchronous ZIP validation and rejects a revoked device before committing", async () => {
    const f = await fixture(), existing = await rows(15, 15), competing = await pkg("test.competing"), extra = await pkg("test.extra"); f.seed(existing);
    const original = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => { f.seed([...existing, row(competing.definition)]); return original(...args); });
    expect((await f.upload(extra.bytes)).status).toBe(409); expect(await f.list()).toHaveLength(16);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
      f.store.revokeDevice(f.first.identity.accountId, f.first.identity.device.id, f.first.identity.device.id); return original(...args);
    });
    expect((await f.upload(extra.bytes, false)).status).toBe(401);
    expect(f.store.getAccountValue<HostedDefinitionRow[]>(f.first.identity.accountId, "hostedDefinitions")).toHaveLength(16);
  });

  it("revalidates canonical files/hash instead of trusting cached parsed fields or validated flags", async () => {
    const f = await fixture(), a = await pkg();
    f.seed([{ ...row(a.definition), definition: { ...a.definition, manifest: { ...a.definition.manifest, id: "test.forged" }, ui: { components: [] }, validated: true } as CardDefinition }]);
    expect(await readEnabledCardDefinitions(f.store, f.first.identity.accountId)).toEqual([a.definition]);
    const corrupt = structuredClone(a.definition); (corrupt.files["manifest.json"] as Record<string, unknown>).name = "TEST changed behind unchanged hash";
    f.seed([{ ...row(corrupt), definition: { ...corrupt, validated: true } as CardDefinition }]);
    await expect(readEnabledCardDefinitions(f.store, f.first.identity.accountId)).rejects.toMatchObject({ code: "definition-integrity" });
    expect((await f.send("/api/space/cards/test.package/package")).status).toBe(503);
    expect((await f.send("/api/space/cards/test.package", { method: "PATCH", body: { enabled: false } })).status).toBe(200);
    expect(await readEnabledCardDefinitions(f.store, f.first.identity.accountId)).toEqual([]);
  });

  it("does not return definitions disabled while their hash was being revalidated", async () => {
    const f = await fixture(), a = await pkg(); f.seed([row(a.definition)]);
    const original = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => { f.seed([row(a.definition, false)]); return original(...args); });
    await expect(readEnabledCardDefinitions(f.store, f.first.identity.accountId)).rejects.toMatchObject({ code: "definitions-changed" });
  });

  it("keeps migration storage shapes and cannot fake a disabling update to make room for a new enabled package", async () => {
    const f = await fixture(), a = await pkg(), existing = await rows(16, 16); f.seed(existing);
    expect((await f.begin([row(existing[0].definition, false), row(a.definition)])).status).toBe(409);
    expect(await f.list()).toEqual(existing);
    const migrated = await f.begin([row(a.definition, false)]); expect(migrated.status).toBe(200);
    expect((await f.list()).at(-1)).toEqual(row(a.definition, false));
    const document = f.store.getSpaceDocument(f.first.identity.accountId, f.first.spaceId);
    expect(document.definitions).toEqual([row(a.definition, false)]);
    expect(document.legacyMigrations).toBeDefined();
  });

  it("rechecks migration quota at commit after other installations fill the account", async () => {
    const f = await fixture(), a = await pkg(), requestId = randomUUID();
    const bytes = new TextEncoder().encode("TEST legacy original"), sha256 = await crypto.subtle.digest("SHA-256", bytes);
    const hash = Buffer.from(sha256).toString("hex"), metadata = { legacyId: "TEST-file", kind: "file", name: "TEST.md", mediaType: "text/markdown", sizeBytes: bytes.length, sha256: hash };
    const begin = await f.send(`/api/space/spaces/${f.first.spaceId}/import`, { body: { requestId, expectedVersion: 0, record: sourceRecord(), definitions: [row(a.definition, false)], assets: [metadata] } });
    expect(begin.status).toBe(202);
    f.seed(await rows(32, 0));
    const form = new FormData(); form.append("manifest", JSON.stringify([metadata])); form.append("files", new File([bytes], "TEST.md", { type: "text/markdown" }));
    expect((await f.send(`/api/space/spaces/${f.first.spaceId}/imports/${requestId}/assets`, { form })).status).toBe(202);
    const commit = await f.send(`/api/space/spaces/${f.first.spaceId}/imports/${requestId}/commit`, { body: {} }); expect(commit.status).toBe(409);
    expect(await f.list()).toHaveLength(32);
    expect(f.store.getAccountValue<{ state: string }>(f.first.identity.accountId, `migration:${f.first.spaceId}:${requestId}`)?.state).toBe("staging");
    expect(f.store.getSnapshot(f.first.identity.accountId, f.first.spaceId).space.version).toBe(0);
  });

  it("rejects invalid ZIPs, forbidden files/capabilities and oversized or multiple uploads", async () => {
    const f = await fixture();
    const original = files(), unsafe = { ...original, "manifest.json": { ...original["manifest.json"], capabilities: ["network"] } };
    for (const bytes of [new Uint8Array([80, 75, 0, 0]), zip({ ...files(), "../escape.json": {} }), zip(unsafe)]) {
      expect((await f.upload(bytes)).status).toBe(400);
    }
    expect((await f.upload(new Uint8Array(1_048_577))).status).toBe(413);
    const a = await pkg(), form = new FormData();
    form.append("file", new File([new Uint8Array(a.bytes)], "a.vivicard")); form.append("file", new File([new Uint8Array(a.bytes)], "b.vivicard"));
    expect((await f.send("/api/space/cards", { form })).status).toBe(400);
    expect(await f.list()).toEqual([]);
  });
});
