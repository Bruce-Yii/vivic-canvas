import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ActionEnvelopeSchema, HostedReminderNoticeSchema, HostedSpaceCommandRequestSchema,
  type ActionEnvelope, type CardRecord, type HostedSpaceCommandRequest, type HostedSpaceCommandResult, type HostedSpaceSnapshot, type HostedSpaceSummary,
} from "@vivic/contracts";
import { z } from "zod";
import { executeHostedCommand, executeHostedEnvelope, hostedImageSources, parseCard, type SpaceContent, type SpaceDocument } from "./executor.js";
import { SpaceError, invalid } from "./errors.js";
import { acquireSpaceLock } from "./lock.js";
import type { OwnerCanvas } from "../hosted/owner.js";
import { DecisionTraceSchema, type DecisionTrace } from "../decision/trace.js";
import { redactDecisionText } from "../decision/logging.js";

export interface SpaceIdentity { accountId: string; user: { id: string; username: string }; device: { id: string; name: string } }
export interface HostedSpaceStoreOptions { dataDir: string; inviteCode?: string; now?: () => number }
export interface SpaceDevice { id: string; name: string; createdAt: string; lastSeenAt: string; expiresAt: string }
export interface SpaceAccount { id: string; username: string }
export interface DecisionLogEntry { id: number; at: string; accountId: string; spaceId: string | null;
  path: "browser" | "task"; text: string; trace: DecisionTrace; outcome: string | null; undone: boolean }
export interface SpaceEnvelopeRequest { requestId: string; expectedVersion: number; envelope: ActionEnvelope }
export type HostedCardAssetAuthority = "user" | "provider" | "migration";
export type HostedCardAssetValidator = (accountId: string, spaceId: string, card: CardRecord, authority: HostedCardAssetAuthority) => CardRecord;
interface SessionResult { identity: SpaceIdentity; token: string; expiresAt: number }
interface SpaceRow { id: string; account_id: string; title: string; version: number; updated_at: string; document_json: string }
interface AccountRow { id: string; username: string; password_salt: string; password_hash: string; cursor: number }
interface DeviceRow { id: string; account_id: string; name: string; created_at: string; last_seen_at: string; expires_at: number; revoked_at: number | null }
interface History { undo: Array<{ before: SpaceContent; after: SpaceContent }>; redo: Array<{ before: SpaceContent; after: SpaceContent }>; version: number }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
};
const passwordHash = (password: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) =>
  scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
const missing = (): never => { throw new SpaceError(404, "space-not-found", "空间不存在。"); };
const badAuth = (): never => { throw new SpaceError(401, "invalid-credentials", "用户名或密码不正确。"); };
const idSchema = z.string().min(1).max(128);
const envelopeRequest = z.strictObject({ requestId: idSchema, expectedVersion: z.int().min(0), envelope: ActionEnvelopeSchema });
const parseUsername = (value: string) => {
  const name = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (!/^[a-z0-9][a-z0-9_.-]{2,39}$/.test(name)) invalid("用户名需要3–40位英文字母、数字、点、下划线或短横线。");
  return name;
};
const parsePassword = (value: string) => {
  if (value.length < 12 || value.length > 256 || Buffer.byteLength(value) > 1024) invalid("密码需要12–256个字符。");
  return value;
};
const deviceName = (value?: string) => {
  const name = value?.trim() || "浏览器";
  if (name.length > 80 || /[\p{Cc}]/u.test(name)) invalid("设备名称无效。");
  return name;
};

