# Data adapters: weather and explicit numeric data

> Mainline integration update (2026-10-15): weather and numeric adapters are wired into the real intent pipeline and passed the live browser flow. Open-Meteo weather displays only temperature/icon by default; the weather itself links to licensing, with Open-Meteo/GeoNames/CC BY 4.0 and transformation attribution in the Radix hover detail. Earlier module-only scope and pending-mainline notes below are historical. See [final integration report](../evidence/phase3-final/REPORT.md).

Implementation lives entirely in `apps/local-api/src/data/`. This module does not mount HTTP routes, change the planner, load credentials, call an LLM, start a server, or provide speech. The mainline owns integration.

## Integration

```ts
import { createDataClient, handleDataIntent } from "./data/index.js";

const data = createDataClient({
  fetchImpl, // optional; always supply a stub in tests
  config: { timeoutMs: 12_000, maxResponseBytes: 128 * 1024,
    maxConcurrent: 2, requestsPerMinute: 10 },
});

// Call before model planning for supported requests. null means unrelated.
const result = await data.handleDataIntent(text, canvasContext, signal);
// Promise<IntentResult | null>

// Lower-level provider call; returns WeatherEvidence or a clarification.
const weather = await data.weather("上海,上海市", signal);

// Alternative: module-level handler with a lazy shared client.
const result2 = await handleDataIntent(text, canvasContext, signal);
// Optional fourth argument accepts { weather(city, signal) }, for injection.
```

All successful card actions pass the existing `ActionEnvelopeSchema`. A standby context adds `stage.awaken`. Requests create one minimal card or update one existing chart, then fit the canvas. Weather omits `usedProvider` because the current `IntentResult`/wire enum has no data provider value. Local numeric conversions use `usedProvider: "rules"`. Mainline must not relabel weather as a model response or allow model fallback to fabricate weather after an error/clarification.

## Weather behavior and evidence

2026-10-21: the foreground owner now requests browser location permission on opening Vivic, before the first weather question. An explicit location-off choice is preserved; blocked permissions show recovery guidance. The permission request does not run in read-only or Display windows. Earlier first-weather-question prompt behavior below is historical.

