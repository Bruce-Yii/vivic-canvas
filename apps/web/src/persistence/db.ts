import { clearMedia } from "@/cards/scene/mediaStore";
import { clearAllFileAssets, removeCanvasFileAssets } from "@/files/assetStore";
import { CanvasRecordSchema, preserveCanvasRecovery, recoverCanvasRecord, type CanvasRecord } from "./canvasRecord";
import { OWNER_ONLINE_BUILD } from "@/online/mode";

/**
 * Thin Promise wrapper over IndexedDB. DB `vivic`, schema v2:
 *  - store `canvases` (keyPath `id`): one CanvasRecord per canvas (the registry)
 *  - store `meta` (keyPath `key`): {key:'lastCanvasId', value}
 *  - store `definitions` (keyPath `key`): installed declarative packages
 * Secrets never land here — cards/viewport only (see AGENTS.md §7).
 */

export interface VivicDB {
  getAllCanvases: () => Promise<CanvasRecord[]>;
  getCanvas: (id: string) => Promise<CanvasRecord | undefined>;
  putCanvas: (record: CanvasRecord) => Promise<void>;
  deleteCanvas: (id: string) => Promise<void>;
  getMeta: (key: string) => Promise<string | undefined>;
  setMeta: (key: string, value: string) => Promise<void>;
  loadCardDefinitions: () => Promise<StoredCardDefinition[]>;
  saveCardDefinition: (record: StoredCardDefinition) => Promise<void>;
  deleteCardDefinition: (key: string) => Promise<void>;
  /** Atomically replace all app records and metadata with one empty canvas. */
  reset: (fresh: CanvasRecord) => Promise<void>;
  close: () => void;
}

export interface StoredCardDefinition {
  key: string;
  definition: unknown;
  enabled: boolean;
}

const DB_NAME = "vivic";
const DB_VERSION = 2;
const notifyDataReset = () => {
  if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent("vivic:data-reset"));
};

const reqToPromise = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb error"));
  });

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexeddb tx error"));
    tx.onabort = () => reject(tx.error ?? new Error("indexeddb tx aborted"));
  });

/** Non-persistent stand-in used by unit tests and as a no-IndexedDB fallback. */
export const createMemoryDB = (initialRecords: unknown[] = []): VivicDB => {
  const canvases = new Map<string, unknown>(initialRecords.flatMap(raw => {
    const record = recoverCanvasRecord(raw);
    return record ? [[record.id, structuredClone(raw)]] : [];
  }));
  const meta = new Map<string, string>();
  const definitions = new Map<string, StoredCardDefinition>();
  return {
    getAllCanvases: async () => [...canvases.values()].flatMap(raw => {
      const record = recoverCanvasRecord(structuredClone(raw));
      return record ? [record] : [];
    }),
    getCanvas: async (id) => recoverCanvasRecord(structuredClone(canvases.get(id))),
    putCanvas: async (record) => {
      canvases.set(record.id, structuredClone(preserveCanvasRecovery(record, canvases.get(record.id))));
    },
    deleteCanvas: async (id) => {
      canvases.delete(id);
    },
    getMeta: async (key) => meta.get(key),
    setMeta: async (key, value) => {
      meta.set(key, value);
    },
    loadCardDefinitions: async () => structuredClone([...definitions.values()]),
    saveCardDefinition: async record => { definitions.set(record.key, structuredClone(record)); },
    deleteCardDefinition: async key => { definitions.delete(key); },
    reset: async fresh => {
      const record = CanvasRecordSchema.parse(fresh);
      canvases.clear(); meta.clear(); definitions.clear();
      canvases.set(record.id, structuredClone(record));
      meta.set("lastCanvasId", record.id);
      notifyDataReset();
    },
    close: () => undefined,
  };
};

export const openVivicDB = (): Promise<VivicDB> =>
  OWNER_ONLINE_BUILD ? import("@/hosted/ownerDB").then(module => module.createOwnerDB()) : new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("canvases")) {
        db.createObjectStore("canvases", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("definitions")) {
        db.createObjectStore("definitions", { keyPath: "key" });
      }
    };
    open.onerror = () =>
      reject(open.error ?? new Error("failed to open vivic db"));
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close();
      const wrapper: VivicDB = {
        async getAllCanvases() {
          const tx = db.transaction("canvases", "readonly");
          const rows = await reqToPromise(tx.objectStore("canvases").getAll());
          await txDone(tx);
          return rows
            .map(recoverCanvasRecord)
            .filter((r): r is CanvasRecord => Boolean(r));
        },
        async getCanvas(id) {
          const tx = db.transaction("canvases", "readonly");
          const raw = await reqToPromise(tx.objectStore("canvases").get(id));
          await txDone(tx);
          return recoverCanvasRecord(raw);
        },
        async putCanvas(record) {
          const tx = db.transaction("canvases", "readwrite");
          const store = tx.objectStore("canvases");
          const previous = await reqToPromise(store.get(record.id));
          store.put(preserveCanvasRecovery(record, previous));
          await txDone(tx);
        },
        async deleteCanvas(id) {
          const tx = db.transaction("canvases", "readwrite");
          tx.objectStore("canvases").delete(id);
          await txDone(tx);
          await removeCanvasFileAssets(id);
        },
        async getMeta(key) {
          const tx = db.transaction("meta", "readonly");
          const raw = await reqToPromise(tx.objectStore("meta").get(key));
          await txDone(tx);
          return (raw as { value?: string } | undefined)?.value;
        },
        async setMeta(key, value) {
          const tx = db.transaction("meta", "readwrite");
          tx.objectStore("meta").put({ key, value });
          await txDone(tx);
        },
        async loadCardDefinitions() {
          const tx = db.transaction("definitions", "readonly");
          const rows: StoredCardDefinition[] = await reqToPromise(tx.objectStore("definitions").getAll());
          await txDone(tx);
          return rows;
        },
        async saveCardDefinition(record) {
          const tx = db.transaction("definitions", "readwrite");
          tx.objectStore("definitions").put(record);
          await txDone(tx);
        },
        async deleteCardDefinition(key) {
          const tx = db.transaction("definitions", "readwrite");
          tx.objectStore("definitions").delete(key);
          await txDone(tx);
        },
        async reset(fresh) {
          const record = CanvasRecordSchema.parse(fresh);
          const tx = db.transaction(["canvases", "meta", "definitions"], "readwrite");
          tx.objectStore("canvases").clear();
          tx.objectStore("meta").clear();
          tx.objectStore("definitions").clear();
          tx.objectStore("canvases").put(record);
          tx.objectStore("meta").put({ key: "lastCanvasId", value: record.id });
          await txDone(tx);
          // Photos added to scene cards live in their own local database.
          await clearMedia();
          await clearAllFileAssets();
          notifyDataReset();
        },
        close() {
          db.close();
        },
      };
      resolve(wrapper);
    };
  });
