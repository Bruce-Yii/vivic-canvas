import { describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema } from "@vivic/contracts";
import { createDataClient, handleDataIntent, type WeatherResult } from "../src/data/index.js";
import { conditionIcon } from "../src/data/weather.js";
import { DevicePositionSchema, parseLocaleIntent, placeLabel } from "../src/data/deviceRegion.js";
import { localeAnswer } from "../src/data/index.js";
import { IntentRequestSchema } from "../src/schemas.js";
import { authed, emptyContext, testConfig } from "./helpers.js";
import { CredentialStore } from "../src/credentials.js";
import { runIntent } from "../src/intent/pipeline.js";
import { createApp } from "../src/app.js";

const shanghai = { id: 1796236, name: "上海", latitude: 31.22222, longitude: 121.45806,
  country: "中国", country_code: "CN", admin1: "上海市", timezone: "Asia/Shanghai", feature_code: "PPLA" };
const forecast = () => ({ latitude: 31.25, longitude: 121.5, utc_offset_seconds: 0,
  current_units: { time: "unixtime", temperature_2m: "°C" }, current: {
    time: Math.floor(Date.now() / 1000 / 900) * 900, interval: 900, temperature_2m: 22.4, weather_code: 2, is_day: 1,
  } });
// Documentation-range IP and a network estimate that is deliberately not the city centre.
const ipRegion = { ip: "203.0.113.7", city: "Shanghai", region: "Shanghai", country: "CN", loc: "31.2304,121.4737",
  org: "AS0 Example", postal: "200000", timezone: "Asia/Shanghai" };
// Photon's nearest object is a hotel; only its administrative fields may be used.
const photonHangzhou = { type: "FeatureCollection", features: [{ type: "Feature", properties: { osm_key: "tourism", name: "TEST 凌云大酒店",
  street: "TEST 体育场路", housenumber: "8", district: "天水街道", city: "杭州市", state: "浙江省", country: "中国", countrycode: "CN", postcode: "310006" } }] };
const fix = (patch: Partial<{ latitude: number; longitude: number; accuracyM: number; capturedAt: string }> = {}) =>
  ({ latitude: 30.27, longitude: 120.16, accuracyM: 35.4, capturedAt: new Date().toISOString(), ...patch });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
function harness(override?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
  config?: NonNullable<Parameters<typeof createDataClient>[0]>["config"]) {
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const replacement = override?.(url, init);
    if (replacement !== undefined) return replacement;
    return json(url.includes("geocoding-api") ? { results: [shanghai] } : url.includes("ipinfo.io") ? ipRegion
      : url.includes("photon.komoot.io") ? photonHangzhou : forecast());
  });
  const client = createDataClient({ fetchImpl: fetcher as typeof fetch, config });
  return { fetcher, client };
}
function card(result: Awaited<ReturnType<typeof handleDataIntent>>) {
  expect(result?.kind).toBe("envelope");
  const parsed = ActionEnvelopeSchema.parse(result?.envelope);
  const action = parsed.actions.find(action => action.type === "card.create");
  if (action?.type !== "card.create") throw new Error("Missing card");
  return action.card;
}

