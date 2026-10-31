import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLAN_CACHE_MAX_ENTRIES, PLAN_CACHE_TTL_MS, PlanCache, canvasFingerprint, planCache, planCacheEnabled,
  planCacheKey, planCacheable, resetPlanCache, type CachedPlanOutput,
} from "../src/intent/planCache.js";
import type { CanvasContext } from "../src/schemas.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetPlanCache();
});

const context = (cards: CanvasContext["cards"] = []): CanvasContext => ({
  canvasId: "TEST-cache", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards,
});

const card = (id: string, type = "NoteCard"): CanvasContext["cards"][number] => ({
  id, type, displayProps: { text: `正文 ${id}` }, sourceDataSummary: {},
  layout: { x: 0, y: 0, width: 320, height: 120 },
});

const payload: CachedPlanOutput = { plans: [{ contract: "note", slots: { text: "明天交周报" } }], say: "已记下。", text: "已记下便笺。" };

describe("local plan cache is opt-in and bounded", () => {
  it("defaults to off and only accepts an explicit on", () => {
    expect(planCacheEnabled(undefined)).toBe(false);
    expect(planCacheEnabled("")).toBe(false);
    expect(planCacheEnabled("off")).toBe(false);
    expect(planCacheEnabled("1")).toBe(false);
    expect(planCacheEnabled("true")).toBe(false);
    expect(planCacheEnabled("on")).toBe(true);
    expect(planCacheEnabled(" ON ")).toBe(true);
  });

  it("uses the documented limits", () => {
    expect(new PlanCache().maxEntries).toBe(PLAN_CACHE_MAX_ENTRIES);
    expect(new PlanCache().ttlMs).toBe(PLAN_CACHE_TTL_MS);
    expect(PLAN_CACHE_MAX_ENTRIES).toBe(64);
    expect(PLAN_CACHE_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("expires an entry after the TTL", () => {
    const cache = new PlanCache({ ttlMs: 1_000 });
    cache.set("key", payload, 0);
    expect(cache.get("key", 999)).toEqual(payload);
    expect(cache.get("key", 1_000)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry beyond capacity", () => {
    const cache = new PlanCache({ maxEntries: 2 });
    cache.set("a", payload);
    cache.set("b", payload);
    expect(cache.get("a")).toEqual(payload); // a becomes the most recent
    cache.set("c", payload);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toEqual(payload);
    expect(cache.get("c")).toEqual(payload);
    expect(cache.size).toBe(2);
  });

  it("caps the process cache at 64 entries", () => {
    for (let index = 0; index < 70; index += 1) planCache.set(`key-${index}`, payload);
    expect(planCache.size).toBe(PLAN_CACHE_MAX_ENTRIES);
    expect(planCache.get("key-0")).toBeUndefined();
    expect(planCache.get("key-69")).toEqual(payload);
  });

  it("never replays a relative-date plan on another local day", () => {
    const cache = new PlanCache();
    cache.set("key", payload, 0, "2026-10-31");
    expect(cache.get("key", 1, "2026-10-31")).toEqual(payload);
    expect(cache.get("key", 2, "2026-11-01")).toBeUndefined();
  });

  it("returns a copy so a caller cannot mutate the stored plan", () => {
    const cache = new PlanCache();
    cache.set("key", payload);
    const first = cache.get("key")!;
    first.plans[0]!.slots.text = "TEST-mutated";
    expect(cache.get("key")).toEqual(payload);
  });

  it("does not cache requests with per-turn evidence", () => {
    expect(planCacheable({})).toBe(true);
    expect(planCacheable({ attachments: [] })).toBe(true);
    expect(planCacheable({ attachments: [{ mime: "image/png" }] })).toBe(false);
    expect(planCacheable({ continuation: { utterance: "上一句", question: "继续吗" } })).toBe(false);
    expect(planCacheable({ taskContext: { active_clause: 0 } })).toBe(false);
    expect(planCacheable({ page: { url: "https://example.test" } })).toBe(false);
  });
});

describe("plan cache keys are opaque and canvas-sensitive", () => {
  const base = { text: "记一下明天交周报", model: "deepseek-flash", promptVersion: "v1" };

  it("is a 256-bit hash that never contains the utterance", () => {
    const key = planCacheKey({ ...base, canvas: context() });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("周报");
  });

  it("changes with the card set, the model and the prompt version", () => {
    const empty = planCacheKey({ ...base, canvas: context() });
    const one = planCacheKey({ ...base, canvas: context([card("TEST-a")]) });
    const otherType = planCacheKey({ ...base, canvas: context([card("TEST-a", "TodoCard")]) });
    const otherModel = planCacheKey({ ...base, model: "step-3.7-flash", canvas: context() });
    const otherPrompt = planCacheKey({ ...base, promptVersion: "v2", canvas: context() });
    expect(new Set([empty, one, otherType, otherModel, otherPrompt]).size).toBe(5);
  });

  it("ignores card bodies but keeps identity, version and focus", () => {
    const first = context([card("TEST-a")]);
    const changedBody = context([{ ...card("TEST-a"), displayProps: { text: "换了正文" } }]);
    expect(canvasFingerprint(first)).toBe(canvasFingerprint(changedBody));
    expect(canvasFingerprint({ ...first, version: 3 })).not.toBe(canvasFingerprint(first));
    expect(canvasFingerprint({ ...first, focusHistory: ["TEST-a"] })).not.toBe(canvasFingerprint(first));
    expect(canvasFingerprint(context([card("TEST-b")]))).not.toBe(canvasFingerprint(first));
  });

  it("keeps the key opaque even when the request text is repeated", () => {
    const first = planCacheKey({ ...base, canvas: context() });
    const second = planCacheKey({ ...base, canvas: context() });
    expect(first).toBe(second);
    expect(first).not.toContain(base.text);
  });
});
