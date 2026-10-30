/** QR codes identify this controller only; they may never select an arbitrary relay. */
export const PRODUCTION_MOBILE_URL = "https://edsionc.top/vivic-remote/";
export const PRODUCTION_RELAY_URL = "wss://edsionc.top/vivic-remote/relay";
export const NATIVE_ORIGIN = "https://appassets.androidplatform.net";

export interface ControllerPairing { code: string; host: string; transportUrl?: string }
/** A native user confirms the exact HTTPS host before this endpoint is ever contacted. */
export function parseControllerPairingInput(raw: string, location: Pick<Location, "origin" | "href"> = window.location): ControllerPairing {
  const value = raw.trim();
  if (/^https?:/i.test(value)) {
    const url = new URL(value), params = new URLSearchParams(url.hash.slice(1));
    if (params.get("online") === "1") {
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      const code = params.get("pair");
      if (url.username || url.password || url.search || !["/remote/", "/remote/index.html"].includes(url.pathname) ||
        !(url.protocol === "https:" || url.protocol === "http:" && loopback && location.origin !== NATIVE_ORIGIN) ||
        location.origin !== NATIVE_ORIGIN && url.origin !== location.origin || !code || !/^[A-F0-9]{16}$/.test(code) ||
        [...params.keys()].length !== 2 || !params.has("pair")) throw new Error("请使用电脑 Vivic 生成的线上配对二维码。");
      return { code, host: url.host, transportUrl: `${url.origin}/api/online/mobile/phone` };
    }
  }
  const candidate = parsePairingInput(value, trustedMobileUrl(location));
  const page = new URL(location.href);
  if (location.origin !== NATIVE_ORIGIN && /^\/remote\/(?:index\.html)?$/.test(page.pathname)) candidate.transportUrl = `${page.origin}/api/online/mobile/phone`;
  return candidate;
}

export function trustedMobileUrl(location: Pick<Location, "origin" | "href"> = window.location): string {
  if (location.origin === NATIVE_ORIGIN) return PRODUCTION_MOBILE_URL;
  const url = new URL(location.href);
  url.search = ""; url.hash = "";
  return url.href;
}

export function parsePairingInput(raw: string, trustedUrl: string): ControllerPairing {
  const value = raw.trim();
  const trusted = new URL(trustedUrl);
  if (/^[A-Z0-9-]{6,32}$/i.test(value)) return { code: value.toUpperCase(), host: trusted.host };
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("这不是 Vivic 配对码或配对链接。请从电脑重新获取。"); }
  const normalizedPath = (path: string) => path.replace(/index\.html$/, "").replace(/\/$/, "");
  const secure = url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "127.0.0.2", "[::1]"].includes(url.hostname));
  if (!secure || url.origin !== trusted.origin || normalizedPath(url.pathname) !== normalizedPath(trusted.pathname) || url.username || url.password || url.search) {
    throw new Error("二维码地址与此控制台不一致。请使用电脑 Vivic 设置中的手机控制二维码。");
  }
  const params = new URLSearchParams(url.hash.slice(1));
  const code = params.get("pair");
  if (!code || !/^[A-F0-9]{16}$/.test(code) || [...params.keys()].length !== 1) throw new Error("配对二维码格式无效。请在电脑生成新码。");
  return { code, host: url.host };
}
