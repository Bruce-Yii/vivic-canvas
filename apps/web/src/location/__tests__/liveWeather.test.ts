// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardRecord } from "@/contracts";
import { testCards } from "@/cards/__tests__/fixtures";
import { createMemoryDB } from "@/persistence/db";
import { emptyVivicState } from "@/persistence/canvasRecord";
import { createCanvasStore } from "@/state/canvasStore";
import { createMemoryHub, flushChannel } from "@/sync/channel";
import { createMemoryLockProvider } from "@/sync/testing";
import { createControlHost } from "@/sync/controlHost";
import type { WeatherHereFields } from "@/ai/api";
import { asksWhere, fixForRequest, freshFix, getLocationSnapshot, looksLikeWeather, resetLocationForTests, resumeLocation, stopLocation, LOCATION_PREFERENCE } from "../deviceLocation";
import { refreshReason, startLiveWeather } from "../liveWeather";

const NOW = Date.parse("2026-10-17T08:00:00.000Z");
const live = (patch: Record<string, unknown> = {}, id = "TEST-live"): CardRecord => ({ ...testCards.WeatherCard, id,
  metadata: { ...testCards.WeatherCard.metadata, aliases: ["杭州市", "TEST 我的天气"] },
  sourceData: { provenance: "open-meteo", locationBasis: "device-geolocation", fetchedAt: new Date(NOW - 60_000).toISOString(),
    location: { name: "杭州市", latitude: 30.27, longitude: 120.16, accuracyM: 30, capturedAt: new Date(NOW).toISOString() }, ...patch } });
const fix = (latitude = 30.27, longitude = 120.16) => ({ latitude, longitude, accuracyM: 25, capturedAt: new Date(NOW).toISOString() });
const fields = (name = "北京市"): WeatherHereFields => ({ displayProps: { tempC: 9.5, conditionIcon: "rain" }, aliases: [name],
  sources: [{ title: "TEST forecast", url: "https://api.open-meteo.com/v1/forecast?latitude=39.9", fetchedAt: new Date(NOW).toISOString(), provider: "open-meteo/forecast", readFullPage: false }],
  sourceData: { provenance: "open-meteo", locationBasis: "device-geolocation", fetchedAt: new Date(NOW).toISOString(),
    location: { name, latitude: 39.9, longitude: 116.4, accuracyM: 25, capturedAt: new Date(NOW).toISOString() } } });

describe("when a live weather card refreshes", () => {
  it.each([
    ["the device stays put", live(), fix(30.27, 120.17), null],
    ["the device moved more than 1.5 km", live(), fix(30.3, 120.16), "moved"],
    ["a real fix replaces a network estimate", live({ locationBasis: "network-region-estimate" }), fix(), "located"],
    ["data are older than 15 minutes", live({ fetchedAt: new Date(NOW - 16 * 60_000).toISOString() }), null, "stale"],
    ["a city was named by the user", { ...live({ locationBasis: undefined, requestedCity: "上海" }) }, fix(39.9, 116.4), null],
    ["it is not a weather card", testCards.NoteCard, fix(39.9, 116.4), null],
  ])("%s", (_name, card, position, reason) => expect(refreshReason(card as CardRecord, position, NOW)).toBe(reason));

  it("fetches once for all due cards, skips deleted and named-city cards, and backs off after a failure", async () => {
    let now = NOW, cards: CardRecord[] = [live({}, "TEST-a"), live({}, "TEST-b"), { ...live({ locationBasis: undefined, requestedCity: "上海" }, "TEST-city") }];
    let listener = () => {};
    const fetchHere = vi.fn(async () => { cards = cards.filter(card => card.id !== "TEST-b"); return { kind: "weather", ...fields() }; });
    const refresh = vi.fn();
    const stop = startLiveWeather({ cards: () => cards, fix: () => fix(39.9, 116.4), subscribeFix: fn => { listener = fn; return () => {}; },
      fetchHere, refresh, now: () => now, intervalMs: 10_000_000 });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(fetchHere).toHaveBeenCalledWith(fix(39.9, 116.4));
    expect(refresh).toHaveBeenCalledWith("TEST-a", fields());
    fetchHere.mockResolvedValueOnce({ kind: "error", message: "TEST down" } as never);
    now += 61_000; listener(); await vi.waitFor(() => expect(fetchHere).toHaveBeenCalledTimes(2));
    now += 61_000; listener(); await Promise.resolve();
    expect(fetchHere).toHaveBeenCalledTimes(2);
    stop();
  });

  it("the owner swaps verified fields in place and keeps layout, pin, subcards and user aliases", async () => {
    const db = createMemoryDB(), store = createCanvasStore();
    const host = createControlHost({ db, store, channel: createMemoryHub().createChannel(), lockProvider: createMemoryLockProvider(), reminderPollMs: 1000000 });
    await host.start();
    const pinned = { ...live(), layout: { ...live().layout, x: 640, y: 320, pinned: true },
      metadata: { ...live().metadata, subcards: [{ id: "TEST-sub", text: "TEST 记得带伞" }] } };
    store.loadState({ ...emptyVivicState(), stage: "WORKSPACE", cards: [{ record: pinned }, { record: testCards.NoteCard }] });
    expect(host.refreshWeatherCard("TEST-live", fields()).ok).toBe(true);
    await flushChannel();
    const record = store.getState().cards[0]!.record;
    expect(record).toMatchObject({ id: "TEST-live", layout: pinned.layout, displayProps: { tempC: 9.5, conditionIcon: "rain" },
      sourceData: { location: { name: "北京市" } }, metadata: { subcards: pinned.metadata.subcards, aliases: ["北京市", "TEST 我的天气"] } });
    expect(record.sources).toEqual(fields().sources);
    expect((await db.getCanvas(host.getSnapshot().activeCanvasId!))!.cardsById["TEST-live"].displayProps).toEqual({ tempC: 9.5, conditionIcon: "rain" });
    expect(host.refreshWeatherCard("TEST-note", fields())).toEqual({ ok: false, error: "not-live-weather" });
    expect(host.refreshWeatherCard("TEST-live", { ...fields(), sourceData: { provenance: "open-meteo", requestedCity: "上海" } })).toEqual({ ok: false, error: "invalid-card" });
    host.stop();
  });
});

