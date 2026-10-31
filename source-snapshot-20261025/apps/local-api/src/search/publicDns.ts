import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";
import { blockedUrl, isPublicAddress, publicHttpsUrl } from "./policy.js";

export interface PublicAddress { address: string; family: number }
const dnsReply = z.object({ Status: z.literal(0), TC: z.literal(false).optional(),
  Question: z.array(z.object({ name: z.string().max(254), type: z.number().int() })).length(1),
  Answer: z.array(z.object({ name: z.string().max(254), type: z.number().int(), data: z.string().max(512) })).max(64).optional() });
const normalized = (name: string) => name.toLowerCase().replace(/\.$/, "");

export function parsePublicDns(body: string, hostname: string, type: 1 | 28): PublicAddress[] {
  const data = dnsReply.parse(JSON.parse(body));
  if (normalized(data.Question[0]!.name) !== hostname || data.Question[0]!.type !== type) throw blockedUrl();
  const out: PublicAddress[] = [];
  for (const row of data.Answer ?? []) {
    if (row.type === 5) { publicHttpsUrl(`https://${normalized(row.data)}/`); continue; }
    if (row.type !== 1 && row.type !== 28) continue;
    const family = row.type === 1 ? 4 : 6;
    if (isIP(row.data) !== family || !isPublicAddress(row.data)) throw blockedUrl();
    out.push({ address: row.data, family });
  }
  return out;
}

/** A fixed TLS-authenticated resolver; its bootstrap IP is not supplied by a
 * webpage, model, environment proxy, or the potentially fake local DNS. */
function doh(hostname: string, type: 1 | 28, parent: AbortSignal): Promise<PublicAddress[]> {
  const url = new URL("https://cloudflare-dns.com/dns-query"); url.search = new URLSearchParams({ name: hostname, type: String(type) }).toString();
  const signal = AbortSignal.any([parent, AbortSignal.timeout(5000)]);
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", agent: false, family: 4, signal, maxHeaderSize: 16384,
      lookup: (_host, _opts, callback) => callback(null, "1.1.1.1", 4),
      headers: { accept: "application/dns-json", "accept-encoding": "identity" } }, res => {
      const fail = () => { res.destroy(); req.destroy(); reject(blockedUrl()); };
      if (res.statusCode !== 200 || !String(res.headers["content-type"]).startsWith("application/dns-json")
        || Number(res.headers["content-length"] ?? 0) > 16384 || res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") { fail(); return; }
      let size = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 16384) fail(); else chunks.push(chunk); });
      res.on("end", () => { try { resolve(parsePublicDns(Buffer.concat(chunks).toString("utf8"), hostname, type)); } catch { reject(blockedUrl()); } });
      res.on("error", reject); res.on("aborted", () => reject(blockedUrl()));
    });
    req.on("error", reject); req.end();
  });
}

/** Only the known benchmark/fake-IP range qualifies for a second independent
 * resolution. Private, mixed, malformed, mapped and empty answers stay blocked. */
export async function resolvePublicAddresses(hostname: string, signal: AbortSignal, fallback: boolean,
  systemLookup: (host: string) => Promise<PublicAddress[]> = host => lookup(host, { all: true, verbatim: true }),
  publicLookup: (host: string, type: 1 | 28, signal: AbortSignal) => Promise<PublicAddress[]> = doh): Promise<PublicAddress[]> {
  let rows = await systemLookup(hostname); signal.throwIfAborted();
  const onlyFake = rows.length > 0 && rows.every(row => row.family === 4 && isIP(row.address) === 4 && /^198\.(?:18|19)\./.test(row.address));
  if (fallback && onlyFake) rows = (await Promise.all([publicLookup(hostname, 1, signal), publicLookup(hostname, 28, signal)])).flat();
  if (!rows.length || rows.some(row => !isPublicAddress(row.address) || isIP(row.address) !== row.family)) throw blockedUrl();
  return rows;
}
