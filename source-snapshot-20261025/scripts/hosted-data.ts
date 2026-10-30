/**
 * Offline, single-machine maintenance only. Stop the hosted service yourself first.
 * From apps/local-api (Node >=22):
 *   corepack pnpm exec tsx ../../scripts/hosted-data.ts --data-dir <absolute-directory> --backup-to <new-absolute-directory>
 *   corepack pnpm exec tsx ../../scripts/hosted-data.ts --restore-from <backup-directory> --restore-to <new-absolute-directory>
 * Destination parents must already exist. Existing destinations, symlinks, network
 * paths and dot traversal are rejected. Nothing stops a service or overwrites data.
 * Backups contain a VACUUM INTO snapshot, controlled assets and SHA256/size manifest.
 * Restore ALWAYS removes device sessions, pairing codes and login rate-limit state.
 * Accounts/password hashes, Space/card data and task/command receipts are retained.
 * .env/configuration and in-memory LLM/platform keys are never read or copied.
 * A manifest detects corruption; it is not a signature authenticating its creator.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { HostedSpaceStore } from "../apps/local-api/src/space/store.js";
import { acquireSpaceLock } from "../apps/local-api/src/space/lock.js";

type FailureCode = "arguments-invalid" | "path-invalid" | "target-exists" | "source-active" | "source-invalid" | "backup-invalid" | "integrity-failed" | "asset-deletion-pending" | "io-failed";
const messages: Record<FailureCode, string> = {
  "arguments-invalid": "只接受备份或恢复的一组路径参数，不接受密码或Key参数。",
  "path-invalid": "需要无符号链接、无点路径组件的本机绝对路径；目标父目录必须已存在。",
  "target-exists": "目标目录已经存在，未覆盖任何已有数据。",
  "source-active": "源目录仍由运行中的服务持有，请先自行停止服务。",
  "source-invalid": "源目录不是可用的当前版本Space数据目录。",
  "backup-invalid": "备份格式、文件清单或目录结构无效。",
  "integrity-failed": "数据库或资产完整性校验失败，未确认备份或恢复成功。",
  "asset-deletion-pending": "仍有原件删除操作未完成，请先通过服务恢复或重试删除，再停机备份。",
  "io-failed": "备份或恢复未完成，请检查磁盘与目录权限。",
};
class DataFailure extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) { super(messages[code]); this.code = code; }
}
interface Entry { path: string; bytes: number; sha256: string }
interface Manifest { format: "vivic-hosted-backup-1"; createdAt: string; files: Entry[] }
interface UnindexedAssets { files: number; bytes: number; action: "excluded-read-only" }
export type HostedDataReceipt = { ok: true; operation: "backup" | "restore"; directory: string; files: number; bytes: number;
  deviceAuthorization: "retained-in-offline-snapshot" | "cleared"; modelCredentials: "not-included"; unindexedAssets?: UnindexedAssets }
  | { ok: false; code: FailureCode; message: string };
const assetPattern = /^assets\/[a-f0-9]{64}\/[a-f0-9]{64}\.bin$/;
const expectedTables = ["accounts", "invitations", "devices", "pairs", "spaces", "commands", "space_creations", "histories", "account_values", "rate_limits"];
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function stat(filename: string): fs.Stats | undefined {
  try { return fs.lstatSync(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function absolute(raw: string): string {
  if (typeof raw !== "string" || !raw || raw.length > 4096 || !path.isAbsolute(raw) || /[\u0000-\u001f\u007f]/u.test(raw)
    || /^[\\/]{2}/.test(raw) || raw.split(/[\\/]/).some(part => part === "." || part === ".." || /[. ]$/.test(part))) throw new DataFailure("path-invalid");
  const value = path.resolve(raw), root = path.parse(value).root;
  if (value === root || value.slice(root.length).includes(":")) throw new DataFailure("path-invalid");
  return value;
}
/** Check every ancestor with lstat, including junctions on Windows and broken links. */
function checkPath(filename: string, kind: "directory" | "file" | "new-directory"): void {
  const root = path.parse(filename).root, parts = filename.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = stat(current), last = index === parts.length - 1;
    if (last && kind === "new-directory") {
      if (info) throw new DataFailure(info.isSymbolicLink() ? "path-invalid" : "target-exists");
      return;
    }
    if (!info || info.isSymbolicLink() || (last && kind === "file" ? !info.isFile() : !info.isDirectory())) throw new DataFailure("path-invalid");
  }
}
function separate(source: string, target: string): void {
  const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  // Resolve existing ancestors as well as lexical paths (including Windows aliases).
  const first = fold(fs.realpathSync(source)), second = fold(path.join(fs.realpathSync(path.dirname(target)), path.basename(target)));
  if (first === second || second.startsWith(first + path.sep) || first.startsWith(second + path.sep)) throw new DataFailure("path-invalid");
}
function syncFile(filename: string): void {
  const descriptor = fs.openSync(filename, "r+");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function measure(root: string, relative: string): Entry {
  const filename = path.join(root, ...relative.split("/")); checkPath(filename, "file");
  const before = fs.lstatSync(filename), hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes = 0;
  try { for (;;) { const length = fs.readSync(descriptor, buffer, 0, buffer.length, null); if (!length) break; bytes += length; hash.update(buffer.subarray(0, length)); } }
  finally { fs.closeSync(descriptor); }
  const after = fs.lstatSync(filename);
  if (!Number.isSafeInteger(bytes) || bytes !== before.size || after.size !== bytes || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new DataFailure("integrity-failed");
  return { path: relative, bytes, sha256: hash.digest("hex") };
}
function assetPaths(root: string): string[] {
  const directory = path.join(root, "assets"), info = stat(directory);
  if (!info) return [];
  checkPath(directory, "directory");
  const result: string[] = [];
  for (const namespace of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}$/.test(namespace.name) || !namespace.isDirectory() || namespace.isSymbolicLink()) throw new DataFailure("backup-invalid");
    const location = path.join(directory, namespace.name); checkPath(location, "directory");
    for (const item of fs.readdirSync(location, { withFileTypes: true })) {
      const relative = `assets/${namespace.name}/${item.name}`;
      if (!assetPattern.test(relative) || !item.isFile() || item.isSymbolicLink() || result.length >= 100_000) throw new DataFailure("backup-invalid");
      result.push(relative);
    }
  }
  return result.sort();
}
function inspectSchema(database: DatabaseSync): void {
  const version = database.prepare("PRAGMA user_version").get() as { user_version: number };
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  if (version.user_version !== 1 || tables.length !== expectedTables.length || expectedTables.some(name => !tables.some(table => table.name === name))
    || database.prepare("SELECT name FROM sqlite_schema WHERE type IN ('trigger', 'view')").all().length) throw new DataFailure("source-invalid");
}
function inspectDatabase(filename: string, assets: readonly Entry[]): Set<string> {
  checkPath(filename, "file");
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    inspectSchema(database);
    const integrity = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" || database.prepare("PRAGMA foreign_key_check").all().length) throw new DataFailure("integrity-failed");
    for (const row of database.prepare("SELECT value_json FROM account_values WHERE key LIKE 'asset-deletions:%'").iterate()) {
      const value: unknown = JSON.parse(row.value_json as string);
      if (!isRecord(value) || Object.keys(value).length) throw new DataFailure("asset-deletion-pending");
    }
    const available = new Map(assets.map(entry => [entry.path, entry]));
    const indexed = new Set<string>();
    const indexes = database.prepare("SELECT account_id, key, value_json FROM account_values WHERE key LIKE 'assets:%'").all() as Array<{ account_id: string; key: string; value_json: string }>;
    for (const row of indexes) {
      const spaceId = row.key.slice("assets:".length);
      if (!database.prepare("SELECT 1 FROM spaces WHERE account_id = ? AND id = ?").get(row.account_id, spaceId)) throw new DataFailure("integrity-failed");
      const value: unknown = JSON.parse(row.value_json);
      if (!isRecord(value)) throw new DataFailure("integrity-failed");
      for (const [id, asset] of Object.entries(value)) {
        if (!isRecord(asset) || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)
          || !["file_" + asset.sha256, "image_" + asset.sha256].includes(id)) throw new DataFailure("integrity-failed");
        const relative = `assets/${sha(`${row.account_id}\n${spaceId}`)}/${asset.sha256}.bin`, entry = available.get(relative);
        if (!entry || entry.sha256 !== asset.sha256 || entry.bytes !== asset.sizeBytes) throw new DataFailure("integrity-failed");
        indexed.add(relative);
      }
    }
    return indexed;
  } finally { database.close(); }
}
function copyEntry(source: string, target: string, entry: Entry): void {
  const from = path.join(source, ...entry.path.split("/")), to = path.join(target, ...entry.path.split("/"));
  checkPath(from, "file");
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); checkPath(path.dirname(to), "directory");
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, 0o600); syncFile(to);
  const copied = measure(target, entry.path);
  if (copied.bytes !== entry.bytes || copied.sha256 !== entry.sha256) throw new DataFailure("integrity-failed");
  syncDirectory(path.dirname(to));
}
function manifestFrom(directory: string): Manifest {
  const filename = path.join(directory, "manifest.json"); checkPath(filename, "file");
  if (fs.lstatSync(filename).size > 16 * 1024 * 1024) throw new DataFailure("backup-invalid");
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(filename, "utf8")); } catch { throw new DataFailure("backup-invalid"); }
  if (!isRecord(value) || value.format !== "vivic-hosted-backup-1" || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || !Array.isArray(value.files) || value.files.length > 100_001 || value.files.length < 1) throw new DataFailure("backup-invalid");
  const seen = new Set<string>(); const files: Entry[] = [];
  for (const entry of value.files) {
    if (!isRecord(entry) || typeof entry.path !== "string" || !(entry.path === "space.sqlite" || assetPattern.test(entry.path))
      || seen.has(entry.path) || typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new DataFailure("backup-invalid");
    seen.add(entry.path); files.push({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 });
  }
  if (!seen.has("space.sqlite")) throw new DataFailure("backup-invalid");
  return { format: "vivic-hosted-backup-1", createdAt: value.createdAt, files };
}
function verifyBackup(directory: string): Manifest {
  for (const entry of fs.readdirSync(directory)) if (!["space.sqlite", "manifest.json", "assets", "space.lock"].includes(entry)) throw new DataFailure("backup-invalid");
  const manifest = manifestFrom(directory), actualPaths = ["space.sqlite", ...assetPaths(directory)].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(manifest.files.map(entry => entry.path).sort())) throw new DataFailure("integrity-failed");
  for (const entry of manifest.files) {
    const actual = measure(directory, entry.path);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256 || assetPattern.test(entry.path) && path.basename(entry.path, ".bin") !== actual.sha256) throw new DataFailure("integrity-failed");
  }
  inspectDatabase(path.join(directory, "space.sqlite"), manifest.files.filter(entry => entry.path !== "space.sqlite"));
  return manifest;
}
function freshDirectory(target: string): void { checkPath(target, "new-directory"); fs.mkdirSync(target, { mode: 0o700 }); }
function cleanup(target: string): void {
  // This exact absolute directory was absent before this operation and created by it.
  try { checkPath(target, "directory"); fs.rmSync(target, { recursive: true, force: true }); } catch { /* Never turn a failed cleanup into a success receipt. */ }
}
function ownershipError(error: unknown): never {
  if (error instanceof Error && /already owned by a running process/.test(error.message)) throw new DataFailure("source-active");
  throw error;
}
function receipt(operation: "backup" | "restore", directory: string, files: readonly Entry[], unindexedAssets?: UnindexedAssets): HostedDataReceipt {
  return { ok: true, operation, directory, files: files.length, bytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    deviceAuthorization: operation === "restore" ? "cleared" : "retained-in-offline-snapshot", modelCredentials: "not-included",
    ...(unindexedAssets ? { unindexedAssets } : {}) };
}
function backup(source: string, target: string): HostedDataReceipt {
  checkPath(source, "directory"); checkPath(path.join(source, "space.sqlite"), "file"); checkPath(target, "new-directory"); separate(source, target);
  for (const name of ["space.lock", "space.sqlite-wal", "space.sqlite-shm"]) {
    const filename = path.join(source, name); if (stat(filename)) checkPath(filename, "file");
  }
  // Inspect under the service lock before the Store constructor can initialize schema.
  // This refuses unsupported databases without changing their schema/user_version.
  let preflightRelease: () => void;
  try { preflightRelease = acquireSpaceLock(source); } catch (error) { ownershipError(error); }
  try {
    const database = new DatabaseSync(path.join(source, "space.sqlite"), { readOnly: true });
    try { inspectSchema(database); } finally { database.close(); }
  } finally { preflightRelease(); }
  // Reacquire through the normal store. If a service wins the handoff, fail closed.
  let store: HostedSpaceStore;
  try { store = new HostedSpaceStore({ dataDir: source }); } catch (error) { ownershipError(error); }
  let created = false;
  try {
    const diskAssets = assetPaths(source).map(relative => measure(source, relative));
    const indexed = inspectDatabase(store.databasePath, diskAssets), assets = diskAssets.filter(entry => indexed.has(entry.path));
    const unindexed = diskAssets.filter(entry => !indexed.has(entry.path));
    const diagnostic: UnindexedAssets = { files: unindexed.length, bytes: unindexed.reduce((sum, entry) => sum + entry.bytes, 0), action: "excluded-read-only" };
    if (assets.some(entry => path.basename(entry.path, ".bin") !== entry.sha256)) throw new DataFailure("integrity-failed");
    freshDirectory(target); created = true;
    store.backup(path.join(target, "space.sqlite")); fs.mkdirSync(path.join(target, "assets"), { mode: 0o700 });
    for (const entry of assets) copyEntry(source, target, entry);
    const manifest: Manifest = { format: "vivic-hosted-backup-1", createdAt: new Date().toISOString(), files: [measure(target, "space.sqlite"), ...assets] };
    inspectDatabase(path.join(target, "space.sqlite"), assets);
    fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 }); syncFile(path.join(target, "manifest.json"));
    verifyBackup(target); syncDirectory(path.join(target, "assets")); syncDirectory(target); syncDirectory(path.dirname(target));
    return receipt("backup", target, manifest.files, diagnostic);
  } catch (error) { if (created) cleanup(target); throw error; }
  finally { store.dispose(); }
}
function restore(source: string, target: string): HostedDataReceipt {
  checkPath(source, "directory"); checkPath(target, "new-directory"); separate(source, target);
  if (stat(path.join(source, "space.lock"))) checkPath(path.join(source, "space.lock"), "file");
  let release: () => void;
  try { release = acquireSpaceLock(source); } catch (error) { ownershipError(error); }
  let created = false;
  try {
    const manifest = verifyBackup(source);
    freshDirectory(target); created = true; fs.mkdirSync(path.join(target, "assets"), { mode: 0o700 });
    for (const entry of manifest.files) copyEntry(source, target, entry);
    const database = new DatabaseSync(path.join(target, "space.sqlite"));
    try {
      database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE; DELETE FROM pairs; DELETE FROM devices; DELETE FROM rate_limits; COMMIT;");
      const devices = database.prepare("SELECT COUNT(*) AS count FROM devices").get() as { count: number };
      const pairs = database.prepare("SELECT COUNT(*) AS count FROM pairs").get() as { count: number };
      if (devices.count !== 0 || pairs.count !== 0) throw new DataFailure("integrity-failed");
    } finally { database.close(); }
    inspectDatabase(path.join(target, "space.sqlite"), manifest.files.filter(entry => entry.path !== "space.sqlite"));
    for (const entry of manifest.files.filter(entry => entry.path !== "space.sqlite")) {
      const actual = measure(target, entry.path);
      if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) throw new DataFailure("integrity-failed");
    }
    syncFile(path.join(target, "space.sqlite")); syncDirectory(path.join(target, "assets")); syncDirectory(target); syncDirectory(path.dirname(target));
    return receipt("restore", target, [measure(target, "space.sqlite"), ...manifest.files.filter(entry => entry.path !== "space.sqlite")]);
  } catch (error) { if (created) cleanup(target); throw error; }
  finally { release(); }
}

/** Safe CLI boundary; diagnostics never serialize SQL rows, filesystem errors or supplied arguments. */
export function runHostedData(args: readonly string[]): HostedDataReceipt {
  try {
    if (args.length !== 4 || args.some(value => typeof value !== "string")) throw new DataFailure("arguments-invalid");
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index]!, value = args[index + 1]!;
      if (!["--data-dir", "--backup-to", "--restore-from", "--restore-to"].includes(flag) || values.has(flag) || value.startsWith("--")) throw new DataFailure("arguments-invalid");
      values.set(flag, value);
    }
    const isBackup = values.has("--data-dir") && values.has("--backup-to"), isRestore = values.has("--restore-from") && values.has("--restore-to");
    if (isBackup === isRestore) throw new DataFailure("arguments-invalid");
    return isBackup ? backup(absolute(values.get("--data-dir")!), absolute(values.get("--backup-to")!))
      : restore(absolute(values.get("--restore-from")!), absolute(values.get("--restore-to")!));
  } catch (error) {
    const code = error instanceof DataFailure ? error.code : "io-failed";
    return { ok: false, code, message: messages[code] };
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runHostedData(process.argv.slice(2));
  console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1;
}
