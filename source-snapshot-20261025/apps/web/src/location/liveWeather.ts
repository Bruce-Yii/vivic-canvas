import type { CardRecord } from "@/contracts";
import type { DeviceFix } from "./deviceLocation";

const data = (card: CardRecord) => card.sourceData as Record<string, unknown>;
/** Cards created for "where I am"; a named-city card never follows the device. */
export const isLiveWeatherCard = (card: CardRecord): boolean => card.type === "WeatherCard"
  && (data(card).locationBasis === "device-geolocation" || data(card).locationBasis === "network-region-estimate");

export const STALE_AFTER_MS = 15 * 60_000;
export const MOVED_KM = 1.5;

const distanceKm = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) => {
  const rad = Math.PI / 180, dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
};
const coords = (value: unknown) => {
  const row = value as { latitude?: unknown; longitude?: unknown } | null;
  return typeof row?.latitude === "number" && typeof row.longitude === "number" ? { latitude: row.latitude, longitude: row.longitude } : null;
};

/** Why a live card should be refreshed now, or null. */
export function refreshReason(card: CardRecord, fix: DeviceFix | null, now = Date.now()): "moved" | "located" | "stale" | null {
  if (!isLiveWeatherCard(card)) return null;
  if (fix) {
    // A network estimate is upgraded as soon as a real fix exists.
    if (data(card).locationBasis !== "device-geolocation") return "located";
    const at = coords(data(card).location);
    if (!at || distanceKm(at, fix) > MOVED_KM) return "moved";
  }
  const fetched = Date.parse(String(data(card).fetchedAt));
  return !Number.isFinite(fetched) || now - fetched > STALE_AFTER_MS ? "stale" : null;
}

/** Keep aliases the user added; only the previous place name is swapped. */
export function nextAliases(card: CardRecord, fresh: string[]): string[] {
  const previous = (data(card).location as { name?: unknown } | undefined)?.name;
  return [...new Set([...fresh, ...(card.metadata.aliases ?? []).filter(alias => alias !== previous)])].slice(0, 12);
}

const RETRY_MS = 60_000, FAILED_RETRY_MS = 5 * 60_000;

/**
 * Owner-only loop: when the device moves, a real fix replaces a network
 * estimate, or data age out, fetch verified weather once and swap it into
 * every live card on the active canvas.
 */
export function startLiveWeather(deps: {
  cards: () => CardRecord[];
  fix: () => DeviceFix | null;
  subscribeFix: (listener: () => void) => () => void;
  fetchHere: (fix: DeviceFix | null) => Promise<{ kind: string } & Partial<import("@/ai/api").WeatherHereFields>>;
  refresh: (cardId: string, fields: import("@/ai/api").WeatherHereFields) => unknown;
  now?: () => number;
  intervalMs?: number;
}): () => void {
  const now = deps.now ?? Date.now;
  let stopped = false, inFlight = false, retryAt = 0;
  const tick = async () => {
    if (stopped || inFlight || now() < retryAt) return;
    const fix = deps.fix();
    const due = deps.cards().filter(card => refreshReason(card, fix, now()));
    if (!due.length) return;
    inFlight = true;
    try {
      const result = await deps.fetchHere(fix);
      if (stopped) return;
      if (result.kind !== "weather") { retryAt = now() + FAILED_RETRY_MS; return; }
      retryAt = now() + RETRY_MS;
      const { kind: _kind, ...fields } = result as { kind: "weather" } & import("@/ai/api").WeatherHereFields;
      // Cards may have been deleted while the request was in flight.
      const live = new Set(deps.cards().map(card => card.id));
      for (const card of due) if (live.has(card.id)) deps.refresh(card.id, fields);
    } catch { retryAt = now() + FAILED_RETRY_MS; } finally { inFlight = false; }
  };
  const timer = setInterval(() => void tick(), deps.intervalMs ?? 60_000);
  const unsubscribe = deps.subscribeFix(() => void tick());
  void tick();
  return () => { stopped = true; clearInterval(timer); unsubscribe(); };
}
