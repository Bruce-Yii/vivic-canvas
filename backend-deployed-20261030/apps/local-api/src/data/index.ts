import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ActionEnvelopeSchema, type CardRecord } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import type { IntentResult } from "../intent/pipeline.js";
import { aborted, bounded, DataError } from "./transport.js";
import { CitySchema, deviceRegionPrompt, lookupWeather, lookupWeatherAt, lookupWeatherNear, type WeatherEvidence, type WeatherResult } from "./weather.js";
import { createRegionLocator, isFreshPosition, regionLabel, reversePlace, type DevicePosition, type PositionPlace } from "./deviceRegion.js";
import { parseNumericIntent } from "./numeric.js";
import { parseWeatherInput } from "./weatherInput.js";
import { transformDataIntent } from "./transform.js";
import { encodeProvenance, PROVENANCE_FIELD } from "./provenance.js";

export { DataError } from "./transport.js";
export type { WeatherEvidence, WeatherResult, WeatherLocation } from "./weather.js";
export { DevicePositionSchema, type DevicePosition } from "./deviceRegion.js";
export { parseLocaleIntent, type LocaleIntent } from "./deviceRegion.js";
const Config = z.strictObject({
  timeoutMs: z.number().int().min(1).max(30_000).default(12_000),
  maxResponseBytes: z.number().int().min(1).max(256 * 1024).default(128 * 1024),
  maxConcurrent: z.number().int().min(1).max(4).default(2),
  requestsPerMinute: z.number().int().min(1).max(30).default(10),
  /** Locate the device (its geolocation fix, else its network region) when a weather request names no city. */
  deviceLocation: z.boolean().default(true),
  /** Server egress is never the visitor's position in an online session. */
  networkRegionFallback: z.boolean().default(true),
});
export type DataConfig = z.infer<typeof Config>;
export interface LocaleEvidence {
  kind: "locale"; name: string; admin1?: string; country?: string; country_code?: string;
  /** device = the geolocation watch; network = the city this connection exits from. */
  basis: "device" | "network"; accuracyM?: number; capturedAt?: string;
}
export type LocaleResult = LocaleEvidence | { kind: "clarify" | "error"; message: string };
export interface DataClient {
  weather(city: string, signal?: AbortSignal): Promise<WeatherResult>;
  /**
   * Current weather where the device is: at its fresh geolocation fix, else
   * for its network region's city; clarifies when neither can be determined.
   */
  weatherHere(position?: DevicePosition, signal?: AbortSignal): Promise<WeatherResult>;
  /** "我在哪里": the device's city, from the fix when there is one, else the network region. */
  locale(position?: DevicePosition, signal?: AbortSignal): Promise<LocaleResult>;
  handleDataIntent(text: string, ctx: CanvasContext, signal?: AbortSignal, position?: DevicePosition): Promise<IntentResult | null>;
}

/** A municipality says its own name twice (上海市 / 上海市) and never repeats "中国". */
const sameplace = (left?: string, right?: string) => !!left && !!right
  && (left === right || left.startsWith(right) || right.startsWith(left));

/** "我在哪里" only reports a place; it never creates a card. */
export function localeAnswer(locale: LocaleEvidence): string {
  const where = [locale.name, sameplace(locale.admin1, locale.name) ? undefined : locale.admin1,
    locale.country === "中国" && locale.basis === "device" ? undefined : locale.country].filter(Boolean).join("，");
  // Nameless position: say what is known instead of repeating "当前位置" back.
  if (locale.name === "当前位置") return locale.basis === "device"
    ? "位置已取到，但暂时查不到具体地名；可以直接说城市名，例如「上海天气」。"
    : "暂时判断不出所在城市，请直接说城市名，例如「上海天气」。";
  return locale.basis === "device" ? `你现在在${where}附近` : `按网络大致判断你在${where}附近`;
}

function envelope(ctx: CanvasContext, card: CardRecord, spokenText?: string): IntentResult {
  return { kind: "envelope", envelope: ActionEnvelopeSchema.parse({ schemaVersion: "0.6", requestId: `data_${randomUUID()}`,
    canvasId: ctx.canvasId, spokenText, actions: [...(ctx.stage === "STANDBY" ? [{ type: "stage.awaken" }] : []),
      { type: "card.create", card }, { type: "canvas.fit" }] }) };
}