describe("browser geolocation", () => {
  let watch: ReturnType<typeof vi.fn>, success: PositionCallback, failure: PositionErrorCallback;
  let permission = "prompt";
  beforeEach(() => {
    permission = "prompt";
    localStorage.clear(); resetLocationForTests();
    watch = vi.fn((ok: PositionCallback, error: PositionErrorCallback) => { success = ok; failure = error; return 7; });
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { watchPosition: watch, clearWatch: vi.fn() } });
    Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: async () => ({ state: permission }) } });
  });
  afterEach(() => { resetLocationForTests(); localStorage.clear(); });
  const position = (latitude: number, longitude: number) => ({ coords: { latitude, longitude, accuracy: 18.6 }, timestamp: Date.now() }) as GeolocationPosition;

  it("asks on the first weather question and sends only a rounded, recent fix", async () => {
    const pending = fixForRequest(5000);
    expect(watch).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), expect.objectContaining({ enableHighAccuracy: true }));
    success(position(30.274123, 120.155187));
    expect(await pending).toEqual({ latitude: 30.27, longitude: 120.16, accuracyM: 19, capturedAt: expect.any(String) });
    expect(getLocationSnapshot()).toMatchObject({ status: "watching", fix: { latitude: 30.274123 } });
    expect(localStorage.getItem(LOCATION_PREFERENCE)).toBe("on");
    success(position(39.9087, 116.3975));
    expect(freshFix()).toMatchObject({ latitude: 39.91, longitude: 116.4 });
  });

  it("does not wait or re-prompt once the user declined or the browser denied", async () => {
    stopLocation();
    expect(await fixForRequest()).toBeNull();
    expect(watch).not.toHaveBeenCalled();
    localStorage.clear();
    const pending = fixForRequest();
    failure({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: "" } as GeolocationPositionError);
    expect(await pending).toBeNull();
    expect(getLocationSnapshot().status).toBe("denied");
    expect(await fixForRequest()).toBeNull();
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("requests location on opening without waiting for a weather question", async () => {
    await resumeLocation();
    expect(watch).toHaveBeenCalledTimes(1);
    await resumeLocation(); expect(watch).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(LOCATION_PREFERENCE)).toBe("on");
  });

  it("respects an explicit off choice and does not repeat browser-denied requests", async () => {
    stopLocation(); await resumeLocation(); expect(watch).not.toHaveBeenCalled();
    localStorage.removeItem(LOCATION_PREFERENCE);
    permission = "denied"; await resumeLocation();
    expect(watch).not.toHaveBeenCalled(); expect(getLocationSnapshot().status).toBe("denied");
    permission = "granted"; await resumeLocation(); expect(watch).toHaveBeenCalledTimes(1);
  });

  it("can request location when the Permissions API query is unsupported", async () => {
    Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: async () => { throw new TypeError("Unsupported query"); } } });
    await resumeLocation(); expect(watch).toHaveBeenCalledTimes(1);
  });

  it.each(["今天天气如何", "外面冷不冷", "要不要带伞", "北京气温", "我在哪里", "我在哪儿？", "我的位置", "请问我现在在什么地方"])
    ("%s carries the fix", text => expect(looksLikeWeather(text)).toBe(true));
  it.each(["我的位置那张卡在哪", "把天气卡移动一下位置", "我在哪里可以设置倒计时"])
    ("%s is about a card, not the device", text => expect(asksWhere(text)).toBe(false));
  it.each(["加待办：买菜", "十分钟倒计时"])("%s does not", text => expect(looksLikeWeather(text)).toBe(false));
});