- Current conditions only: `城市天气`, `城市当前天气`, `查询城市今天的天气`, and `城市气温` with optional polite prefix. No GPS, remembered location or future forecast.
- Asking where the user is (2026-10-17): `我在哪里`, `我在哪儿`, `我的位置`, `我现在在什么地方` are answered from the same position source with no card, no model and no search — Control shows and speaks e.g. `你现在在上海市闵行区附近`. Card operations (`我的位置那张卡在哪`, `把天气卡移动一下位置`) and other topics are excluded by `parseLocaleIntent`. Without a fix the answer says it is a network estimate (`按网络大致判断你在上海附近`), and a municipality is not repeated. `POST /api/locale` returns the same place for the live-refresh path; it requires the same bearer token as `/api/intent`.
- Where I am (2026-10-17): with no city named (`今天天气如何`, `天气怎么样`, `这里/本地/外面天气`, `外面冷不冷`, `现在多少度`, or a model `lookup` without `city`) Control attaches the browser Geolocation fix (Edge on Windows uses the system location service: GPS/Wi-Fi/cell). The first such question shows the browser permission prompt; Control → 位置 can turn it on/off. The fix is rounded to 0.01° (~1 km) in the browser before it leaves the page, the API schema rejects finer values, and fixes older than 10 minutes are ignored. The API reads current weather at that point from Open-Meteo and names it via `https://photon.komoot.io/reverse` (OpenStreetMap, ODbL, keyless; an identifying `User-Agent` is required). Only administrative fields are read — never the street, building or POI name — giving labels such as `杭州市` or `上海市黄浦区`; if naming fails the real weather is still shown as `当前位置`. Cards store `locationBasis: "device-geolocation"` with the rounded coordinates and accuracy.
- Live refresh: while the owner Control page is open, every `device-geolocation` or `network-region-estimate` card is refreshed in place via `POST /api/weather/here` when the device moves more than 1.5 km, a real fix replaces a network estimate, or the data are older than 15 minutes (checked each minute and on every position update; 5-minute back-off after a failure). The swap is a Control-internal store update (layout, pin, subcards and user aliases kept), not a wire Action, so a model can never rewrite a card's sources. Cards for a named city never follow the device.
- Fallback without a fix (denied, turned off, unsupported or slow >6 s): the city the network exits from, via `https://ipinfo.io/json` (keyless). Only that city name is used — geocoded and matched to the nearest same-country GeoNames place within 60 km; the IP, ISP, postal code and estimated coordinates are dropped. Cached in memory for 30 minutes, failures not cached. A VPN/proxy changes this estimate. If it fails the user is asked to name the city. `VIVIC_DEVICE_LOCATION=off` disables both and restores always-ask.
- Fixed endpoints: `https://geocoding-api.open-meteo.com/v1/search` and `https://api.open-meteo.com/v1/forecast`. User text only supplies an encoded location search term. No user URL or endpoint configuration is supported.
- Geocoding uses `count=10`, JSON, and Chinese/English language based on the supplied place text. Exact normalized names and populated-place/administrative feature codes are required. A trailing Chinese `市` is normalized before lookup. Prefix-only matches, no matches, multiple candidates, or a full result page clarify. The adapter never ranks by population or selects the first candidate. Qualify homonyms with a country or administrative area after a comma, as supported by the [official geocoding API](https://open-meteo.com/en/docs/geocoding-api).
- Real probing found several different locations named 上海. Consequently `上海天气` can clarify; `上海,上海市天气` resolved uniquely in the recorded live check. This is intentional ambiguity handling, not a network failure.
- Forecast requests only `current=temperature_2m,weather_code,is_day`, Celsius, UTC/GMT, Unix time and one forecast day. The original public query URLs, per-request `fetchedAt` and providers are preserved in `sources`; no URL is invented. `readFullPage` remains false because these are API field reads.
- `WeatherCard.displayProps` contains only `tempC` and `conditionIcon`. `sourceData` retains the selected location, coordinates, model-grid coordinates, WMO code, day/night, interval, fetched time and `observedAt`. Here `observedAt` is explicitly marked `timeKind: "model-valid-time"` and `currentConditionsBasis: "weather-model"`: Open-Meteo current conditions are based on weather model data, not a claimed local station measurement. See the [forecast documentation](https://open-meteo.com/en/docs).
- Current model time older than three hours or more than fifteen minutes ahead is rejected. Null/absent temperatures, wrong units, impossible values, unknown WMO codes and malformed responses never become a sunny/zero-temperature default. Clear sky/mainly clear map to `sun` or `night`; other documented codes map to cloud, fog, rain, snow or storm.

## Network limits

Only native/injected fetch to those fixed HTTPS endpoints is used, with `redirect: "error"`, `credentials: "omit"` and no authorization/cookie headers. Error bodies are cancelled without reading; final response URLs are checked as well. Generic arbitrary-web fetch and its DNS/socket-pinning policy are untouched.

One 12-second deadline covers both provider calls. Caller abort, stalled body reads, and even injected fetch implementations ignoring abort are bounded; late response bodies are cancelled. Limits apply both to declared Content-Length and actual decoded body bytes, including streamed JSON; UTF-8 and JSON/schema are validated. Default response cap is 128 KiB per HTTP response, configurable up to 256 KiB; timeout up to 30 seconds. Admission defaults to two concurrent weather lookups and ten lookups per minute per client (normally two HTTP calls per lookup). A shared client should be reused by mainline. No retries or paid-provider fallback occurs. Errors contain static messages, never provider bodies or private abort reasons.

## User table/chart data

Supported examples:

```text
用表格记录：苹果3，香蕉5
把这组数据画成柱状图：周一3，周二5，周三4
折线图：周一3，周二5，周三4
饼图：苹果3，香蕉5
用表格记录：Q1:1.001，Q2:-0.5，零0
```

The parser accepts one named numeric series with 1–30 unique labels. Rows can be separated by Chinese/ASCII commas, semicolons or newlines. Labels containing digits require `:`/`：`/`=` before their value, preventing ambiguous `Q13` splitting. Values must be finite ordinary decimal literals, at most six decimal places and magnitude at most one trillion, and must round-trip without silently losing their explicit decimal representation. Pie values must be nonnegative and at least one positive. No percentages, unit inference/conversion, scientific notation, missing-value guessing, aggregates, multi-series inference or external data lookup is performed.

Tables use exactly `columns: ["名称", "数值"]` and explicit rows. Charts use the requested `bar`/`line`/`pie` and exact points without invented axes or units. `sources` is empty. `sourceData` includes `provenance: "user-input"`, original request, captured time and parsed rows. Unsupported/complex input or mixed destructive/multiple instructions returns clarification with no partial card/action.

## Existing data-card conversions

```text
把这张表格画成柱状图
把第2张表格画成折线图
把「销售表」画成饼图
把当前聚焦的图表改成折线图
把这张图表转成表格
```

Conversion uses only the current `ctx.cards` TableCard `displayProps.columns/rows` or ChartCard `displayProps.points`; the LLM never supplies values. A table must have exactly two complete columns, a nonempty string/numeric category and a finite numeric value per row. Numeric strings, nulls, duplicate labels, unknown series and malformed data clarify without coercion, aggregation, omission or filling values. Existing charts retain their exact x coordinate types and axis labels. Pie with any negative value or all zeros clarifies; values are never made absolute.

The source must be unique within the requested card type, explicitly selected by ordinal (context card order), or uniquely matched by a quoted id/alias. With multiple cards, a deictic reference such as `这张` can use the last focusHistory entry only when it points to a live eligible card. No fallback to an older focus, newest-created card or another valid table occurs. A generic ambiguous `把表格…` clarifies even if there is focus history. Mixed deletion/multiple operations never execute only the conversion clause.

Table-to-chart creates a new chart and leaves the table intact. Chart-to-chart uses `card.update` on the original chart, retaining its original full sources/sourceData in canvas state and adding only `dataTransform` metadata. Existing sources are never fetched during conversion.

The current wire context omits top-level sources and reduces nested sourceData to summaries. To preserve evidence without changing that schema, newly created numeric and converted cards include a versioned `sourceData.dataProvenanceJson` string (at most 32 KiB, bounded nesting, validated evidence refs). The existing frontend preserves this scalar in sourceDataSummary. Conversion can restore the exact supplied sources and original nested metadata from it. This is a context transport record, not cryptographic proof or independent verification of a source. Values still come exclusively from current displayProps, never the serialized provenance.

Legacy `user-input` cards without this string can convert with empty sources while explicitly retaining `provenanceCompleteness: "context-summary"`; nested original values are not claimed to have survived. An external-source table without recoverable evidence clarifies instead of silently losing sources. In-process callers may also supply actual `sources` and `sourceData` on an enriched context card; both are validated and bounded. The HTTP schema remains unchanged and does not accept those extra top-level card fields.

## Attribution and service terms (checked 2026-10-15)

Open-Meteo API data are CC BY 4.0. The [official licence page](https://open-meteo.com/en/licence) requires credit, a licence link, identification of modifications and an Open-Meteo link next to displayed data. Location data are based on GeoNames, identified in both [geocoding attribution](https://open-meteo.com/en/docs/geocoding-api#attribution) and the licence page. Every weather card carries Open-Meteo/GeoNames links, the CC BY 4.0 link and the field-selection/icon-mapping transformation note in `sourceData.attribution`, as well as API evidence refs. Mainline/UI must make attribution accessible beside the displayed weather; metadata alone does not satisfy the stated display requirement. This task does not change frontend display fields.

The [free-service terms](https://open-meteo.com/en/terms) restrict the hosted free API to non-commercial use, with rate limits; [commercial service](https://open-meteo.com/en/pricing) uses a separate customer endpoint and key. This adapter implements the personal/non-commercial no-key path only. It does not silently use paid resources or imply free commercial permission. The provider's AGPL server source is not vendored or linked as a library; this module calls public HTTP APIs. No new dependency is installed.

## Verification

```sh
pnpm --filter @vivic/local-api exec vitest run tests/data.test.ts tests/data-transform.test.ts
VIVIC_DATA_LIVE=1 pnpm --filter @vivic/local-api exec vitest run tests/data.live.test.ts
pnpm --filter @vivic/local-api test
pnpm --filter @vivic/local-api typecheck
```

All ordinary protocol/security/parser tests inject fetch stubs. The live test is explicitly opt-in, uses no key or local service, and writes `evidence/data-providers/open-meteo-live.json`; a failed live request records `BLOCKED` and fails the test rather than claiming success. It does not read environment credential files.

Latest recorded live result on 2026-10-15 at 08:15:39 UTC: `上海,上海市天气` returned a schema-valid WeatherCard with `tempC: 22.1`, icon `cloud`, WMO code 3 and model time 08:15 UTC; total elapsed time 3215 ms. The qualified-city comma syntax worked on this machine; this run was not BLOCKED. These values describe that recorded response, not a forecast for future readers. The JSON evidence preserves both exact request URLs and timestamps. Browser rendering, visible attribution, mainline routing and synchronization remain mainline acceptance work.