/** Shared admission/deadline for both geocoding and forecast. No credentials or LLM. */
export function createDataClient(options: { fetchImpl?: typeof fetch; config?: Partial<DataConfig> } = {}): DataClient {
  // VIVIC_DEVICE_LOCATION=off restores "always name the city".
  const config = Config.parse({ deviceLocation: process.env.VIVIC_DEVICE_LOCATION !== "off", ...options.config });
  let active = 0;
  let started = Date.now();
  let requests = 0;
  const locateRegion = createRegionLocator();
  const fetchImpl = options.fetchImpl ?? fetch;
  const admit = async <T>(parent: AbortSignal | undefined, work: (provider: { signal: AbortSignal; maxBytes: number; fetchImpl: typeof fetch }) => Promise<T>): Promise<T> => {
    if (parent?.aborted) throw aborted(parent);
    if (Date.now() - started >= 60_000) { requests = 0; started = Date.now(); }
    if (active >= config.maxConcurrent) throw new DataError("busy");
    if (requests >= config.requestsPerMinute) throw new DataError("rate-limited");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("", "TimeoutError")), config.timeoutMs);
    const signal = parent ? AbortSignal.any([controller.signal, parent]) : controller.signal;
    active++; requests++;
    try {
      const result = await bounded(work({ signal, maxBytes: config.maxResponseBytes, fetchImpl }), signal);
      if (signal.aborted) throw aborted(signal);
      return result;
    } finally { active--; clearTimeout(timer); }
  };
  const client: DataClient = {
    async weather(city, parent) {
      // Invalid cities and missing locations never consume network/admission slots.
      if (!CitySchema.safeParse(city).success) return { kind: "clarify", message: "请明确城市名；可补充省州或国家。", candidates: [] };
      return admit(parent, provider => lookupWeather(city, provider));
    },
    async weatherHere(position, parent) {
      if (!config.deviceLocation) return { kind: "clarify", message: deviceRegionPrompt, candidates: [] };
      if (position && isFreshPosition(position)) return admit(parent, provider => lookupWeatherAt(position, provider));
      if (!config.networkRegionFallback) return { kind: "clarify", message: deviceRegionPrompt, candidates: [] };
      // One deadline covers locating the region and both weather calls.
      return admit(parent, async provider => {
        let region;
        try { region = await locateRegion(provider); } catch (error) {
          if (provider.signal.aborted) throw error;
          // An unreachable locator asks for the city instead of reporting the weather service as down.
          return { kind: "clarify", message: deviceRegionPrompt, candidates: [] };
        }
        return lookupWeatherNear(region, provider);
      });
    },
    async locale(position, parent) {
      if (!config.deviceLocation) return { kind: "clarify", message: deviceRegionPrompt };
      if (!config.networkRegionFallback && (!position || !isFreshPosition(position))) return { kind: "clarify", message: deviceRegionPrompt };
      return admit(parent, async provider => {
        if (position && isFreshPosition(position)) {
          // An unusable naming response still answers with the fix's own position.
          let place: PositionPlace | null = null;
          try { place = (await reversePlace(position, provider)).place; } catch (error) {
            if (provider.signal.aborted) throw error;
          }
          return place
            ? { kind: "locale" as const, ...place, basis: "device" as const, accuracyM: Math.round(position.accuracyM), capturedAt: position.capturedAt }
            : { kind: "locale" as const, name: "当前位置", basis: "device" as const, accuracyM: Math.round(position.accuracyM), capturedAt: position.capturedAt };
        }
        let region;
        try { region = await locateRegion(provider); } catch (error) {
          if (provider.signal.aborted) throw error;
          return { kind: "clarify" as const, message: deviceRegionPrompt };
        }
        return { kind: "locale" as const, ...regionLabel(region), basis: "network" as const };
      });
    },
    handleDataIntent: (text, ctx, signal, position) => handleDataIntent(text, ctx, signal, client, position),
  };
  return Object.freeze(client);
}

let shared: DataClient | undefined;
/** Returns null for unrelated intents; recognized but unsafe/unsupported requests clarify. */
/** The card body for verified weather evidence; shared by creation and live refresh. */
export function weatherCardFields(weather: WeatherEvidence, requestedCity?: string) {
  const fromDevice = "accuracyM" in weather.location;
  const place = weather.sources.find(source => source.provider === "photon/reverse");
  return {
    displayProps: { tempC: weather.tempC, conditionIcon: weather.conditionIcon },
    sources: weather.sources, aliases: [weather.location.name.slice(0, 80)],
    // A network estimate only picks the city; its coordinates and the IP are never stored.
    // A geolocation fix is stored rounded to ~1 km so the card can follow the device.
    sourceData: { provenance: "open-meteo",
      ...(requestedCity !== undefined ? { requestedCity } : { locationBasis: fromDevice ? "device-geolocation" : "network-region-estimate" }),
      location: weather.location,
      observedAt: weather.observedAt, fetchedAt: weather.fetchedAt, currentConditionsBasis: "weather-model",
      timeKind: "model-valid-time", weatherCode: weather.weatherCode, isDay: weather.isDay,
      intervalSeconds: weather.intervalSeconds, modelGrid: weather.modelGrid,
      attribution: { weather: { name: "Open-Meteo", url: "https://open-meteo.com/" },
        ...(fromDevice
          ? place ? { geocoding: { name: "OpenStreetMap (Photon)", url: "https://www.openstreetmap.org/copyright", license: "ODbL 1.0" } } : {}
          : { geocoding: { name: "GeoNames", url: "https://www.geonames.org/" } }),
        license: "https://creativecommons.org/licenses/by/4.0/",
        changes: "Selected current fields; WMO code mapped to card icon." } },
    spokenText: requestedCity !== undefined ? `已显示${weather.location.name}当前天气`
      : fromDevice ? `已按当前位置显示${weather.location.name}天气` : `已按网络定位显示${weather.location.name}当前天气`,
  };
}

