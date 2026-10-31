import { randomUUID } from "node:crypto";
import { TravelProviderResultSchema, TravelOffersCardSchema, SCENE_CARD_SIZES,
  type ProviderResult, type TravelOffer, type TravelOffersCard, type TravelQuery } from "@vivic/contracts";

export interface TravelProvider { query(query: TravelQuery, signal?: AbortSignal): Promise<unknown> }
/** Deliberately synthetic. No remote calls, availability claims, real hotel names or booking URLs. */
export const demoTravelProvider: TravelProvider = {
  async query(query, signal) {
    signal?.throwIfAborted();
    return {
      provider: "vivic-demo", tool: "travel.search", requestId: `demo_${randomUUID()}`,
      fetchedAt: new Date().toISOString(), mode: "demo", query, status: "ok",
      items: [{ id: "demo-1", kind: query.kind, title: `${query.destination} · 演示${query.kind === "hotel" ? "住宿" : query.kind === "flight" ? "航班" : "景点"}`,
        subtitle: "虚构样例，用于体验卡片；不代表真实价格、评分或可预订库存。",
        price: { amount: 328, currency: "CNY" }, tags: ["模拟数据", "不可预订"] }],
    };
  },
};

export type TravelLookup = { ok: true; result: ProviderResult<TravelOffer, TravelQuery> } | { ok: false; message: string };
/** Bound time even for an adapter that ignores AbortSignal. Never expose raw provider errors. */
export async function queryTravel(provider: TravelProvider, query: TravelQuery, signal?: AbortSignal, timeoutMs = 5000): Promise<TravelLookup> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => { controller.abort(); reject(new Error("cancelled")); };
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs);
    });
    const raw = await Promise.race([Promise.resolve().then(() => provider.query(query, controller.signal)), interrupted]);
    signal?.throwIfAborted();
    const parsed = TravelProviderResultSchema.safeParse(raw);
    if (!parsed.success || JSON.stringify(parsed.data.query) !== JSON.stringify(query)) return { ok: false, message: "旅游服务返回的数据未通过校验，未创建卡片。" };
    if (parsed.data.status === "error") return { ok: false, message: "旅游服务暂不可用，请稍后重试。" };
    return { ok: true, result: parsed.data };
  } catch {
    return { ok: false, message: signal?.aborted ? "旅游查询已取消，未创建卡片。" : controller.signal.aborted ? "旅游查询超时，未创建卡片。" : "旅游服务暂不可用，请稍后重试。" };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/** Facts come exclusively from a validated adapter output, never from a planner's card fields. */
export function buildTravelCard(raw: unknown, now = Date.now()): TravelOffersCard {
  const result = TravelProviderResultSchema.parse(raw);
  if (result.status === "error") throw new Error("Cannot build error result");
  const stamp = new Date(now).toISOString();
  return TravelOffersCardSchema.parse({
    id: `travel_${randomUUID()}`, type: "TravelOffersCard", variant: "standard",
    displayProps: { query: result.query, items: result.items, fetchedAt: result.fetchedAt, mode: result.mode,
      status: result.status, selectedIds: [], notes: "" },
    sourceData: { provider: result.provider, tool: result.tool, requestId: result.requestId, ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}) },
    sources: [{ kind: "service", title: result.mode === "demo" ? "Vivic 旅游演示数据" : result.provider,
      fetchedAt: result.fetchedAt, provider: result.provider, readFullPage: false }],
    layout: { x: 0, y: 0, ...SCENE_CARD_SIZES.travel_offers, pinned: false }, metadata: { createdAt: stamp, updatedAt: stamp },
  });
}
