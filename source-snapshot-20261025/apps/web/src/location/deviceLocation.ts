/**
 * Live device position for "where I am" weather. Uses the browser
 * Geolocation API (on Windows Edge: the system location service — GPS,
 * Wi-Fi and cell). Only the on/off choice is stored; positions stay in this
 * tab's memory and leave it rounded to 0.01° (about 1 km).
 */
export const LOCATION_PREFERENCE = "vivic.deviceLocation.v1";

export interface DeviceFix { latitude: number; longitude: number; accuracyM: number; capturedAt: string }
export type LocationStatus = "off" | "locating" | "watching" | "denied" | "unavailable" | "unsupported";
export interface LocationSnapshot { status: LocationStatus; fix: DeviceFix | null; error?: string }

/** Matches the API: older fixes are treated as missing. */
export const FIX_MAX_AGE_MS = 10 * 60_000;
const round = (value: number) => Math.round(value * 100) / 100;

const listeners = new Set<() => void>();
let snapshot: LocationSnapshot = { status: supported() ? "off" : "unsupported", fix: null };
let watchId: number | null = null;
let waiters: Array<(fix: DeviceFix | null) => void> = [];

function supported() { return typeof navigator !== "undefined" && "geolocation" in navigator; }
function set(next: LocationSnapshot) {
  snapshot = next;
  listeners.forEach(fn => fn());
  if (next.status !== "locating") { const pending = waiters; waiters = []; pending.forEach(fn => fn(next.fix)); }
}
const readPreference = () => { try { return localStorage.getItem(LOCATION_PREFERENCE); } catch { return null; } };
const writePreference = (value: "on" | "off") => { try { localStorage.setItem(LOCATION_PREFERENCE, value); } catch { /* private mode */ } };

export const subscribeLocation = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getLocationSnapshot = () => snapshot;
/** The user turned location off explicitly; weather wording must not re-prompt. */
export const locationDeclined = () => readPreference() === "off";

const errorStatus = (error: GeolocationPositionError): LocationSnapshot => error.code === error.PERMISSION_DENIED
  ? { status: "denied", fix: null, error: "浏览器未允许定位。可在地址栏左侧的站点权限里允许“位置”。" }
  : { status: "unavailable", fix: snapshot.fix, error: "系统暂时拿不到位置，请确认 Windows 设置里的“定位服务”已开启。" };

/** Starts (or keeps) the live watch. The first call shows the browser's permission prompt. */
export function startLocation() {
  if (!supported()) { set({ status: "unsupported", fix: null, error: "此浏览器不支持定位。" }); return; }
  writePreference("on");
  if (watchId !== null) return;
  set({ ...snapshot, status: snapshot.fix ? "watching" : "locating", error: undefined });
  watchId = navigator.geolocation.watchPosition(position => {
    set({ status: "watching", fix: { latitude: position.coords.latitude, longitude: position.coords.longitude,
      accuracyM: position.coords.accuracy, capturedAt: new Date(position.timestamp || Date.now()).toISOString() } });
  }, error => {
    const next = errorStatus(error);
    if (next.status === "denied") stopWatch();
    set(next);
  }, { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 });
}

function stopWatch() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}
export function stopLocation() {
  writePreference("off");
  stopWatch();
  set({ status: supported() ? "off" : "unsupported", fix: null });
}

/** Request location on opening Vivic, while respecting an explicit off choice. */
export async function resumeLocation() {
  if (!supported() || locationDeclined() || watchId !== null) return;
  try {
    const permission = await navigator.permissions?.query({ name: "geolocation" });
    if (locationDeclined() || watchId !== null) return;
    if (permission?.state === "denied") {
      set({ status: "denied", fix: null, error: "浏览器未允许定位。可在地址栏左侧的站点权限里允许“位置”。" });
      return;
    }
  } catch { /* A browser without Permissions API can still request geolocation. */ }
  if (locationDeclined() || watchId !== null) return;
  startLocation();
}

/** The latest fix if recent, rounded for sending. */
export function freshFix(now = Date.now()): DeviceFix | null {
  const fix = snapshot.fix;
  if (!fix || now - Date.parse(fix.capturedAt) > FIX_MAX_AGE_MS) return null;
  return { latitude: round(fix.latitude), longitude: round(fix.longitude), accuracyM: Math.min(100_000, Math.round(fix.accuracyM)), capturedAt: fix.capturedAt };
}

/**
 * For a weather or "where am I" question: start locating if needed and wait
 * briefly for a first fix. Resolves null (network-region fallback) when
 * declined, denied or slow — never blocks the request for long.
 */
export async function fixForRequest(timeoutMs = 6000): Promise<DeviceFix | null> {
  const fix = freshFix();
  if (fix || !supported() || locationDeclined() || snapshot.status === "denied") return fix;
  startLocation();
  if (snapshot.status !== "locating") return freshFix();
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, timeoutMs);
    waiters.push(done);
    function done() { clearTimeout(timer); resolve(); }
  });
  return freshFix();
}

// Weather wording without a named city, plus asking where the user is. Coarse on
// purpose: a false hit only attaches the rounded fix, and never names a card.
const WEATHER_WORDING = /天气|气温|温度|多少度|冷不冷|热不热|冷吗|热吗|下雨|下雪|带伞|穿什么|刮风/;
const WHERE_WORDING = /^(?:请问|问一下)?\s*(?:我|我们)?\s*(?:现在|目前|当前)?\s*(?:在(?:哪|哪里|哪儿|什么地方)|的?(?:位置|所在地)(?:在)?(?:哪|哪里|哪儿|是什么|是哪里|是哪儿|在哪)?)(?:啊|呀|呢|吗|？|\?|。)?$/;
const NOT_WHERE = /卡片?|画布|待办|便笺|提醒|倒计时|删|移|移动|放大|聚焦|显示|表格|图表|搜索|天气/;
export const looksLikeWeather = (text: string) => WEATHER_WORDING.test(text) || asksWhere(text);
/** Same shape the API uses for "我在哪里", so the fix is attached to those questions too. */
export const asksWhere = (text: string) => text.trim().length <= 40 && WHERE_WORDING.test(text.trim()) && !NOT_WHERE.test(text);

/** Test hook. */
export function resetLocationForTests() {
  stopWatch(); waiters = [];
  snapshot = { status: supported() ? "off" : "unsupported", fix: null };
}