export async function handleDataIntent(text: string, ctx: CanvasContext, signal?: AbortSignal,
  client?: Pick<DataClient, "weather"> & Partial<Pick<DataClient, "weatherHere">>, position?: DevicePosition): Promise<IntentResult | null> {
  if (signal?.aborted) return { kind: "error", message: "查询已取消，未执行任何动作。" };
  if (!/天气|气温|表格|柱状图|条形图|折线图|饼图|图表/.test(text) && !parseWeatherInput(text)) {
    const draft = ctx.cards.filter(card => card.type === "TableCard" && Array.isArray(card.displayProps.rows) && card.displayProps.rows.length === 0);
    const focused = draft.find(card => card.id === ctx.focusHistory.at(-1));
    const target = focused ?? (draft.length === 1 ? draft[0] : undefined);
    const numeric = target ? parseNumericIntent(`表格：${text}`) : null;
    if (!target || numeric?.kind !== "table" || !numeric.rows.length) return null;
    const stamp = new Date().toISOString(), original = { provenance: "user-input", originalText: text, capturedAt: stamp, rows: numeric.rows };
    return { kind: "envelope", usedProvider: "rules", envelope: ActionEnvelopeSchema.parse({ schemaVersion: "0.6", requestId: `data_${randomUUID()}`, canvasId: ctx.canvasId,
      spokenText: "已填入表格", actions: [{ type: "card.update", targetId: target.id,
        displayProps: { columns: ["名称", "数值"], rows: numeric.rows.map(row => [row.label, row.value]) },
        sourceData: { ...original, [PROVENANCE_FIELD]: encodeProvenance({ sources: [], sourceData: original })! } }] }) };
  }
  if (text.length > 500 || /[\p{Cc}\p{Cf}]/u.test(text.replace(/\n/g, ""))) return { kind: "clarify", message: "请提供不超过 500 字符的单项天气或数值指令。" };
  const transformed = transformDataIntent(text, ctx);
  if (transformed?.kind === "clarify") return transformed;
  if (transformed) return { kind: "envelope", usedProvider: "rules", envelope: ActionEnvelopeSchema.parse({
    schemaVersion: "0.6", requestId: `data_${randomUUID()}`, canvasId: ctx.canvasId,
    actions: [...(ctx.stage === "STANDBY" ? [{ type: "stage.awaken" }] : []), ...transformed.actions, { type: "canvas.fit" }],
  }) };
  const numeric = parseNumericIntent(text.trim());
  if (numeric?.kind === "clarify") return numeric;
  const stamp = new Date().toISOString();
  const common = { id: `data_${randomUUID()}`, variant: "minimal" as const, sources: [],
    layout: { x: 0, y: ctx.cards.length * 32, width: 320, height: 240, pinned: false },
    metadata: { createdAt: stamp, updatedAt: stamp } };
  if (numeric) {
    const original = { provenance: "user-input", originalText: text, capturedAt: stamp, rows: numeric.rows };
    const sourceData = { ...original, [PROVENANCE_FIELD]: encodeProvenance({ sources: [], sourceData: original })! };
    const card: CardRecord = numeric.kind === "table"
      ? { ...common, type: "TableCard", displayProps: { columns: ["名称", "数值"], rows: numeric.rows.map(row => [row.label, row.value]) }, sourceData }
      : { ...common, type: "ChartCard", displayProps: { chartKind: numeric.kind, points: numeric.rows.map(row => ({ x: row.label, y: row.value })) }, sourceData };
    return { ...envelope(ctx, card, numeric.kind === "table" ? numeric.rows.length ? "已创建表格" : "已创建空表格" : "已创建图表"), usedProvider: "rules" };
  }
  const request = parseWeatherInput(text);
  if (!request || request.kind === "clarify") return request;
  const city = request.kind === "weather" ? request.city : undefined;
  try {
    const provider = client ?? (shared ??= createDataClient());
    const weather = city !== undefined ? await provider.weather(city, signal)
      : provider.weatherHere ? await provider.weatherHere(position, signal)
      : { kind: "clarify" as const, message: deviceRegionPrompt, candidates: [] };
    if (signal?.aborted) throw aborted(signal);
    if (weather.kind === "clarify") {
      const suggestions = [...new Set(weather.candidates.map(location => `${location.name},${location.admin1 ?? location.country}天气`))]
        .filter(value => value.length <= 100).slice(0, 5);
      return { kind: "clarify", message: weather.message, ...(suggestions.length ? { suggestions } : {}) };
    }
    const fields = weatherCardFields(weather, city);
    return envelope(ctx, { ...common, type: "WeatherCard", displayProps: fields.displayProps, sources: fields.sources,
      metadata: { ...common.metadata, aliases: fields.aliases }, sourceData: fields.sourceData }, fields.spokenText);
  } catch (error) {
    const safe = error instanceof DataError ? error : new DataError("unavailable");
    return { kind: "error", message: safe.message };
  }
}
