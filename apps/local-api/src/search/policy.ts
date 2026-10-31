import { BlockList, isIP } from "node:net";
import { SearchError } from "./errors.js";

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) blockedV6.addSubnet(address, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  // Reject mapped IPv4, NAT64, ULA, link-local, multicast and transition ranges.
  return family === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
}

export function blockedUrl(): SearchError {
  return new SearchError("search-blocked-url", "仅可读取 HTTPS 443 端口的公开网页，禁止本地或内网地址。", 400);
}

/** Lexical checks are also applied to search citations; they do not fetch a page. */
export function publicHttpsUrl(raw: string): URL {
  if (raw.length > 2048 || /[\s\u0000-\u001f\u007f\\]/u.test(raw)) throw blockedUrl();
  let url: URL;
  try { url = new URL(raw); } catch { throw blockedUrl(); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw blockedUrl();
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw blockedUrl();
  } else if (!host.includes(".") || host.length > 253
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)
    || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion|arpa)$/i.test(host)) {
    throw blockedUrl();
  }
  if (!isIP(host)) url.hostname = host;
  url.hash = "";
  return url;
}
