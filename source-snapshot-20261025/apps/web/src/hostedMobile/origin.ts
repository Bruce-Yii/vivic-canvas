export const BOOTSTRAP_ORIGIN = "https://appassets.androidplatform.net";
export interface HostedAndroidBridge {
  connectSpace(origin: string): void;
  /** Optional on older native packages. Fixed in-memory diagnostics are readable only by the immutable bootstrap. */
  getConnectionError?(): string;
}
/** Accept exactly a service origin, never a pairing URL or arbitrary path. */
export function parseServiceOrigin(raw: string): string {
  if (raw.length > 2048) throw new Error("服务地址过长。");
  const input = raw.trim();
  // Check the original authority before WHATWG URL repairs numeric hosts,
  // percent escapes, backslashes, IDN or trailing-dot names.
  const match = /^https:\/\/(\[[^\]]+\]|[a-z0-9.-]+)(?::([0-9]+))?\/?$/i.exec(input);
  if (!match || /[\s\p{Cc}%\\]/u.test(input)) throw new Error("请输入完整 HTTPS 服务地址，仅包含域名和可选端口。");
  const host = match[1]!.toLowerCase(), port = match[2] === undefined ? -1 : Number(match[2]);
  if (host === "appassets.androidplatform.net" || host.endsWith(".") || !Number.isSafeInteger(port) || port === 0 || port === 80 || port > 65535 || port < -1) throw new Error("此服务域名或端口不可用。");
  if (!host.startsWith("[")) {
    if (host.split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) throw new Error("服务域名无效。");
    if (/^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*$/i.test(host)) {
      const octets = host.split(".");
      if (octets.length !== 4 || octets.some(value => !/^(?:0|[1-9][0-9]{0,2})$/.test(value) || Number(value) > 255)) throw new Error("请使用完整且无歧义的服务 IP 地址。");
    }
  }
  let url: URL; try { url = new URL(input); } catch { throw new Error("服务地址无效。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin === "null") throw new Error("仅支持 HTTPS 服务域名；请去掉路径、参数和配对码。");
  return url.origin;
}
export function hostedAndroidBridge(): HostedAndroidBridge | undefined {
  if (window.location.origin !== BOOTSTRAP_ORIGIN) return undefined;
  const bridge = (window as Window & { VivicAndroid?: Partial<HostedAndroidBridge> }).VivicAndroid;
  return typeof bridge?.connectSpace === "function" ? bridge as HostedAndroidBridge : undefined;
}
