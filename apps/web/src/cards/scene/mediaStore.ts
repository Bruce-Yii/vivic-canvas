/**
 * Local photo blobs for scene cards. A separate IndexedDB database keeps the
 * canvas DB schema untouched; cards only hold `media:<id>` references. Photos
 * are re-encoded before storage (strips EXIF/GPS) and never leave this browser.
 */
const DB_NAME = "vivic-media";
const STORE = "blobs";
export const MEDIA_PREFIX = "media:";

interface MediaRow { id: string; blob: Blob; width: number; height: number; createdAt: string }

let opening: Promise<IDBDatabase | null> | null = null;
const openMediaDb = (): Promise<IDBDatabase | null> => {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  opening ??= new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
      };
      request.onsuccess = () => {
        const db = request.result;
        // Never block a future upgrade from another tab.
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
      request.onerror = () => { opening = null; resolve(null); };
      request.onblocked = () => { opening = null; resolve(null); };
    } catch { opening = null; resolve(null); }
  });
  return opening;
};

const run = async <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => {
  const db = await openMediaDb();
  if (!db) return undefined;
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = body(tx.objectStore(STORE));
    let result: T | undefined;
    if (request) request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error("media store error"));
    tx.onabort = () => reject(tx.error ?? new Error("media store aborted"));
  });
};

const randomId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

export const isMediaRef = (src: string | undefined): src is string => Boolean(src?.startsWith(MEDIA_PREFIX));

export async function putMedia(blob: Blob, size: { width: number; height: number }): Promise<string> {
  const id = randomId();
  const row: MediaRow = { id, blob, width: size.width, height: size.height, createdAt: new Date().toISOString() };
  await run("readwrite", store => { store.put(row); });
  if (!(await openMediaDb())) throw new Error("当前浏览器无法在本地保存照片。");
  return `${MEDIA_PREFIX}${id}`;
}

export async function getMediaBlob(ref: string): Promise<Blob | undefined> {
  if (!isMediaRef(ref)) return undefined;
  const row = await run<MediaRow | undefined>("readonly", store => store.get(ref.slice(MEDIA_PREFIX.length)) as IDBRequest<MediaRow | undefined>).catch(() => undefined);
  return row?.blob;
}
export async function getMediaAsset(ref: string): Promise<Pick<MediaRow, "blob" | "width" | "height"> | undefined> {
  if (!/^media:[A-Za-z0-9_-]{1,80}$/.test(ref)) return undefined;
  return run<MediaRow | undefined>("readonly", store => store.get(ref.slice(MEDIA_PREFIX.length)) as IDBRequest<MediaRow | undefined>).catch(() => undefined);
}

export async function listMediaRefs(): Promise<string[]> {
  const keys = await run<IDBValidKey[]>("readonly", store => store.getAllKeys()).catch(() => undefined);
  return (keys ?? []).map(key => `${MEDIA_PREFIX}${String(key)}`);
}

export async function deleteMedia(refs: string[]): Promise<void> {
  const ids = refs.filter(isMediaRef).map(ref => ref.slice(MEDIA_PREFIX.length));
  if (!ids.length) return;
  await run("readwrite", store => { ids.forEach(id => store.delete(id)); }).catch(() => undefined);
}

export async function clearMedia(): Promise<void> {
  await run("readwrite", store => { store.clear(); }).catch(() => undefined);
}

/** Every `media:` reference inside arbitrary card data (used for cleanup). */
export function collectMediaRefs(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") { if (isMediaRef(value)) into.add(value); }
  else if (Array.isArray(value)) value.forEach(item => collectMediaRefs(item, into));
  else if (value && typeof value === "object") Object.values(value).forEach(item => collectMediaRefs(item, into));
  return into;
}