describe("weather at the device's geolocation fix", () => {
  it("names the city from the fix and reads weather at the fix itself", async () => {
    const h = harness();
    const result = await h.client.handleDataIntent("今天天气如何", emptyContext(), undefined, fix());
    expect(result?.envelope?.spokenText).toBe("已按当前位置显示杭州市天气");
    const weather = card(result);
    expect(weather.sourceData).toMatchObject({ locationBasis: "device-geolocation",
      location: { name: "杭州市", admin1: "浙江省", country_code: "CN", latitude: 30.27, longitude: 120.16, accuracyM: 35 },
      attribution: { geocoding: { name: "OpenStreetMap (Photon)" } } });
    expect(weather.metadata.aliases).toEqual(["杭州市"]);
    expect(JSON.stringify(weather)).not.toMatch(/酒店|体育场路|310006/);
    const [reverse, fc] = h.fetcher.mock.calls.map(call => new URL(String(call[0])));
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(Object.fromEntries(reverse.searchParams)).toEqual({ lat: "30.27", lon: "120.16", lang: "default", limit: "1" });
    expect([fc.searchParams.get("latitude"), fc.searchParams.get("longitude")]).toEqual(["30.27", "120.16"]);
    expect(weather.sources.map(source => source.provider)).toEqual(["photon/reverse", "open-meteo/forecast"]);
  });

  it("still shows real weather at the fix when the place name is unavailable", async () => {
    const h = harness(url => url.includes("photon.komoot.io") ? json({ features: [] }) : undefined);
    const weather = card(await h.client.handleDataIntent("天气怎么样", emptyContext(), undefined, fix()));
    expect(weather.sourceData).toMatchObject({ locationBasis: "device-geolocation", location: { name: "当前位置" } });
    expect(weather.sourceData).not.toHaveProperty("attribution.geocoding");
    expect(weather.sources.map(source => source.provider)).toEqual(["open-meteo/forecast"]);
  });

  it("falls back to the network region for a stale fix, and a named city ignores the fix", async () => {
    const h = harness();
    const stale = fix({ capturedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
    expect((await h.client.handleDataIntent("天气", emptyContext(), undefined, stale))?.envelope?.spokenText).toBe("已按网络定位显示上海当前天气");
    const named = harness();
    await named.client.handleDataIntent("北京天气", emptyContext(), undefined, fix());
    expect(named.fetcher.mock.calls.some(call => /photon|ipinfo/.test(String(call[0])))).toBe(false);
  });

  it("only accepts fixes rounded to about 1 km", () => {
    expect(DevicePositionSchema.safeParse(fix()).success).toBe(true);
    expect(DevicePositionSchema.safeParse(fix({ latitude: 30.274123 })).success).toBe(false);
    expect(IntentRequestSchema.safeParse({ text: "天气", canvasContext: emptyContext(), deviceLocation: fix({ longitude: 120.1551 }) }).success).toBe(false);
    expect(IntentRequestSchema.safeParse({ text: "天气", canvasContext: emptyContext(), deviceLocation: fix() }).success).toBe(true);
  });

  it.each([
    [{ city: "黄浦区", state: "上海市", country: "中国", countrycode: "CN" }, "上海市黄浦区"],
    [{ city: "北京市", district: "东城区", country: "中国", countrycode: "cn" }, "北京市"],
    [{ city: "Paris", district: "Le Marais", state: "Île-de-France", countrycode: "FR" }, "Paris"],
    [{ county: "TEST县", state: "TEST省" }, "TEST县"],
  ])("labels %o as %s", (row, label) => expect(placeLabel(row)?.name).toBe(label));
});

it.each(["水烧到多少度", "北京热吗", "这道题多少度", "冷不冷的问题以后再说吧"])("leaves %s to the model", async text => {
  const h = harness();
  expect(await h.client.handleDataIntent(text, emptyContext())).toBeNull();
  expect(h.fetcher).not.toHaveBeenCalled();
});

describe("weather for the device's network region", () => {
  it.each(["今天天气如何", "天气怎么样", "天气", "这里的天气", "本地天气", "现在气温", "我这边今天天气怎么样？", "外面天气怎么样", "外面冷不冷", "现在多少度？", "今天热不热"])("%s resolves the region, then a verified city", async text => {
    const h = harness();
    const result = await h.client.handleDataIntent(text, emptyContext());
    expect(result?.envelope?.spokenText).toBe("已按网络定位显示上海当前天气");
    const weather = card(result);
    expect(weather.sourceData).toMatchObject({ locationBasis: "network-region-estimate", location: shanghai });
    expect(weather.sourceData).not.toHaveProperty("requestedCity");
    expect(weather.metadata.aliases).toEqual(["上海"]);
    // The estimate only chooses a city: neither the IP, the ISP nor its coordinates are kept.
    const stored = JSON.stringify(weather);
    for (const leak of [ipRegion.ip, ipRegion.loc, "31.2304", ipRegion.org, ipRegion.postal]) expect(stored).not.toContain(leak);
    const [region, geo, fc] = h.fetcher.mock.calls.map(call => new URL(String(call[0])));
    expect(region.href).toBe("https://ipinfo.io/json");
    expect(Object.fromEntries(geo.searchParams)).toMatchObject({ name: "Shanghai", language: "zh" });
    expect(fc.searchParams.get("latitude")).toBe(String(shanghai.latitude));
  });

  it("caches the region in memory only for later requests", async () => {
    const h = harness();
    await h.client.weatherHere();
    await h.client.weatherHere();
    expect(h.fetcher.mock.calls.filter(call => String(call[0]).includes("ipinfo.io"))).toHaveLength(1);
    expect(harness().fetcher).not.toHaveBeenCalled();
  });

  it("picks the nearest same-country place and never a namesake abroad or far away", async () => {
    const h = harness(url => url.includes("geocoding-api") ? json({ results: [
      { ...shanghai, id: 4089440, name: "Shanghai", country: "美国", country_code: "US", latitude: 34.85, longitude: -87.09, feature_code: "PPL" },
      { ...shanghai, id: 7072498, admin1: "浙江", latitude: 29.33, feature_code: "PPL" },
      // Live result shape: a Puerto Rico namesake without `country` is skipped, not fatal.
      { ...shanghai, id: 4568317, name: "Shanghai", country: undefined, country_code: "PR", latitude: 18.2, longitude: -65.8, feature_code: "PPL" },
      shanghai] }) : undefined);
    expect(await h.client.weatherHere()).toMatchObject({ kind: "weather", location: { id: shanghai.id } });
    const far = harness(url => url.includes("geocoding-api") ? json({ results: [{ ...shanghai, latitude: 29.33 }] }) : undefined);
    expect(await far.client.weatherHere()).toMatchObject({ kind: "clarify", message: expect.stringContaining("城市名") });
    expect(far.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([() => new Response("", { status: 503 }), () => json({ bogon: true }), () => json({ ...ipRegion, loc: "91,200" })])(
    "asks for the city when the region cannot be determined, and retries next time", async reply => {
      const h = harness(url => url.includes("ipinfo.io") ? reply() : undefined);
      const result = await h.client.handleDataIntent("今天天气如何", emptyContext());
      expect(result).toEqual({ kind: "clarify", message: expect.stringContaining("请直接说城市名") });
      await h.client.weatherHere();
      expect(h.fetcher).toHaveBeenCalledTimes(2);
      expect(h.fetcher.mock.calls.every(call => String(call[0]).includes("ipinfo.io"))).toBe(true);
    });

  it("can be switched off, and an injected client without it asks for the city", async () => {
    const h = harness(undefined, { deviceLocation: false });
    expect(await h.client.handleDataIntent("今天天气如何", emptyContext())).toMatchObject({ kind: "clarify" });
    expect(h.fetcher).not.toHaveBeenCalled();
    const weather = vi.fn();
    expect(await handleDataIntent("天气", emptyContext(), undefined, { weather })).toMatchObject({ kind: "clarify" });
    expect(weather).not.toHaveBeenCalled();
  });

  it("names a city when the user does, without locating the device", async () => {
    const h = harness();
    expect((await h.client.handleDataIntent("北京今天天气如何", emptyContext()))?.kind).toBeDefined();
    expect(h.fetcher.mock.calls.some(call => String(call[0]).includes("ipinfo.io"))).toBe(false);
  });
});

describe("real-provider weather adapter with synthetic transport fixtures", () => {
  it("builds a strict minimal weather envelope with exact source query URLs, attribution and model time", async () => {
    const h = harness();
    const result = await h.client.handleDataIntent("上海,上海市当前天气", { ...emptyContext(), stage: "STANDBY" });
    const weather = card(result);
    expect(weather.type).toBe("WeatherCard");
    expect(weather.displayProps).toEqual({ tempC: 22.4, conditionIcon: "cloud" });
    expect(weather.sourceData).toMatchObject({ requestedCity: "上海,上海市", location: shanghai,
      currentConditionsBasis: "weather-model", timeKind: "model-valid-time",
      observedAt: expect.stringMatching(/Z$/), attribution: { weather: { url: "https://open-meteo.com/" } },
    });
    expect(result?.envelope?.actions[0].type).toBe("stage.awaken");
    expect(result).not.toHaveProperty("usedProvider");
    expect(weather.sources).toHaveLength(2);
    h.fetcher.mock.calls.forEach(([input, init], index) => {
      const url = new URL(String(input));
      expect(url.protocol).toBe("https:");
      expect(url.pathname).toBe(index ? "/v1/forecast" : "/v1/search");
      expect(url.hostname).toBe(index ? "api.open-meteo.com" : "geocoding-api.open-meteo.com");
      expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", headers: { Accept: "application/json", "User-Agent": expect.stringMatching(/^Vivic\//) } });
      expect(init?.headers).not.toHaveProperty("Authorization");
      expect(weather.sources[index].url).toBe(url.href);
    });
    const params = new URL(String(h.fetcher.mock.calls[1][0])).searchParams;
    expect(params.get("current")).toBe("temperature_2m,weather_code,is_day");
    expect(params.get("timeformat")).toBe("unixtime");
    expect(params.get("timezone")).toBe("GMT");
    expect(params.get("latitude")).toBe(String(shanghai.latitude));
  });

  it("selects the verified municipality over same-name villages without using result order", async () => {
    const h = harness(url => url.includes("geocoding-api") ? json({ results: [shanghai,
      { ...shanghai, id: 7072498, admin1: "浙江", latitude: 29.32955, feature_code: "PPL" }] }) : undefined);
    const result = await h.client.handleDataIntent("上海天气", emptyContext());
    expect(result).toMatchObject({ kind: "envelope" });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(card(result).sourceData).toMatchObject({ location: { id: shanghai.id, admin1: "上海市" } });
  });

  it("clarifies unsupported future/mixed weather before networking", async () => {
    const h = harness();
    for (const text of ["明天天气", "上海明天天气", "上海天气然后删除旧卡",
      "查询上海天气；创建一个待办", "上海天气和北京天气", "上海天气，提醒我喝水", "https://127.0.0.1天气"]) {
      expect(await h.client.handleDataIntent(text, emptyContext()), text).toMatchObject({ kind: "clarify" });
    }
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("preserves legitimate city names containing 和 and unrelated commands return null", async () => {
    const h = harness();
    // Fixture names the requested city; unrelated city responses are never accepted.
    const named = harness(url => url.includes("geocoding-api") ? json({ results: [{ ...shanghai, name: "呼和浩特" }] }) : undefined);
    expect((await named.client.handleDataIntent("呼和浩特天气", emptyContext()))?.kind).toBe("envelope");
    expect(await h.client.handleDataIntent("创建十分钟倒计时", emptyContext())).toBeNull();
    expect(new URL(String(named.fetcher.mock.calls[0][0])).searchParams.get("name")).toBe("呼和浩特");
  });

  it.each([undefined, [], [{ ...shanghai, feature_code: "ISL" }]])("clarifies absent or non-city geocoding results", async results => {
    const h = harness(url => url.includes("geocoding-api") ? json({ results }) : undefined);
    expect(await h.client.weather("Shanghai")).toMatchObject({ kind: "clarify" });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a sole prefix match and a truncated full page instead of assuming a unique city", async () => {
    for (const results of [[{ ...shanghai, name: "上海市场社区" }],
      [shanghai, ...Array.from({ length: 9 }, (_, index) => ({ ...shanghai, id: index + 1, name: `上海${index}` }))]]) {
      const h = harness(url => url.includes("geocoding-api") ? json({ results }) : undefined);
      expect(await h.client.weather("上海")).toMatchObject({ kind: "clarify" });
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    { current: { temperature_2m: null } }, { current_units: { temperature_2m: "°F" } },
    { current: { weather_code: 999 } }, { current: { time: 1 } },
    { current: { time: Math.floor(Date.now() / 1000) + 3600 } },
    { current: { temperature_2m: 100 } }, { utc_offset_seconds: 28800 },
  ])("refuses missing, stale or incompatible weather instead of inventing defaults", async patch => {
    const h = harness(url => {
      if (url.includes("geocoding-api")) return;
      const value = forecast();
      return json({ ...value, ...patch, current: { ...value.current, ...patch.current },
        current_units: { ...value.current_units, ...patch.current_units } });
    });
    const result = await h.client.handleDataIntent("上海天气", emptyContext());
    expect(result).toMatchObject({ kind: "error" });
    expect(result).not.toHaveProperty("envelope");
  });

  it.each([[0, true, "sun"], [1, false, "night"], [3, true, "cloud"], [48, false, "fog"],
    [57, true, "rain"], [86, true, "snow"], [97, true, "storm"]] as const)("maps WMO %s/day=%s to %s", (code, day, icon) => {
    expect(conditionIcon(code, day)).toBe(icon);
  });
});

describe("bounded provider API transport", () => {
  it.each([302, 401, 429, 500])("does not redirect, retry or expose HTTP %s error bodies", async status => {
    const cancel = vi.fn();
    const h = harness(() => new Response(new ReadableStream({ cancel }), { status, headers: { location: "http://127.0.0.1/PRIVATE" } }));
    const result = await h.client.handleDataIntent("上海天气", emptyContext());
    expect(result).toMatchObject({ kind: "error" });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|127\.0\.0\.1/);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["declared", "streamed", "content-type", "json", "schema", "utf8", "wrong-origin"])("rejects %s response failures and cancels bodies", async mode => {
    const cancel = vi.fn();
    const h = harness(() => {
      const bytes = mode === "streamed" ? new Uint8Array(1025) : mode === "utf8" ? new Uint8Array([255])
        : new TextEncoder().encode(mode === "json" ? "{" : JSON.stringify({ results: [{ ...shanghai, latitude: 1000 }] }));
      const response = new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes); if (["json", "schema"].includes(mode)) controller.close();
      }, cancel }), { headers: { "content-type": mode === "content-type" ? "text/html" : "application/json",
        ...(mode === "declared" ? { "content-length": "1025" } : {}) } });
      if (mode === "wrong-origin") Object.defineProperty(response, "url", { value: "https://evil.example/" });
      return response;
    }, { maxResponseBytes: 1024 });
    await expect(h.client.weather("Shanghai")).rejects.toMatchObject({ code: ["declared", "streamed"].includes(mode)
      ? "too-large" : mode === "wrong-origin" ? "unavailable" : "invalid-response" });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(["json", "schema"].includes(mode) ? 0 : 1);
  });

  it("uses a single deadline and cancels a stalled forecast body", async () => {
    const cancel = vi.fn();
    const h = harness(url => url.includes("geocoding-api") ? undefined
      : new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json" } }), { timeoutMs: 20 });
    await expect(h.client.weather("上海")).rejects.toMatchObject({ code: "timeout" });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("honors caller cancellation, aborts stuck custom fetch and cancels its late body", async () => {
    let finish!: (response: Response) => void;
    const h = harness(() => new Promise<Response>(resolve => { finish = resolve; }));
    const abort = new AbortController();
    const pending = h.client.weather("Shanghai", abort.signal);
    abort.abort(new Error("PRIVATE abort reason"));
    await expect(pending).rejects.toMatchObject({ code: "cancelled", message: "查询已取消。" });
    const cancel = vi.fn(); finish(new Response(new ReadableStream({ cancel })));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await h.client.handleDataIntent("上海天气", emptyContext(), abort.signal)).toMatchObject({ kind: "error" });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it("shares admission limits, never accepts endpoint configuration or URL cities", async () => {
    const h = harness(undefined, { requestsPerMinute: 1 });
    await h.client.weather("上海");
    await expect(h.client.weather("Beijing")).rejects.toMatchObject({ code: "rate-limited" });
    expect(await h.client.weather("https://localhost")).toMatchObject({ kind: "clarify" });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(() => createDataClient({ config: { endpoint: "http://localhost" } as never })).toThrow();
  });

  it("enforces concurrency and releases the slot after a cancelled request", async () => {
    let stalled = true;
    const h = harness(() => stalled ? new Promise<Response>(() => {}) : undefined, { maxConcurrent: 1 });
    const abort = new AbortController();
    const pending = h.client.weather("Shanghai", abort.signal);
    await expect(h.client.weather("Beijing")).rejects.toMatchObject({ code: "busy" });
    abort.abort(); await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    stalled = false;
    expect((await h.client.weather("上海")).kind).toBe("weather");
  });
});

describe("explicit user numeric data only", () => {
  it.each([["柱状图记录", "bar"], ["折线图展示", "line"], ["饼图表示", "pie"]])("accepts the same explicit record wording for %s", async (wording, chartKind) => {
    const h = harness();
    const value = card(await h.client.handleDataIntent(`用${wording}：周一3，周二5，周三4`, emptyContext()));
    expect(value.type).toBe("ChartCard");
    expect(value.displayProps).toEqual({ chartKind, points: [{ x: "周一", y: 3 }, { x: "周二", y: 5 }, { x: "周三", y: 4 }] });
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("creates an editable table with exact user values, empty sources and user provenance, without networking", async () => {
    const h = harness();
    const value = card(await h.client.handleDataIntent("用表格记录：苹果3，香蕉5", emptyContext()));
    expect(value.type).toBe("TableCard");
    expect(value.displayProps).toEqual({ columns: ["名称", "数值"], rows: [["苹果", 3], ["香蕉", 5]] });
    expect(value.sources).toEqual([]);
    expect(value.sourceData).toMatchObject({ provenance: "user-input", originalText: "用表格记录：苹果3，香蕉5" });
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it.each([["柱状图", "bar"], ["折线图", "line"], ["饼图", "pie"]])("honors explicit %s without inventing data, labels or URLs", async (request, chartKind) => {
    const h = harness();
    const value = card(await h.client.handleDataIntent(`把这组数据画成${request}：周一3，周二5，周三4`, emptyContext()));
    expect(value.displayProps).toEqual({ chartKind, points: [{ x: "周一", y: 3 }, { x: "周二", y: 5 }, { x: "周三", y: 4 }] });
    expect(value.sources).toEqual([]);
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("preserves signed, zero, decimal and digit-bearing labels with explicit separators", async () => {
    const h = harness();
    const value = card(await h.client.handleDataIntent("用表格记录：Q1:1.001，Q2:-0.5，零0，小数.25", emptyContext()));
    expect(value.displayProps).toMatchObject({ rows: [["Q1", 1.001], ["Q2", -0.5], ["零", 0], ["小数", .25]] });
  });

  it.each([
    "用表格记录：苹果3，香蕉5，然后删除旧卡", "把这组数据画成柱状图：周一3，周二5；清空画布",
    "用表格记录：苹果3，同时查上海天气", "图表：苹果3，香蕉5", "饼图：苹果-3，香蕉5",
    "饼图：苹果0，香蕉0", "用表格记录：苹果3个，香蕉5个", "用表格记录：苹果3，苹果5",
    "用表格记录：苹果3，香蕉未知", "用表格记录：苹果NaN，香蕉Infinity", "用表格记录：苹果1e6",
    "用表格记录：苹果0.1234567", "用表格记录：苹果1000000000001", "用表格记录：苹果3，",
    "柱状图：Q13，Q25", "表格：苹果3|香蕉5", "表格：一月：收入3支出4",
  ])("clarifies unsupported or mixed input without partial actions: %s", async text => {
    const h = harness();
    const result = await h.client.handleDataIntent(text, emptyContext());
    expect(result).toMatchObject({ kind: "clarify" });
    expect(result).not.toHaveProperty("envelope");
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("supports an injected weather interface without app/pipeline changes", async () => {
    const weather = vi.fn(async (): Promise<WeatherResult> => ({ kind: "clarify", message: "请补充国家。", candidates: [] }));
    expect(await handleDataIntent("Paris天气", emptyContext(), undefined, { weather })).toEqual({ kind: "clarify", message: "请补充国家。" });
    expect(weather).toHaveBeenCalledWith("Paris", undefined);
  });

  it("rejects excessive rows and decimal precision loss as a whole", async () => {
    const h = harness();
    for (const text of [`表格：${Array.from({ length: 31 }, (_, index) => `项目${index}:${index}`).join("，")}`,
      "表格：甲999999999999.000001"]) {
      expect(await h.client.handleDataIntent(text, emptyContext())).toMatchObject({ kind: "clarify" });
    }
    expect(h.fetcher).not.toHaveBeenCalled();
  });
});

describe("我在哪里", () => {
  it("answers with the named city of the fix, without creating a card or calling a model", async () => {
    const h = harness();
    expect(await h.client.locale(fix())).toMatchObject({ kind: "locale", name: "杭州市", admin1: "浙江省", basis: "device", accuracyM: 35 });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("still says where the fix is when the name is unavailable", async () => {
    const h = harness(url => url.includes("photon.komoot.io") ? json({ features: [] }) : undefined);
    expect(await h.client.locale(fix())).toMatchObject({ kind: "locale", name: "当前位置", basis: "device" });
  });
  it("retries once when the naming service rate-limits a burst of questions", async () => {
    let calls = 0;
    const h = harness(url => url.includes("photon.komoot.io")
      ? (++calls === 1 ? new Response("", { status: 429 }) : json(photonHangzhou)) : undefined);
    expect(await h.client.locale(fix())).toMatchObject({ kind: "locale", name: "杭州市" });
    expect(calls).toBe(2);
    // A hopeless failure is not retried into the next request either.
    const broken = harness(url => url.includes("photon.komoot.io") ? new Response("", { status: 429 }) : undefined);
    expect(await broken.client.locale(fix())).toMatchObject({ kind: "locale", name: "当前位置" });
    expect(broken.fetcher.mock.calls.filter(call => String(call[0]).includes("photon")).length).toBe(2);
  });

  it("says so plainly when the position is known but the place is not", () => {
    expect(localeAnswer({ kind: "locale", name: "当前位置", basis: "device" })).toContain("查不到具体地名");
    expect(localeAnswer({ kind: "locale", name: "当前位置", basis: "network" })).toContain("请直接说城市名");
  });

  it("falls back to the network region only when the fix is stale, and can be switched off", async () => {
    const h = harness();
    expect(await h.client.locale(fix({ capturedAt: new Date(Date.now() - 11 * 60_000).toISOString() }))).toMatchObject({ kind: "locale", name: "上海", basis: "network" });
    const off = harness(undefined, { deviceLocation: false });
    expect(await off.client.locale(fix())).toMatchObject({ kind: "clarify" });
    expect(off.fetcher).not.toHaveBeenCalled();
  });
  it("recognizes the question and leaves card operations alone", () => {
    for (const text of ["我在哪里", "我在哪儿？", "我的位置", "我现在在什么地方", "请问我在哪儿", "我现在的位置"])
      expect(parseLocaleIntent(text), text).toEqual({ kind: "locale" });
    for (const text of ["我的位置那张卡在哪", "把天气卡移动一下位置", "我在哪里可以设置倒计时", "帮我查一下我在哪里", "天气怎么样"])
      expect(parseLocaleIntent(text), text).toBeNull();
  });
  it("routes through the pipeline and the HTTP endpoint without a model", async () => {
    const h = harness();
    const calls: string[] = [];
    const result = await runIntent({ text: "我在哪里", canvasContext: emptyContext(), deviceLocation: fix() }, {
      data: h.client, credentials: new CredentialStore(),
      stepfun: { baseUrl: "https://unit.test", fetchImpl: async () => { calls.push("model"); throw new Error("must not call a model"); } },
    });
    expect(result).toEqual({ kind: "locale", usedProvider: "rules",
      locale: { name: "杭州市", admin1: "浙江省", country: "中国", basis: "device", answer: "你现在在杭州市，浙江省附近" } });
    expect(calls).toEqual([]);
    const app = createApp({ config: testConfig(), data: h.client });
    const reply = await app.request("/api/locale", { method: "POST", headers: authed, body: JSON.stringify({ deviceLocation: fix() }) });
    expect(await reply.json()).toMatchObject({ kind: "locale", locale: { answer: "你现在在杭州市，浙江省附近" } });
    expect(await (await app.request("/api/locale", { method: "POST", headers: authed, body: "{}" })).json()).toMatchObject({ kind: "locale", locale: { basis: "network" } });
    expect((await app.request("/api/locale", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(401);
  });
});

describe("geolocation over HTTP", () => {
  it("forwards the fix through /api/intent and refreshes card fields through /api/weather/here", async () => {
    const h = harness();
    const app = createApp({ config: testConfig(), data: h.client });
    const intent = await app.request("/api/intent", { method: "POST", headers: authed,
      body: JSON.stringify({ text: "外面天气怎么样", canvasContext: emptyContext(), deviceLocation: fix() }) });
    expect(await intent.json()).toMatchObject({ kind: "envelope", envelope: { spokenText: "已按当前位置显示杭州市天气" } });
    const refresh = await app.request("/api/weather/here", { method: "POST", headers: authed, body: JSON.stringify({ deviceLocation: fix({ latitude: 30.3 }) }) });
    const body = await refresh.json();
    expect(body).toMatchObject({ kind: "weather", displayProps: { tempC: 22.4, conditionIcon: "cloud" }, aliases: ["杭州市"],
      sourceData: { locationBasis: "device-geolocation", location: { latitude: 30.3 } } });
    expect(body).not.toHaveProperty("spokenText");
    expect((await app.request("/api/weather/here", { method: "POST", headers: authed, body: JSON.stringify({ deviceLocation: fix({ latitude: 30.30001 }) }) })).status).toBe(400);
    expect((await app.request("/api/weather/here", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(401);
  });
});
