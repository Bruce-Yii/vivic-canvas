import { z } from "zod";
import { DataError, IP_REGION_ENDPOINT, PHOTON_REVERSE_ENDPOINT, readProviderJson } from "./transport.js";

const safeName = z.string().trim().min(1).max(100).refine(value => !/[\p{Cc}\p{Cf}<>]/u.test(value));
// Only the fields needed to pick a city are parsed; the echoed IP, ISP and
// postal code are dropped by the schema and never reach the card or logs.
const IpRegionSchema = z.object({
  city: safeName, region: safeName.optional(), country: z.string().regex(/^[A-Z]{2}$/),
  loc: z.string().regex(/^-?\d{1,2}(?:\.\d+)?,-?\d{1,3}(?:\.\d+)?$/),
}).transform(({ loc, ...rest }, ctx) => {
  const [latitude, longitude] = loc.split(",").map(Number) as [number, number];
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) { ctx.addIssue({ code: "custom", message: "loc" }); return z.NEVER; }
  return { ...rest, latitude, longitude };
});
/** City-level estimate of where this device's network exits; never a precise device position. */
export type DeviceRegion = z.infer<typeof IpRegionSchema>;

const CACHE_MS = 30 * 60_000;

/**
 * Memory-only cache: a laptop that moves gets a fresh estimate after the TTL
 * or an API restart. Failures are not cached so a later request retries.
 */
export function createRegionLocator(now: () => number = Date.now) {
  let cached: { region: DeviceRegion; at: number } | undefined;
  return async (options: { signal: AbortSignal; maxBytes: number; fetchImpl: typeof fetch }): Promise<DeviceRegion> => {
    if (cached && now() - cached.at < CACHE_MS) return cached.region;
    const region = await readProviderJson(new URL(IP_REGION_ENDPOINT), IpRegionSchema, options);
    cached = { region, at: now() };
    return region;
  };
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A browser geolocation fix. The Control page rounds to 0.01° (about 1 km)
 * before sending, and the schema enforces that, so no finer position ever
 * reaches the API, the providers or the canvas.
 */
const roundedDegree = (limit: number) => z.number().min(-limit).max(limit)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, "round to 0.01°");
export const DevicePositionSchema = z.strictObject({
  latitude: roundedDegree(90), longitude: roundedDegree(180),
  accuracyM: z.number().min(0).max(100_000), capturedAt: z.iso.datetime(),
});
export type DevicePosition = z.infer<typeof DevicePositionSchema>;
/** Older fixes are treated as missing: the user may have moved since. */
export const POSITION_MAX_AGE_MS = 10 * 60_000;
export const isFreshPosition = (position: DevicePosition, now = Date.now()) => {
  const age = now - Date.parse(position.capturedAt);
  return age <= POSITION_MAX_AGE_MS && age >= -60_000;
};

// Photon returns the nearest OSM object, often a building or shop; only the
// administrative fields are read so a card never names a precise place.
const PhotonSchema = z.object({ features: z.array(z.object({ properties: z.object({
  city: safeName.optional(), district: safeName.optional(), county: safeName.optional(),
  state: safeName.optional(), country: safeName.optional(), countrycode: z.string().regex(/^[A-Za-z]{2}$/).optional(),
}) })).max(5) });
export interface PositionPlace { name: string; admin1?: string; country?: string; country_code?: string }

/** City-level label: 杭州市; a municipality district reads 上海市黄浦区. */
export const placeLabel = (row: z.infer<typeof PhotonSchema>["features"][number]["properties"]): PositionPlace | null => {
  const { city, county, state, country, countrycode } = row;
  const base = city ?? county ?? state;
  if (!base) return null;
  const name = state && base !== state && /[区縣县旗]$/.test(base) && /市$/.test(state) ? `${state}${base}` : base;
  return { name: name.slice(0, 80), ...(state ? { admin1: state } : {}), ...(country ? { country } : {}),
    ...(countrycode ? { country_code: countrycode.toUpperCase() } : {}) };
};

