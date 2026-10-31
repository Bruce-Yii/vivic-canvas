import { request } from "node:https";
import { isIP } from "node:net";
import { fetch as undiciFetch } from "undici";
import { proxyDispatcher } from "../openaiProxy.js";
import { SearchError } from "./errors.js";
import { blockedUrl, isPublicAddress, publicHttpsUrl } from "./policy.js";
import { resolvePublicAddresses } from "./publicDns.js";

export interface HttpsReply {
  status: number;
  contentType: string;
  location?: string;
  body: Buffer;
}

export function abortError(signal: AbortSignal): SearchError {
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? new SearchError("search-timeout", "联网查询超时，请稍后重试。", 504)
    : new SearchError("search-cancelled", "联网查询已取消。", 503);
}

/** DNS lookups cannot be cancelled by Node; detach them on abort, with no socket opened. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** One hop only. Connects to the validated address, preserving TLS/SNI for the original host. */
export async function requestPublicHttps(raw: string, options: {
  signal: AbortSignal;
  maxBytes: number;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  acceptContentType: (type: string) => boolean;
  publicDnsFallback?: boolean;
}): Promise<HttpsReply> {
  const { signal, maxBytes } = options;
  if (signal.aborted) throw abortError(signal);
  const url = publicHttpsUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily }]
    : await abortable(resolvePublicAddresses(hostname, signal, options.publicDnsFallback === true), signal);
  if (signal.aborted) throw abortError(signal);
  if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family)) throw blockedUrl();
  const pinned = addresses.find(a => a.family === 4) ?? addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: options.method ?? "GET",
      agent: false,
      family: pinned.family,
      // Never inherit proxy/environment routing, cookies, auth, or a shared agent.
      lookup: (_host, _opts, callback) => callback(null, pinned.address, pinned.family),
      headers: {
        "User-Agent": "Vivic-Search-PoC/0.6",
        "Accept-Encoding": "identity",
        ...options.headers,
      },
      signal,
      maxHeaderSize: 16 * 1024,
    }, (res) => {
      const status = res.statusCode ?? 0;
      const contentType = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      const location = res.headers.location;
      // Destroying an incoming response may synchronously emit "aborted".
      // Preserve the actual policy/size error before teardown emits that event.
      const fail = (error: SearchError) => { reject(error); res.destroy(); req.destroy(); };
      // Cancel error/redirect bodies without buffering or draining an unbounded stream.
      if (status < 200 || status >= 300) {
        res.destroy();
        resolve({ status, contentType, location, body: Buffer.alloc(0) });
        return;
      }
      if (!options.acceptContentType(contentType)) {
        fail(new SearchError("search-unsupported-content", "网页响应不是支持的文本类型。", 415)); return;
      }
      if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
        fail(new SearchError("search-unsupported-content", "不接受压缩网页响应。", 415)); return;
      }
      const length = res.headers["content-length"];
      if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
        fail(new SearchError("search-too-large", "网页响应超过大小限制。", 413)); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { fail(new SearchError("search-too-large", "网页响应超过大小限制。", 413)); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status, contentType, location, body: Buffer.concat(chunks) }));
      res.on("error", reject);
      res.on("aborted", () => reject(new SearchError("search-unavailable", "网页连接中断。", 502)));
    });
    req.on("error", error => reject(signal.aborted ? abortError(signal) : error));
    req.end(options.body);
  });
}

type RequestOptions = Omit<Parameters<typeof requestPublicHttps>[1], "publicDnsFallback">;

/**
 * Fixed, trusted provider endpoints only (never a page URL from a user or
 * model): the proxy resolves the host itself, so the pinned public-address
 * check above cannot apply. Same size, type and encoding limits.
 */
export async function requestViaProxy(raw: string, proxyUrl: string, options: RequestOptions): Promise<HttpsReply> {
  const { signal, maxBytes } = options;
  if (signal.aborted) throw abortError(signal);
  const url = publicHttpsUrl(raw);
  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(url, {
      method: options.method ?? "GET", body: options.body, redirect: "manual", signal,
      dispatcher: proxyDispatcher(proxyUrl),
      headers: { "User-Agent": "Vivic-Search-PoC/0.6", "Accept-Encoding": "identity", ...options.headers },
    });
  } catch (error) {
    throw signal.aborted ? abortError(signal) : error;
  }
  const status = res.status;
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const location = res.headers.get("location") ?? undefined;
  const fail = async (error: SearchError) => { await res.body?.cancel().catch(() => {}); throw error; };
  if (status < 200 || status >= 300) {
    await res.body?.cancel().catch(() => {});
    return { status, contentType, location, body: Buffer.alloc(0) };
  }
  if (!options.acceptContentType(contentType)) return fail(new SearchError("search-unsupported-content", "网页响应不是支持的文本类型。", 415));
  const encoding = res.headers.get("content-encoding");
  if (encoding && encoding !== "identity") return fail(new SearchError("search-unsupported-content", "不接受压缩网页响应。", 415));
  const length = res.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return fail(new SearchError("search-too-large", "网页响应超过大小限制。", 413));
  if (!res.body) return { status, contentType, location, body: Buffer.alloc(0) };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new SearchError("search-too-large", "网页响应超过大小限制。", 413); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    throw signal.aborted ? abortError(signal) : error;
  }
  return { status, contentType, location, body: Buffer.concat(chunks) };
}