/** One process owns this WAL database. All commits use synchronous FULL durability and foreign keys. */
export class HostedSpaceStore {
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly releaseLock: () => void;
  private transactionDepth = 0;
  private disposed = false;
  private cardAssetValidator?: HostedCardAssetValidator;
  constructor(options: HostedSpaceStoreOptions) {
    if (!options.dataDir?.trim()) throw new Error("Space dataDir is required.");
    this.now = options.now ?? Date.now;
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.databasePath = path.join(path.resolve(options.dataDir), "space.sqlite");
    if (options.inviteCode && (options.inviteCode.length < 12 || options.inviteCode.length > 256)) throw new Error("Space inviteCode must contain 12–256 characters.");
    this.releaseLock = acquireSpaceLock(path.dirname(this.databasePath));
    let database: DatabaseSync | undefined;
    try {
    database = new DatabaseSync(this.databasePath);
    this.db = database;
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS invitations (digest TEXT PRIMARY KEY, consumed_by TEXT REFERENCES accounts(id), consumed_at INTEGER) STRICT;
      CREATE TABLE IF NOT EXISTS decision_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, account_id TEXT NOT NULL, space_id TEXT,
        path TEXT NOT NULL, text TEXT NOT NULL, trace_json TEXT NOT NULL, outcome TEXT, undone INTEGER DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS decision_log_account ON decision_log(account_id, id DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS decision_log_trace ON decision_log(account_id, json_extract(trace_json, '$.id'));
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token_digest TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL, revoked_at INTEGER,
        UNIQUE(account_id, id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS devices_account ON devices(account_id);
      CREATE TABLE IF NOT EXISTS pairs (
        code_digest TEXT PRIMARY KEY, account_id TEXT NOT NULL, issuer_device_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL, consumed_at INTEGER,
        FOREIGN KEY(account_id, issuer_device_id) REFERENCES devices(account_id, id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        title TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 0), updated_at TEXT NOT NULL, document_json TEXT NOT NULL,
        UNIQUE(account_id, id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS spaces_account ON spaces(account_id);
      CREATE TABLE IF NOT EXISTS commands (
        account_id TEXT NOT NULL, space_id TEXT NOT NULL, request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, version INTEGER NOT NULL, committed_at TEXT NOT NULL,
        PRIMARY KEY(account_id, space_id, request_id),
        FOREIGN KEY(account_id, space_id) REFERENCES spaces(account_id, id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS space_creations (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        PRIMARY KEY(account_id, request_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS histories (
        account_id TEXT NOT NULL, space_id TEXT NOT NULL, actor_id TEXT NOT NULL, history_json TEXT NOT NULL,
        PRIMARY KEY(account_id, space_id, actor_id),
        FOREIGN KEY(account_id, space_id) REFERENCES spaces(account_id, id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS account_values (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, key TEXT NOT NULL, value_json TEXT NOT NULL,
        PRIMARY KEY(account_id, key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY, started_at INTEGER NOT NULL, count INTEGER NOT NULL CHECK(count >= 0)
      ) STRICT;
      PRAGMA user_version = 1;`);
    if (options.inviteCode) {
      this.db.prepare("INSERT OR IGNORE INTO invitations(digest) VALUES (?)").run(digest(options.inviteCode));
    }
    } catch (error) {
      try { database?.close(); } finally { this.releaseLock(); }
      throw error;
    }
  }
  transaction<T>(operation: () => T): T {
    if (this.disposed) throw new SpaceError(503, "space-shutting-down", "空间服务已关闭。");
    const level = this.transactionDepth++, savepoint = `space_nested_${level}`;
    try {
      this.db.exec(level ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Space transactions must be synchronous.");
      this.db.exec(level ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec(level ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : "ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally { this.transactionDepth--; }
  }
  private stamp() { return new Date(this.now()).toISOString(); }
  private account(accountId: string): AccountRow {
    return this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as unknown as AccountRow
      ?? (() => { throw new SpaceError(401, "session-required", "请先登录。"); })();
  }
  listAccounts(): SpaceAccount[] { return this.db.prepare("SELECT id, username FROM accounts ORDER BY id").all() as unknown as SpaceAccount[]; }
  recordDecisionLog(accountId: string, input: { spaceId?: string; path: "browser" | "task"; text: string; trace: DecisionTrace; outcome?: string }): { id: number; inserted: boolean } {
    this.account(accountId);
    const trace = DecisionTraceSchema.parse(JSON.parse(JSON.stringify(input.trace,
      (_key, value) => typeof value === "string" ? redactDecisionText(value) : value)));
    const previous = this.db.prepare("SELECT id, trace_json FROM decision_log WHERE account_id=? AND json_extract(trace_json,'$.id')=?")
      .get(accountId, trace.id) as { id: number; trace_json: string } | undefined;
    if (previous) {
      const wasPending = (JSON.parse(previous.trace_json) as DecisionTrace).status === "pending";
      if (trace.status !== "pending" || wasPending) this.db.prepare("UPDATE decision_log SET trace_json=? WHERE id=? AND account_id=?")
        .run(JSON.stringify(trace), previous.id, accountId);
      return { id: previous.id, inserted: false };
    }
    const spaceId = input.spaceId && this.db.prepare("SELECT id FROM spaces WHERE account_id=? AND id=?").get(accountId, input.spaceId) ? input.spaceId : null;
    const saved = this.db.prepare("INSERT INTO decision_log(at,account_id,space_id,path,text,trace_json,outcome) VALUES(?,?,?,?,?,?,?)")
      .run(this.stamp(), accountId, spaceId, input.path, redactDecisionText(input.text), JSON.stringify(trace), input.outcome ?? null);
    this.db.prepare("DELETE FROM decision_log WHERE id NOT IN (SELECT id FROM decision_log ORDER BY id DESC LIMIT 20000)").run();
    return { id: Number(saved.lastInsertRowid), inserted: true };
  }
  listDecisionLogs(accountId: string, limit = 200): DecisionLogEntry[] {
    this.account(accountId);
    const count = Math.min(200, Math.max(1, Number.isSafeInteger(limit) ? limit : 200));
    const rows = this.db.prepare("SELECT * FROM decision_log WHERE account_id=? ORDER BY id DESC LIMIT ?").all(accountId, count) as unknown as Array<{
      id: number; at: string; account_id: string; space_id: string | null; path: "browser" | "task";
      text: string; trace_json: string; outcome: string | null; undone: number;
    }>;
    return rows.map(row => ({ id: row.id, at: row.at, accountId: row.account_id, spaceId: row.space_id,
      path: row.path, text: row.text, trace: JSON.parse(row.trace_json), outcome: row.outcome, undone: row.undone === 1 }));
  }
  setDecisionOutcome(accountId: string, traceId: string, outcome: string): void {
    this.db.prepare("UPDATE decision_log SET outcome=? WHERE account_id=? AND json_extract(trace_json,'$.id')=?")
      .run(outcome.slice(0, 32), accountId, traceId);
  }
  setDecisionTaskOutcome(accountId: string, taskId: string, outcome: "succeeded" | "failed"): void {
    this.db.prepare("UPDATE decision_log SET outcome=? WHERE account_id=? AND json_extract(trace_json,'$.taskId')=? AND (outcome IS NULL OR outcome IN ('pending','proposed'))")
      .run(outcome, accountId, taskId);
  }
  markLastDecisionUndone(accountId: string, spaceId?: string): void {
    this.db.prepare(`UPDATE decision_log SET undone=1 WHERE id=(SELECT id FROM decision_log
      WHERE account_id=? AND at>=? AND (? IS NULL OR space_id=?)
        AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(trace_json,'$.legacyActionTypes')) WHERE value='history.undo')
      ORDER BY id DESC LIMIT 1)`).run(accountId, new Date(this.now() - 30_000).toISOString(), spaceId ?? null, spaceId ?? null);
  }
  /** Trusted host-module capability, never a request option. Bare stores fail closed for controlled photo writes. */
  setCardAssetValidator(validator: HostedCardAssetValidator): void { this.cardAssetValidator = validator; }
  private validateCardAssets(accountId: string, spaceId: string, before: SpaceContent, after: SpaceContent, authority: HostedCardAssetAuthority): SpaceContent {
    const originals = new Map(before.document.cards.map(card => [card.id, card]));
    const cards = after.document.cards.map(card => {
      const sources = hostedImageSources(card), photo = card.type === "GalleryCard" || card.type === "PhotoCoverCard";
      if (!sources.length && !photo) return card;
      const previous = originals.get(card.id);
      if (previous?.type === card.type && canonical(previous.displayProps) === canonical(card.displayProps) && canonical(previous.sourceData) === canonical(card.sourceData)) return card;
      if (!this.cardAssetValidator) {
        if (sources.some(source => source.startsWith("media:")) || photo && (sources.length || authority === "user")) {
          throw new SpaceError(503, "asset-validation-required", "请通过已连接原件服务的Space操作图片。");
        }
        return card;
      }
      const checked = parseCard(this.cardAssetValidator(accountId, spaceId, card, authority));
      if (checked.id !== card.id || checked.type !== card.type) invalid("原件校验不能改变卡片身份。");
      return checked;
    });
    return { ...after, document: { ...after.document, cards } };
  }
  getAccountValue<T = unknown>(accountId: string, key: string): T | undefined {
    this.account(accountId);
    const row = this.db.prepare("SELECT value_json FROM account_values WHERE account_id = ? AND key = ?").get(accountId, key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : undefined;
  }
  /** Trusted host modules only; stream persisted migration/log records without exposing SQL or HTTP selectors. */
  *iterateAccountValues(accountId: string, prefix: string): IterableIterator<{ key: string; value: unknown }> {
    this.account(accountId);
    if (!prefix || prefix.length > 200) invalid("持久化键前缀无效。");
    for (const row of this.db.prepare("SELECT key, value_json FROM account_values WHERE account_id = ? AND substr(key, 1, ?) = ? ORDER BY key").iterate(accountId, prefix.length, prefix)) {
      yield { key: row.key as string, value: JSON.parse(row.value_json as string) as unknown };
    }
  }
  setAccountValue(accountId: string, key: string, value: unknown): void {
    this.account(accountId);
    if (!key || key.length > 200) invalid("持久化键无效。");
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json) > 16 * 1024 * 1024) invalid("持久化数据超过限制。");
    this.db.prepare("INSERT INTO account_values(account_id, key, value_json) VALUES (?, ?, ?) ON CONFLICT(account_id, key) DO UPDATE SET value_json = excluded.value_json").run(accountId, key, json);
  }
  deleteAccountValue(accountId: string, key: string): void { this.account(accountId); this.db.prepare("DELETE FROM account_values WHERE account_id = ? AND key = ?").run(accountId, key); }
  /** Persisted limiter also survives a process restart; keys must be server-chosen digests. */
  takeRateLimit(key: string, limit: number, windowMs = 60000): boolean {
    return this.transaction(() => {
      const time = this.now();
      this.db.prepare("DELETE FROM rate_limits WHERE started_at < ?").run(time - 24 * 60 * 60_000);
      const row = this.db.prepare("SELECT started_at, count FROM rate_limits WHERE key = ?").get(key) as { started_at: number; count: number } | undefined;
      const reset = !row || time - row.started_at >= windowMs;
      if (!reset && row.count >= limit) return false;
      this.db.prepare("INSERT INTO rate_limits(key, started_at, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET started_at = excluded.started_at, count = excluded.count")
        .run(key, reset ? time : row.started_at, reset ? 1 : row.count + 1);
      return true;
    });
  }
  private newSession(accountId: string, name?: string): SessionResult {
    const active = this.db.prepare("SELECT count(*) AS count FROM devices WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ?").get(accountId, this.now()) as { count: number };
    if (active.count >= 32) throw new SpaceError(409, "device-limit", "请先撤销不再使用的设备。");
    const account = this.account(accountId), token = randomBytes(32).toString("base64url"), id = `device_${randomUUID()}`, stamp = this.stamp(), expiresAt = this.now() + 30 * 24 * 60 * 60_000;
    const nameValue = deviceName(name);
    this.db.prepare("INSERT INTO devices(id, account_id, token_digest, name, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, accountId, digest(token), nameValue, stamp, stamp, expiresAt);
    return { token, expiresAt, identity: { accountId, user: { id: accountId, username: account.username }, device: { id, name: nameValue } } };
  }
  async register(input: { invite: string; username: string; password: string; deviceName?: string }): Promise<SessionResult> {
    const username = parseUsername(input.username), password = parsePassword(input.password), name = deviceName(input.deviceName);
    const salt = randomBytes(24).toString("base64url"), hash = (await passwordHash(password, salt)).toString("base64url");
    return this.transaction(() => {
      const invitation = this.db.prepare("SELECT consumed_by FROM invitations WHERE digest = ?").get(digest(input.invite)) as { consumed_by: string | null } | undefined;
      if (!invitation || invitation.consumed_by !== null) throw new SpaceError(403, "invite-invalid", "邀请码无效或已使用。");
      if (this.db.prepare("SELECT id FROM accounts WHERE username = ?").get(username)) throw new SpaceError(409, "username-unavailable", "用户名不可用。");
      const id = `account_${randomUUID()}`;
      this.db.prepare("INSERT INTO accounts(id, username, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(id, username, salt, hash, this.stamp());
      const consumed = this.db.prepare("UPDATE invitations SET consumed_by = ?, consumed_at = ? WHERE digest = ? AND consumed_by IS NULL").run(id, this.now(), digest(input.invite));
      if (consumed.changes !== 1) throw new Error("Invitation was not atomically consumed.");
      this.ensureInitialSpace(id);
      return this.newSession(id, name);
    });
  }
  async login(input: { username: string; password: string; deviceName?: string }): Promise<SessionResult> {
    const username = parseUsername(input.username), password = parsePassword(input.password), name = deviceName(input.deviceName);
    const row = this.db.prepare("SELECT * FROM accounts WHERE username = ?").get(username) as unknown as AccountRow | undefined;
    // Missing users take the same expensive password path and return the same error.
    const key = await passwordHash(password, row?.password_salt ?? "vivic-space-missing-account-salt");
    if (!row || !timingSafeEqual(key, Buffer.from(row.password_hash, "base64url"))) return badAuth();
    return this.transaction(() => { this.ensureInitialSpace(row.id); return this.newSession(row.id, name); });
  }
  authenticateToken(token: string): SpaceIdentity | null {
    if (this.disposed || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare("SELECT d.*, a.username FROM devices d JOIN accounts a ON a.id = d.account_id WHERE d.token_digest = ? AND d.revoked_at IS NULL AND d.expires_at > ?")
      .get(digest(token), this.now()) as unknown as (DeviceRow & { username: string }) | undefined;
    if (!row) return null;
    if (this.now() - Date.parse(row.last_seen_at) >= 60_000) this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(this.stamp(), row.id);
    return { accountId: row.account_id, user: { id: row.account_id, username: row.username }, device: { id: row.id, name: row.name } };
  }
  assertDeviceActive(accountId: string, deviceId: string): void {
    if (!this.db.prepare("SELECT id FROM devices WHERE account_id = ? AND id = ? AND revoked_at IS NULL AND expires_at > ?").get(accountId, deviceId, this.now())) {
      throw new SpaceError(401, "device-revoked", "设备授权已失效，请重新登录。");
    }
  }
  listDevices(accountId: string): SpaceDevice[] {
    this.account(accountId);
    return (this.db.prepare("SELECT id, name, created_at, last_seen_at, expires_at FROM devices WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at, id")
      .all(accountId, this.now()) as unknown as Array<Pick<DeviceRow, "id" | "name" | "created_at" | "last_seen_at" | "expires_at">>)
      .map(row => ({ id: row.id, name: row.name, createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: new Date(row.expires_at).toISOString() }));
  }
  revokeDevice(accountId: string, targetId: string, issuerDeviceId: string): void {
    this.transaction(() => {
      this.assertDeviceActive(accountId, issuerDeviceId);
      const result = this.db.prepare("UPDATE devices SET revoked_at = ? WHERE account_id = ? AND id = ? AND revoked_at IS NULL").run(this.now(), accountId, targetId);
      if (!result.changes) throw new SpaceError(404, "device-not-found", "设备不存在或已撤销。");
    });
  }
  createPair(accountId: string, deviceId: string): { code: string; expiresAt: string } {
    return this.transaction(() => {
      this.assertDeviceActive(accountId, deviceId);
      this.db.prepare("DELETE FROM pairs WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(this.now());
      // Issuing a replacement invalidates the issuer's previous displayed code.
      this.db.prepare("DELETE FROM pairs WHERE issuer_device_id = ?").run(deviceId);
      const code = randomBytes(9).toString("base64url"), expiresAt = this.now() + 5 * 60_000;
      this.db.prepare("INSERT INTO pairs(code_digest, account_id, issuer_device_id, expires_at) VALUES (?, ?, ?, ?)").run(digest(code), accountId, deviceId, expiresAt);
      return { code, expiresAt: new Date(expiresAt).toISOString() };
    });
  }
  claimPair(code: string, name?: string): SessionResult {
    return this.transaction(() => {
      const pair = this.db.prepare("SELECT * FROM pairs WHERE code_digest = ? AND consumed_at IS NULL AND expires_at > ?").get(digest(code), this.now()) as { account_id: string; issuer_device_id: string } | undefined;
      if (!pair) throw new SpaceError(403, "pair-invalid", "设备码无效、已使用或已过期。");
      this.assertDeviceActive(pair.account_id, pair.issuer_device_id);
      const session = this.newSession(pair.account_id, name);
      this.db.prepare("UPDATE pairs SET consumed_at = ? WHERE code_digest = ? AND consumed_at IS NULL").run(this.now(), digest(code));
      return session;
    });
  }
  private ensureInitialSpace(accountId: string) {
    if (!this.db.prepare("SELECT id FROM spaces WHERE account_id = ? LIMIT 1").get(accountId)) this.insertSpace(accountId, "我的 Space");
  }
  private insertSpace(accountId: string, title: string, requestedId?: string): string {
    this.account(accountId);
    const count = this.db.prepare("SELECT count(*) AS count FROM spaces WHERE account_id = ?").get(accountId) as { count: number };
    if (count.count >= 100) throw new SpaceError(409, "space-limit", "每个账号最多创建100个空间。");
    const id = requestedId ?? `space_${randomUUID()}`;
    this.db.prepare("INSERT INTO spaces(id, account_id, title, version, updated_at, document_json) VALUES (?, ?, ?, 0, ?, ?)").run(id, accountId, title, this.stamp(), JSON.stringify({ cards: [] }));
    this.db.prepare("UPDATE accounts SET cursor = cursor + 1 WHERE id = ?").run(accountId);
    return id;
  }
  createSpace(accountId: string, input: { title: string; requestId: string }, deviceId?: string): { ok: true; space: HostedSpaceSummary; snapshot: HostedSpaceSnapshot; deduplicated?: boolean } {
    const parsed = z.strictObject({ title: z.string().trim().min(1).max(120), requestId: idSchema }).safeParse(input);
    if (!parsed.success) invalid();
    return this.transaction(() => {
      if (deviceId) this.assertDeviceActive(accountId, deviceId);
      const fingerprint = digest(canonical(parsed.data));
      const prior = this.db.prepare("SELECT fingerprint, space_id FROM space_creations WHERE account_id = ? AND request_id = ?").get(accountId, input.requestId) as { fingerprint: string; space_id: string } | undefined;
      if (prior && prior.fingerprint !== fingerprint) throw new SpaceError(409, "request-id-conflict", "此请求编号已用于其他内容。");
      const id = prior?.space_id ?? this.insertSpace(accountId, parsed.data.title);
      if (!prior) this.db.prepare("INSERT INTO space_creations(account_id, request_id, fingerprint, space_id) VALUES (?, ?, ?, ?)").run(accountId, input.requestId, fingerprint, id);
      const snapshot = this.getSnapshot(accountId, id), { cards: _cards, ...space } = snapshot.space;
      return { ok: true, space, snapshot, ...(prior ? { deduplicated: true } : {}) };
    });
  }
  listSpaces(accountId: string): HostedSpaceSummary[] {
    this.account(accountId);
    return (this.db.prepare("SELECT id, title, version, updated_at FROM spaces WHERE account_id = ? ORDER BY updated_at DESC, id").all(accountId) as unknown as SpaceRow[])
      .map(row => ({ id: row.id, title: row.title, version: row.version, updatedAt: row.updated_at }));
  }
  saveOwnerCanvas(accountId: string, input: { record: OwnerCanvas; expectedVersion: number | null; requestId: string }, deviceId: string): void {
    this.transaction(() => {
      this.assertDeviceActive(accountId, deviceId);
      const { record, requestId } = input;
      const exists = this.db.prepare("SELECT account_id FROM spaces WHERE id = ?").get(record.id) as { account_id: string } | undefined;
      if (exists && exists.account_id !== accountId) missing();
      if (!exists) {
        if (input.expectedVersion !== null) missing();
        this.insertSpace(accountId, record.title, record.id);
      } else if (input.expectedVersion === null && !this.getReceipt(accountId, record.id, requestId)) {
        throw new SpaceError(409, "version-conflict", "画布已存在，请重新载入后重试。");
      }
      const expectedVersion = input.expectedVersion ?? 0;
      this.replaceSpaceDocument(accountId, record.id, { requestId, expectedVersion, title: record.title,
        document: { cards: record.cardOrder.map(key => record.cardsById[key]!), ownerRecord: record, ownerServerVersion: expectedVersion + 1 } }, deviceId);
    });
  }
  deleteOwnerCanvas(accountId: string, spaceId: string, expectedVersion: number, deviceId: string): void {
    this.transaction(() => {
      this.assertDeviceActive(accountId, deviceId);
      const row = this.space(accountId, spaceId);
      if (row.version !== expectedVersion) throw new SpaceError(409, "version-conflict", "画布已有新修改，请重新载入后重试。", row.version);
      this.db.prepare("DELETE FROM spaces WHERE id = ? AND account_id = ?").run(spaceId, accountId);
      this.db.prepare("UPDATE accounts SET cursor = cursor + 1 WHERE id = ?").run(accountId);
    });
  }
  private space(accountId: string, spaceId: string): SpaceRow {
    return this.db.prepare("SELECT * FROM spaces WHERE account_id = ? AND id = ?").get(accountId, spaceId) as unknown as SpaceRow ?? missing();
  }
  /** Full document for migrations/backups; callers receive a detached JSON value. */
  getSpaceDocument(accountId: string, spaceId: string): SpaceDocument {
    const value = JSON.parse(this.space(accountId, spaceId).document_json) as SpaceDocument;
    return { ...value, cards: value.cards.map(parseCard) };
  }
  getSnapshot(accountId: string, spaceId: string): HostedSpaceSnapshot {
    const row = this.space(accountId, spaceId), account = this.account(accountId), value = JSON.parse(row.document_json) as SpaceDocument;
    const inbox = this.getAccountValue<unknown>(accountId, "reminderInbox"), parsedInbox = z.array(HostedReminderNoticeSchema).safeParse(inbox);
    return { space: { id: row.id, title: row.title, version: row.version, updatedAt: row.updated_at, cards: value.cards.map(parseCard) },
      spaces: this.listSpaces(accountId), cursor: account.cursor, reminders: parsedInbox.success ? parsedInbox.data.filter(notice => notice.canvasId === spaceId && Date.parse(notice.targetAt) > Date.now()).slice(-50) : [] };
  }
  getReceipt(accountId: string, spaceId: string, requestId: string): HostedSpaceCommandResult | null {
    this.space(accountId, spaceId);
    const row = this.db.prepare("SELECT version FROM commands WHERE account_id = ? AND space_id = ? AND request_id = ?").get(accountId, spaceId, requestId) as { version: number } | undefined;
    return row ? { ok: true, receipt: { requestId, status: "succeeded", version: row.version }, snapshot: this.getSnapshot(accountId, spaceId), deduplicated: true } : null;
  }
  applyCommand(accountId: string, spaceId: string, input: HostedSpaceCommandRequest, deviceId?: string): HostedSpaceCommandResult {
    const parsed = HostedSpaceCommandRequestSchema.safeParse(input);
    if (!parsed.success) invalid();
    return this.commit(accountId, spaceId, parsed.data.requestId, parsed.data.expectedVersion, { kind: "command", ...parsed.data }, deviceId,
      (current, version) => {
        const actor = deviceId ?? "internal", history = this.history(accountId, spaceId, actor);
        const command = parsed.data.command;
        if (command.type === "history.undo" || command.type === "history.redo") {
          if (!history || history.version !== version) throw new SpaceError(409, "history-conflict", "空间已由其他操作更新，无法覆盖后续修改。", version);
          const undo = command.type === "history.undo", source = undo ? history.undo : history.redo, destination = undo ? history.redo : history.undo, frame = source.pop();
          if (!frame) throw new SpaceError(409, "history-empty", undo ? "没有可撤销的操作。" : "没有可重做的操作。", version);
          const restored = this.validateCardAssets(accountId, spaceId, current, copy(undo ? frame.before : frame.after), "user");
          destination.push(frame); history.version = version + 1;
          this.saveHistory(accountId, spaceId, actor, history);
          if (undo) { try { this.markLastDecisionUndone(accountId, spaceId); } catch { /* telemetry does not affect undo */ } }
          return restored;
        }
        const next = this.validateCardAssets(accountId, spaceId, current, executeHostedCommand(current, command, this.stamp()), "user");
        this.recordActorHistory(accountId, spaceId, actor, current, next, version);
        return next;
      });
  }
  applyEnvelope(accountId: string, spaceId: string, input: SpaceEnvelopeRequest, deviceId?: string): HostedSpaceCommandResult {
    const parsed = envelopeRequest.safeParse(input);
    if (!parsed.success || parsed.data.envelope.canvasId !== spaceId || parsed.data.envelope.requestId !== parsed.data.requestId) invalid("执行计划与目标空间或请求编号不一致。");
    return this.commit(accountId, spaceId, input.requestId, input.expectedVersion, { kind: "envelope", ...parsed.data }, deviceId,
      (current, version) => {
        const next = this.validateCardAssets(accountId, spaceId, current, executeHostedEnvelope(current, parsed.data.envelope, this.stamp()), "provider");
        if (deviceId) this.recordActorHistory(accountId, spaceId, deviceId, current, next, version);
        return next;
      });
  }
  /** Internal migration hook preserves legacy packs/viewport/recovery fields alongside validated stable card IDs. */
  replaceSpaceDocument(accountId: string, spaceId: string, input: { requestId: string; expectedVersion: number; document: SpaceDocument; title?: string }, deviceId?: string): HostedSpaceCommandResult {
    if (!idSchema.safeParse(input.requestId).success || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
      || !input.document || !Array.isArray(input.document.cards) || input.document.cards.length > 1000
      || input.title !== undefined && !z.string().trim().min(1).max(120).safeParse(input.title).success) invalid();
    const cards = input.document.cards.map(parseCard);
    if (new Set(cards.map(card => card.id)).size !== cards.length) invalid("导入的卡片编号重复。");
    return this.commit(accountId, spaceId, input.requestId, input.expectedVersion, { kind: "migration", ...input }, deviceId,
      current => this.validateCardAssets(accountId, spaceId, current,
        { title: input.title?.trim() ?? current.title, document: { ...current.document, ...input.document, cards } }, "migration"));
  }
  private history(accountId: string, spaceId: string, actorId: string): History | undefined {
    const row = this.db.prepare("SELECT history_json FROM histories WHERE account_id = ? AND space_id = ? AND actor_id = ?").get(accountId, spaceId, actorId) as { history_json: string } | undefined;
    return row ? JSON.parse(row.history_json) as History : undefined;
  }
  private recordActorHistory(accountId: string, spaceId: string, actorId: string, before: SpaceContent, after: SpaceContent, version: number): void {
    const previous = this.history(accountId, spaceId, actorId);
    const history: History = previous?.version === version ? previous : { undo: [], redo: [], version };
    history.undo.push({ before, after }); history.undo = history.undo.slice(-40); history.redo = []; history.version = version + 1;
    while (history.undo.length > 1 && JSON.stringify(history).length > 4_000_000) history.undo.shift();
    this.saveHistory(accountId, spaceId, actorId, history);
  }
  private saveHistory(accountId: string, spaceId: string, actorId: string, history: History): void {
    this.db.prepare("INSERT INTO histories(account_id, space_id, actor_id, history_json) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, space_id, actor_id) DO UPDATE SET history_json = excluded.history_json").run(accountId, spaceId, actorId, JSON.stringify(history));
  }
  /** Retained originals remain quota-bearing while any device can restore their card reference. */
  hasAssetHistoryReference(accountId: string, spaceId: string, assetId: string): boolean {
    this.space(accountId, spaceId);
    const containsMedia = (value: unknown): boolean => typeof value === "string" ? value === `media:${assetId}`
      : Boolean(value && typeof value === "object" && Object.values(value).some(containsMedia));
    const uses = (content: SpaceContent) => content.document.cards.some(card => card.type === "FileCard" && card.displayProps.fileId === assetId
      || containsMedia(card.displayProps) || containsMedia(card.sourceData));
    // Iterate device histories rather than retaining all potentially large recovery frames in memory together.
    for (const value of this.db.prepare("SELECT history_json FROM histories WHERE account_id = ? AND space_id = ?").iterate(accountId, spaceId)) {
      const history = JSON.parse(value.history_json as string) as History;
      if ([...history.undo, ...history.redo].some(frame => uses(frame.before) || uses(frame.after))) return true;
    }
    return false;
  }
  private commit(accountId: string, spaceId: string, requestId: string, expectedVersion: number, payload: unknown, deviceId: string | undefined,
    update: (current: SpaceContent, version: number) => SpaceContent): HostedSpaceCommandResult {
    return this.transaction(() => {
      if (deviceId) this.assertDeviceActive(accountId, deviceId);
      const row = this.space(accountId, spaceId), fingerprint = digest(canonical(payload));
      const prior = this.db.prepare("SELECT fingerprint, version FROM commands WHERE account_id = ? AND space_id = ? AND request_id = ?").get(accountId, spaceId, requestId) as { fingerprint: string; version: number } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new SpaceError(409, "request-id-conflict", "此请求编号已用于其他内容。", row.version);
        return { ok: true, snapshot: this.getSnapshot(accountId, spaceId), deduplicated: true, receipt: { requestId, status: "succeeded", version: prior.version } };
      }
      if (row.version !== expectedVersion) throw new SpaceError(409, "version-conflict", "空间已更新，请读取最新内容后重试。", row.version);
      const document = JSON.parse(row.document_json) as SpaceDocument;
      const next = update({ title: row.title, document: { ...document, cards: document.cards.map(parseCard) } }, row.version);
      const json = JSON.stringify(next.document);
      if (Buffer.byteLength(json) > 16 * 1024 * 1024) throw new SpaceError(413, "space-data-limit", "空间内容与恢复归档合计超过16MiB限制。");
      const ids = next.document.cards.map(card => card.id);
      if (new Set(ids).size !== ids.length) invalid("卡片编号重复。");
      // Check again immediately before persistence, including callers doing async work before this transaction.
      if (deviceId) this.assertDeviceActive(accountId, deviceId);
      const version = row.version + 1, stamp = this.stamp();
      const persisted = this.db.prepare("UPDATE spaces SET title = ?, version = ?, updated_at = ?, document_json = ? WHERE account_id = ? AND id = ? AND version = ?")
        .run(next.title, version, stamp, json, accountId, spaceId, row.version);
      if (persisted.changes !== 1) throw new Error("Space version was not atomically updated.");
      this.db.prepare("INSERT INTO commands(account_id, space_id, request_id, fingerprint, version, committed_at) VALUES (?, ?, ?, ?, ?, ?)").run(accountId, spaceId, requestId, fingerprint, version, stamp);
      this.db.prepare("UPDATE accounts SET cursor = cursor + 1 WHERE id = ?").run(accountId);
      return { ok: true, snapshot: this.getSnapshot(accountId, spaceId), receipt: { requestId, status: "succeeded", version } };
    });
  }
  /** Local maintenance API only. VACUUM INTO snapshots the database, including committed WAL pages. */
  backup(destination: string): void {
    if (this.disposed) throw new SpaceError(503, "space-shutting-down", "空间服务已关闭。");
    if (this.transactionDepth) throw new Error("Space backup cannot run inside a transaction.");
    if (!path.isAbsolute(destination)) throw new Error("Space backup destination must be an absolute local path.");
    const target = path.resolve(destination);
    if (target.toLocaleLowerCase("en-US") === this.databasePath.toLocaleLowerCase("en-US") || existsSync(target)) throw new Error("Space backup destination must not already exist.");
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    this.db.prepare("VACUUM main INTO ?").run(target);
    chmodSync(target, 0o600);
    const file = openSync(target, "r+");
    try { fsyncSync(file); } finally { closeSync(file); }
  }
  dispose(): void { if (!this.disposed) { this.db.close(); this.disposed = true; this.releaseLock(); } }
}
const copy = <T>(value: T): T => structuredClone(value);