// The region provider names Chinese cities in English; the city lookup already
// maps Chinese names back to verified places, and this keeps the spoken answer
// natural without inventing a translation for every city in the world.
const CN_CITY_ZH: Record<string, string> = { Beijing: "北京", Shanghai: "上海", Guangzhou: "广州", Shenzhen: "深圳",
  Hangzhou: "杭州", Nanjing: "南京", Suzhou: "苏州", Tianjin: "天津", Chongqing: "重庆", Chengdu: "成都", Wuhan: "武汉",
  Xian: "西安", Changsha: "长沙", Qingdao: "青岛", Xiamen: "厦门", Fuzhou: "福州", Jinan: "济南",
  Hefei: "合肥", Kunming: "昆明", Dalian: "大连", Shenyang: "沈阳", Harbin: "哈尔滨", Zhengzhou: "郑州", Ningbo: "宁波",
  Wuxi: "无锡", Foshan: "佛山", Dongguan: "东莞", Zhuhai: "珠海", Nanchang: "南昌", Guiyang: "贵阳", Lanzhou: "兰州",
  Urumqi: "乌鲁木齐", Hohhot: "呼和浩特", Nanning: "南宁", Haikou: "海口", Sanya: "三亚", Shijiazhuang: "石家庄", Taiyuan: "太原" };

export const regionLabel = (region: DeviceRegion): PositionPlace => {
  const name = CN_CITY_ZH[region.city] ?? region.city;
  const same = !region.region || region.region === region.city || region.region.startsWith(name) || name.startsWith(region.region);
  return { name: name.slice(0, 80), ...(region.region && !same ? { admin1: region.region } : {}), country_code: region.country };
};

const REVERSE_TIMEOUT_MS = 8000;

/** Photon limits one request per second; a second call right after another 429s. */
const tooManyRequests = (error: unknown) => error instanceof DataError && error.code === "rate-limited";
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(new Error("aborted")); };
  signal.addEventListener("abort", abort, { once: true });
});

// Photon accepts only default/de/en/fr; an unsupported language is a 400, not a fallback.
export async function reversePlace(position: DevicePosition, options: {
  signal: AbortSignal; maxBytes: number; fetchImpl: typeof fetch;
}, locale = "default"): Promise<{ place: PositionPlace | null; url: URL }> {
  const url = new URL(PHOTON_REVERSE_ENDPOINT);
  url.search = new URLSearchParams({ lat: String(position.latitude), lon: String(position.longitude), lang: locale, limit: "1" }).toString();
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await readProviderJson(url, PhotonSchema, { ...options, signal: withinDeadline(options.signal) });
      const first = reply.features[0]?.properties;
      return { place: first ? placeLabel(first) : null, url };
    } catch (error) {
      if (attempt >= 1 || options.signal.aborted || !tooManyRequests(error)) throw error;
      await wait(1200, options.signal);
    }
  }
}

// Bounds each attempt so a retry still fits inside the caller's single deadline.
function withinDeadline(parent: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const link = () => controller.abort(parent.reason);
  if (parent.aborted) link(); else parent.addEventListener("abort", link, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("", "TimeoutError")), REVERSE_TIMEOUT_MS);
  controller.signal.addEventListener("abort", () => { clearTimeout(timer); parent.removeEventListener("abort", link); }, { once: true });
  return controller.signal;
}

export type LocaleIntent = { kind: "locale" } | { kind: "clarify"; message: string };
// Asking where the user is, rather than about a card ("我的位置那张卡在哪").
const ASKS_WHERE = /^(?:请问|问一下)?\s*(?:我|我们)?\s*(?:现在|目前|当前)?\s*(?:在(?:哪|哪里|哪儿|什么地方)|的?(?:位置|所在地)(?:在)?(?:哪|哪里|哪儿|是什么|是哪里|是哪儿|在哪)?)(?:啊|呀|呢|吗|？|\?|。)?$/u;
const NOT_WHERE = /卡片?|画布|待办|便笺|提醒|倒计时|删|移|移动|放大|聚焦|显示|表格|图表|搜索|天气/;

/** "我在哪里 / 我在哪儿 / 我的位置" — answers with the device's city. */
export function parseLocaleIntent(text: string): LocaleIntent | null {
  const raw = text.trim();
  if (raw.length > 40 || !ASKS_WHERE.test(raw)) return null;
  if (NOT_WHERE.test(raw)) return null;
  return { kind: "locale" };
}

