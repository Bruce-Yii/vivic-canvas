import { createHash } from "node:crypto";
import type { CanvasContext } from "../schemas.js";

/**
 * Local plan cache (opt-in, `VIVIC_PLAN_CACHE=on`).
 *
 * Caches only the parsed planner output (`plans`/`slots` plus the two subtitle
 * channels). It never caches execution: a hit still goes back through the
 * planner's normal `consume` path, so the host resolves targets, builds cards,
 * validates the batch, asks for confirmation and records receipts exactly as on
 * a miss. Memory only, bounded and expiring; keys are opaque hashes and no
 * canvas, attachments, device location or utterance is stored.
 */

export const PLAN_CACHE_MAX_ENTRIES = 64;
export const PLAN_CACHE_TTL_MS = 10 * 60 * 1000;

export interface CachedPlan {
  contract: string;
  slots: Record<string, unknown>;
  clause?: number;
}

export interface CachedPlanOutput {
  plans: CachedPlan[];
  say?: string;
  text?: string;
}

interface CacheEntry {
  value: CachedPlanOutput;
  expiresAt: number;
  /** Local calendar day the plan was produced for; relative dates never cross midnight. */
  day?: string;
}

/** Only explicit `on`; unset/off/typos keep every request as it is today. */
export const planCacheEnabled = (value: string | undefined = process.env.VIVIC_PLAN_CACHE): boolean =>
  value?.trim().toLowerCase() === "on";

/** A cacheable request has no per-turn evidence that the key does not cover. */
export interface PlanCacheRequest {
  attachments?: readonly unknown[];
  continuation?: unknown;
  taskContext?: unknown;
  page?: unknown;
}

export const planCacheable = (request: PlanCacheRequest): boolean =>
  !(request.attachments?.length) && request.continuation === undefined
  && request.taskContext === undefined && request.page === undefined;

/** Card identity + canvas version + focus only: id/type/version, never titles or bodies. */
export const canvasFingerprint = (ctx: CanvasContext): string => createHash("sha256")
  .update(JSON.stringify({
    canvasId: ctx.canvasId,
    version: ctx.version ?? null,
    cards: [...ctx.cards].sort((left, right) => left.id.localeCompare(right.id)).map(card => [card.id, card.type]),
    focus: ctx.focusHistory.at(-1) ?? null,
  }))
  .digest("hex");

export interface PlanCacheKeyInput {
  text: string;
  canvas: CanvasContext;
  model: string;
  promptVersion: string;
}

/** Opaque key: the utterance itself never appears in memory as a lookup key. */
export const planCacheKey = (input: PlanCacheKeyInput): string => createHash("sha256")
  .update(JSON.stringify([input.text, canvasFingerprint(input.canvas), input.model, input.promptVersion]))
  .digest("hex");

export class PlanCache {
  readonly maxEntries: number;
  readonly ttlMs: number;
  readonly #entries = new Map<string, CacheEntry>();

  constructor(options: { maxEntries?: number; ttlMs?: number } = {}) {
    this.maxEntries = options.maxEntries ?? PLAN_CACHE_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? PLAN_CACHE_TTL_MS;
  }

  /** A miss also prunes an expired entry; a hit refreshes LRU order. */
  get(key: string, now: number = Date.now(), day?: string): CachedPlanOutput | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now || (day !== undefined && entry.day !== undefined && entry.day !== day)) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return structuredClone(entry.value);
  }

  set(key: string, value: CachedPlanOutput, now: number = Date.now(), day?: string): void {
    if (this.#entries.has(key)) this.#entries.delete(key);
    this.#entries.set(key, { value: structuredClone(value), expiresAt: now + this.ttlMs, ...(day !== undefined ? { day } : {}) });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** Process-wide cache; source of truth for `VIVIC_PLAN_CACHE=on`. */
export const planCache = new PlanCache();

/** Tests only: never called by production paths. */
export const resetPlanCache = (): void => planCache.clear();
