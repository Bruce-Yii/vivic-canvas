import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { SecretBox, defaultSecretKeyPath } from "./secrets.js";
import {
  CreateProviderSchema, UpdateProviderSchema, maskApiKey, validateProtocolModel,
  type CreateProviderInput, type ProviderConfig, type ProviderErrorType,
  type ProviderRole, type ProviderStatus, type ProviderView, type UpdateProviderInput,
} from "./types.js";

interface PersistedProvider extends Omit<ProviderConfig, "apiKey"> {
  /** AES-GCM blob; absent when the provider has no key (local models). */
  apiKeyEnc?: string;
}

interface PersistedFile {
  version: 1;
  providers: PersistedProvider[];
}

interface RuntimeStatus {
  connected: boolean;
  latencyMs?: number;
  lastCheckedAt?: string;
  lastError?: string;
  errorType?: ProviderErrorType;
  models?: number;
}

export interface SecretCodec {
  encrypt(plaintext: string): string;
  decrypt(blob: string | undefined): string | undefined;
}

export interface ProviderStoreOptions {
  /** Directory for providers.json and .secret-key. */
  dataDir: string;
  /** Injected for tests; defaults to a real AES-GCM SecretBox. */
  secrets?: SecretCodec;
  /** `false` keeps everything in memory (online sessions must not inherit or write operator settings). */
  persist?: boolean;
  /** Injected for tests; defaults to the real filesystem. */
  fs?: {
    existsSync: typeof existsSync;
    readFileSync: typeof readFileSync;
    writeFileSync: typeof writeFileSync;
    mkdirSync: typeof mkdirSync;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Provider registry: settings live here and take precedence over the legacy
 * environment variables. An empty store leaves the old behaviour untouched.
 */
export class ProviderStore {
  readonly #filePath: string;
  readonly #box: SecretCodec;
  readonly #fs: NonNullable<ProviderStoreOptions["fs"]>;
  readonly #persist: boolean;
  readonly #configs = new Map<string, ProviderConfig>();
  readonly #status = new Map<string, RuntimeStatus>();

  constructor(options: ProviderStoreOptions) {
    this.#filePath = join(options.dataDir, "providers.json");
    this.#box = options.secrets ?? new SecretBox(defaultSecretKeyPath(options.dataDir));
    this.#fs = options.fs ?? { existsSync, readFileSync, writeFileSync, mkdirSync };
    this.#persist = options.persist !== false;
    if (this.#persist) this.#load();
  }

  #load(): void {
    try {
      if (!this.#fs.existsSync(this.#filePath)) return;
      const parsed: unknown = JSON.parse(this.#fs.readFileSync(this.#filePath, "utf8"));
      if (!isRecord(parsed) || !Array.isArray(parsed.providers)) return;
      for (const entry of parsed.providers) {
        const config = this.#fromPersisted(entry);
        if (config) this.#configs.set(config.id, config);
      }
    } catch {
      // A corrupt store must not prevent the app from booting; start empty.
    }
  }

  #fromPersisted(value: unknown): ProviderConfig | undefined {
    if (!isRecord(value)) return undefined;
    const id = typeof value.id === "string" ? value.id : undefined;
    const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl : undefined;
    const protocol = typeof value.protocol === "string" ? value.protocol : undefined;
    const name = typeof value.name === "string" ? value.name : undefined;
    if (!id || !baseUrl || !protocol || !name) return undefined;
    const roles = Array.isArray(value.roles)
      ? value.roles.filter((role): role is ProviderRole =>
          typeof role === "string" && ["main", "decision", "asr", "tts", "embedding"].includes(role))
      : [];
    return {
      id,
      name,
      kind: value.kind === "preset" ? "preset" : "custom",
      ...(typeof value.presetId === "string" ? { presetId: value.presetId } : {}),
      protocol: protocol as ProviderConfig["protocol"],
      baseUrl,
      ...(typeof value.apiKeyEnc === "string" ? { apiKey: this.#box.decrypt(value.apiKeyEnc) } : {}),
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      ...(isRecord(value.headers) ? {
        headers: Object.fromEntries(
          Object.entries(value.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
      } : {}),
      roles,
      enabled: value.enabled !== false,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    };
  }

  #persistToDisk(): void {
    if (!this.#persist) return;
    const providers: PersistedProvider[] = [...this.#configs.values()].map((config) => {
      const { apiKey, ...rest } = config;
      return {
        ...rest,
        ...(apiKey ? { apiKeyEnc: this.#box.encrypt(apiKey) } : {}),
      };
    });
    const payload: PersistedFile = { version: 1, providers };
    try {
      this.#fs.mkdirSync(dirname(this.#filePath), { recursive: true, mode: 0o700 });
      this.#fs.writeFileSync(this.#filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    } catch (error) {
      // Never log the payload (it contains ciphertext only, but still).
      console.error("[provider-store] persist failed:", error instanceof Error ? error.name : "unknown");
    }
  }

  list(): ProviderConfig[] {
    return [...this.#configs.values()];
  }

  get(id: string): ProviderConfig | undefined {
    return this.#configs.get(id);
  }

  /** The secret itself — internal callers only, never serialized. */
  getApiKey(id: string): string | undefined {
    return this.#configs.get(id)?.apiKey;
  }

  findForRole(role: ProviderRole): ProviderConfig | undefined {
    const candidates = [...this.#configs.values()].filter((config) => config.enabled && config.roles.includes(role));
    if (role === "main") {
      const stepfun = candidates.filter(config => config.protocol.startsWith("stepfun")).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (stepfun) return stepfun;
    }
    // A provider explicitly configured for the role wins over a shared one.
    const newestFirst = [...candidates].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return newestFirst.find((config) => config.roles.length === 1 && config.roles[0] === role) ?? newestFirst[0];
  }

  create(input: CreateProviderInput): ProviderConfig {
    const parsed = CreateProviderSchema.parse(input);
    const protocolCheck = validateProtocolModel(parsed.protocol, parsed.model);
    if (!protocolCheck.ok) throw new Error(protocolCheck.error);
    const now = new Date().toISOString();
    const config: ProviderConfig = {
      id: randomUUID(),
      name: parsed.name,
      kind: parsed.presetId && parsed.presetId !== "custom" ? "preset" : "custom",
      ...(parsed.presetId ? { presetId: parsed.presetId } : {}),
      protocol: parsed.protocol,
      baseUrl: parsed.baseUrl.replace(/\/+$/, ""),
      ...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.headers ? { headers: parsed.headers } : {}),
      roles: parsed.roles ?? ["main"],
      enabled: parsed.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.#configs.set(config.id, config);
    this.#persistToDisk();
    return config;
  }

  update(id: string, input: UpdateProviderInput): ProviderConfig {
    const existing = this.#configs.get(id);
    if (!existing) throw new Error("Provider not found");
    const parsed = UpdateProviderSchema.parse(input);
    const nextProtocol = parsed.protocol ?? existing.protocol;
    const nextModel = parsed.model ?? existing.model;
    const protocolCheck = validateProtocolModel(nextProtocol, nextModel);
    if (!protocolCheck.ok) throw new Error(protocolCheck.error);
    const next: ProviderConfig = {
      ...existing,
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      protocol: nextProtocol,
      ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl.replace(/\/+$/, "") } : {}),
      ...(parsed.model !== undefined ? { model: parsed.model } : {}),
      ...(parsed.headers !== undefined ? { headers: parsed.headers } : {}),
      ...(parsed.roles !== undefined ? { roles: parsed.roles } : {}),
      ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
      ...(parsed.presetId !== undefined ? { presetId: parsed.presetId } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (parsed.clearApiKey) delete next.apiKey;
    else if (parsed.apiKey) next.apiKey = parsed.apiKey;
    this.#configs.set(id, next);
    this.#persistToDisk();
    return next;
  }

  delete(id: string): boolean {
    const deleted = this.#configs.delete(id);
    if (deleted) {
      this.#status.delete(id);
      this.#persistToDisk();
    }
    return deleted;
  }

  recordTest(id: string, status: RuntimeStatus): void {
    this.#status.set(id, status);
  }

  /** Client-safe view: key material is replaced by a boolean and a short hint. */
  view(config: ProviderConfig): ProviderView {
    return {
      id: config.id,
      name: config.name,
      kind: config.kind,
      ...(config.presetId ? { presetId: config.presetId } : {}),
      protocol: config.protocol,
      baseUrl: config.baseUrl,
      ...(config.model ? { model: config.model } : {}),
      ...(config.headers ? { headers: config.headers } : {}),
      roles: config.roles,
      enabled: config.enabled,
      hasApiKey: Boolean(config.apiKey),
      ...(config.apiKey ? { apiKeyHint: maskApiKey(config.apiKey) } : {}),
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }

  viewAll(): ProviderView[] {
    return this.list().map((config) => this.view(config));
  }

  statusOf(config: ProviderConfig): ProviderStatus {
    const runtime = this.#status.get(config.id);
    return {
      ...this.view(config),
      connected: runtime?.connected ?? false,
      ...(runtime?.latencyMs !== undefined ? { latencyMs: runtime.latencyMs } : {}),
      ...(runtime?.lastCheckedAt ? { lastCheckedAt: runtime.lastCheckedAt } : {}),
      ...(runtime?.lastError ? { lastError: runtime.lastError } : {}),
      ...(runtime?.errorType ? { errorType: runtime.errorType } : {}),
    };
  }

  statusAll(): ProviderStatus[] {
    return this.list().map((config) => this.statusOf(config));
  }

  /** Role → provider id map used by the pipeline when settings override env. */
  roleAssignments(): Partial<Record<ProviderRole, string>> {
    const out: Partial<Record<ProviderRole, string>> = {};
    for (const role of ["main", "decision", "asr", "tts", "embedding"] as const) {
      const found = this.findForRole(role);
      if (found) out[role] = found.id;
    }
    return out;
  }
}
