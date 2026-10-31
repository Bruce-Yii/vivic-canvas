import { CanvasRecordSchema, type CanvasRecord } from "@/persistence/canvasRecord";
import type { StoredCardDefinition, VivicDB } from "@/persistence/db";
import { hostedRequest } from "./client";
import { newId } from "@/lib/id";

interface SavedCanvas { record: CanvasRecord; serverVersion: number }
const root = "/api/space/owner";
const saved = new Map<string, SavedCanvas>();
const meta = new Map<string, string | undefined>();
const pending = new Map<string, { record: CanvasRecord; expectedVersion: number | null; requestId: string }>();
let loadedAt = 0;
let loading: Promise<void> | null = null;
function accept(value: SavedCanvas) { saved.set(value.record.id, { ...value, record: CanvasRecordSchema.parse(value.record) }); }
async function refresh() {
  // Keep the version that this owner actually read; a background read must not
  // advance a stale editor's expected version over another device's changes.
  if (loadedAt) return;
  loading ??= hostedRequest<{ canvases: SavedCanvas[] }>(`${root}/canvases`).then(value => {
    const ids = new Set(value.canvases.map(item => item.record.id));
    for (const key of saved.keys()) if (!ids.has(key) && !pending.has(key)) saved.delete(key);
    for (const item of value.canvases) if (!pending.has(item.record.id)) accept(item);
    loadedAt = Date.now();
  }).finally(() => { loading = null; });
  await loading;
}

/** The old owner UI persists in the existing account Space database. No browser fallback. */
export function createOwnerDB(): VivicDB {
  return {
    async getAllCanvases() { await refresh(); return [...saved.values()].map(value => structuredClone(value.record)); },
    async getCanvas(id) { await refresh(); return saved.has(id) ? structuredClone(saved.get(id)!.record) : undefined; },
    async putCanvas(record) {
      const previous = saved.get(record.id);
      if (!pending.has(record.id) && previous && JSON.stringify(previous.record) === JSON.stringify(record)) return;
      let request = pending.get(record.id);
      if (request && JSON.stringify(request.record) !== JSON.stringify(record)) throw new Error("上次保存结果待确认，请重新载入画布后重试。");
      request ??= { record: structuredClone(record), expectedVersion: previous?.serverVersion ?? null, requestId: newId("save") };
      pending.set(record.id, request);
      const result = await hostedRequest<SavedCanvas>(`${root}/canvases/${encodeURIComponent(record.id)}`, request, "PUT"); accept(result); pending.delete(record.id);
    },
    async deleteCanvas(id) {
      const current = saved.get(id); if (!current) return;
      await hostedRequest(`${root}/canvases/${encodeURIComponent(id)}`, { expectedVersion: current.serverVersion }, "DELETE"); saved.delete(id); pending.delete(id);
    },
    async getMeta(key) {
      if (meta.has(key)) return meta.get(key);
      const result = await hostedRequest<{ value?: string }>(`${root}/meta/${encodeURIComponent(key)}`); meta.set(key, result.value); return result.value;
    },
    async setMeta(key, value) {
      if (meta.get(key) === value) return;
      await hostedRequest(`${root}/meta/${encodeURIComponent(key)}`, { value }, "PUT"); meta.set(key, value);
    },
    async loadCardDefinitions() {
      const result = await hostedRequest<{ definitions: StoredCardDefinition[] }>("/api/space/definitions"); return result.definitions;
    },
    async saveCardDefinition(record) { await hostedRequest(`${root}/definitions`, { record }, "PUT"); },
    async deleteCardDefinition(key) { await hostedRequest(`${root}/definitions`, { key }, "DELETE"); },
    async reset(fresh) { for (const id of saved.keys()) await this.deleteCanvas(id); meta.clear(); await this.putCanvas(fresh); await this.setMeta("lastCanvasId", fresh.id); },
    close() {},
  };
}

export function invalidateOwnerDB() { loadedAt = 0; }
