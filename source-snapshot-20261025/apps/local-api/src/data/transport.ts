import { z } from "zod";

export class DataError extends Error {
  readonly code: "cancelled" | "timeout" | "unavailable" | "invalid-response" | "too-large" | "busy" | "rate-limited";
  constructor(code: DataError["code"]) {
    super({ cancelled: "查询已取消。", timeout: "天气查询超时，请稍后重试。",
      unavailable: "天气服务暂不可用，请稍后重试。", "invalid-response": "天气服务返回的数据不完整或格式不受支持。",
      "too-large": "天气服务响应超过大小限制。", busy: "天气查询繁忙，请稍后重试。",
      "rate-limited": "天气查询频率或服务额度受限，请稍后重试。" }[code]);
    this.name = "DataError"; this.code = code;
  }
}
export function aborted(signal: AbortSignal): DataError {
  return new DataError(signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled");
}
export async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); throw aborted(signal); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(aborted(signal));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export const GEOCODING_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
export const FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
/** Keyless city-level network location; used only when a weather request names no city. */
export const IP_REGION_ENDPOINT = "https://ipinfo.io/json";
/** OSM reverse geocoding (keyless) that names the city of a device geolocation fix. */
export const PHOTON_REVERSE_ENDPOINT = "https://photon.komoot.io/reverse";

const PROVIDER_USER_AGENT = "Vivic/0.6 (local canvas weather card)";

/** Fixed provider API URLs only. This is not an arbitrary web fetch capability. */
export async function readProviderJson<T>(url: URL, schema: z.ZodType<T>, options: {
  signal: AbortSignal; maxBytes: number; fetchImpl: typeof fetch;
}): Promise<T> {
  if (![GEOCODING_ENDPOINT, FORECAST_ENDPOINT, IP_REGION_ENDPOINT, PHOTON_REVERSE_ENDPOINT].includes(`${url.origin}${url.pathname}`)
    || url.username || url.password || url.hash) throw new DataError("unavailable");
  const { signal } = options;
  if (signal.aborted) throw aborted(signal);
  let response: Response | undefined;
  try {
    const pending = options.fetchImpl(url.href, { method: "GET", redirect: "error", credentials: "omit", signal,
      // OSM-based services reject anonymous clients; identify the app (no user data).
      headers: { Accept: "application/json", "User-Agent": PROVIDER_USER_AGENT } });
    void pending.then(reply => { if (signal.aborted) void reply.body?.cancel().catch(() => {}); }, () => {});
    response = await bounded(pending, signal);
    if (response.status === 429) throw new DataError("rate-limited");
    if (!response.ok || response.redirected || (response.url && response.url !== url.href)) throw new DataError("unavailable");
    if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new DataError("invalid-response");
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > options.maxBytes)) throw new DataError("too-large");
    if (!response.body) throw new DataError("invalid-response");
    const reader = response.body.getReader();
    let size = 0;
    let text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      while (true) {
        const chunk = await bounded(reader.read(), signal);
        if (!chunk.done) {
          size += chunk.value.byteLength;
          if (size > options.maxBytes) throw new DataError("too-large");
        }
        text += decoder.decode(chunk.value, { stream: !chunk.done });
        if (chunk.done) break;
      }
    } finally { void reader.cancel().catch(() => {}); }
    if (signal.aborted) throw aborted(signal);
    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new DataError("invalid-response");
    return parsed.data;
  } catch (error) {
    if (signal.aborted) throw aborted(signal);
    if (error instanceof DataError) throw error;
    // Never reflect provider bodies, URLs, abort reasons, stacks or transport errors.
    throw new DataError(response ? "invalid-response" : "unavailable");
  } finally {
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}
