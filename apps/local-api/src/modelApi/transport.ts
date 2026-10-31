import { lookup, type LookupAddress } from "node:dns";
import { Agent, FormData as UndiciFormData, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import { isPublicAddress, publicHttpsUrl } from "../search/policy.js";
import { bounded, checkSignal, ModelApiError } from "./errors.js";
import { MODEL_API_LIMITS, type ModelApiClientOptions } from "./types.js";

// Validate DNS on the actual socket connection, avoiding a check-then-resolve race.
// Injected fetch implementations are a trusted testing boundary and do not use this dispatcher.
const publicDispatcher = new Agent({ connect: {
  lookup(hostname, options, callback) {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) { callback(error, "", 4); return; }
      if (!addresses.length || addresses.some(row => !isPublicAddress(row.address))) {
        callback(new Error("Model API address blocked"), "", 4); return;
      }
      if (options.all) {
        (callback as unknown as (error: NodeJS.ErrnoException | null, rows: LookupAddress[]) => void)(null, addresses);
      } else {
        const selected = addresses.find(row => row.family === options.family) ?? addresses[0];
        callback(null, selected.address, selected.family);
      }
    });
  },
} });

export function normalizeBaseUrl(options: ModelApiClientOptions): string {
  try {
    const raw = options.baseUrl;
    if (typeof raw !== "string" || raw.length > 2048 || /[\s\u0000-\u001f\u007f\\]/u.test(raw) || /%2f|%5c|%2e/i.test(raw)) throw new Error();
    const parsed = new URL(raw);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || /%2f|%5c|%2e/i.test(parsed.pathname)) throw new Error();
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
    if (options.allowLoopbackHttp && loopback && parsed.protocol === "http:") return parsed.href.replace(/\/+$/, "");
    return publicHttpsUrl(raw).href.replace(/\/+$/, "");
  } catch { throw new ModelApiError("invalid-config"); }
}

function discard(response: Response): void { void response.body?.cancel().catch(() => {}); }
function undiciBody(body: string | FormData | undefined): string | UndiciFormData | undefined {
  if (body === undefined || typeof body === "string") return body;
  // Package undici v7 brand-checks its own FormData class. Node's global FormData
  // is otherwise serialized as a non-multipart body. Keep the original File/Blob
  // bytes, MIME, filename and field order while crossing this encoder boundary.
  const form = new UndiciFormData();
  for (const [name, value] of body) {
    if (typeof value === "string") form.append(name, value);
    else form.append(name, value, value.name);
  }
  return form;
}
function retryDelay(response: Response, attempt: number): number | undefined {
  const value = response.headers.get("retry-after");
  const fallback = 500 * 2 ** attempt;
  if (value === null) return fallback;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : undefined;
  const date = seconds === undefined ? Date.parse(value) : undefined;
  const delay = seconds === undefined ? (date === undefined || !Number.isFinite(date) ? NaN : date - Date.now()) : seconds * 1000;
  // Do not retry earlier than a long Retry-After, and never permit unbounded backoff.
  if (!Number.isFinite(delay) || delay > 5_000) return undefined;
  return Math.max(fallback, delay);
}
async function pause(delay: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await bounded(new Promise<void>(resolve => { timer = setTimeout(resolve, delay); }), signal); }
  finally { clearTimeout(timer); }
}

export class ModelApiTransport {
  readonly baseUrl: string;
  private readonly options: ModelApiClientOptions;
  constructor(baseUrl: string, options: ModelApiClientOptions) { this.baseUrl = baseUrl; this.options = options; }

  async request(path: string, init: { method?: "GET" | "POST"; body?: string | FormData; accept: "json" | "wav" }, signal: AbortSignal): Promise<Response> {
    checkSignal(signal);
    let token: string | undefined;
    try { token = this.options.getToken ? await bounded(Promise.resolve().then(() => this.options.getToken!()), signal) : this.options.token; }
    catch { checkSignal(signal); throw new ModelApiError("not-configured"); }
    checkSignal(signal);
    if (typeof token !== "string" || !token || token.length > 4096 || /[^\x21-\x7e]/.test(token)) throw new ModelApiError("not-configured");
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: init.accept === "json" ? "application/json" : "audio/wav, audio/x-wav, audio/wave",
      "accept-encoding": "identity",
    };
    if (typeof init.body === "string") headers["content-type"] = "application/json";
    const requestInit: RequestInit = {
      method: init.method ?? "GET", body: init.body, headers, signal,
      redirect: "error", credentials: "omit", cache: "no-store",
    };
    const encodedBody = this.options.fetchImpl ? undefined : undiciBody(init.body);
    const url = this.baseUrl + path;
    for (let attempt = 0; ; attempt++) {
      checkSignal(signal);
      let response: Response;
      try {
        const pending = this.options.fetchImpl ? this.options.fetchImpl(url, requestInit)
          : undiciFetch(url, { ...requestInit, body: encodedBody,
            // Explicit loopback tests use the SAME encoder; production keeps its public-DNS dispatcher.
            ...(this.baseUrl.startsWith("https:") ? { dispatcher: publicDispatcher } : {}),
          } as UndiciRequestInit) as unknown as Promise<Response>;
        void pending.then(reply => { if (signal.aborted) discard(reply); }, () => {});
        response = await bounded(pending, signal);
      } catch { checkSignal(signal); throw new ModelApiError("unavailable"); }
      if (signal.aborted) { discard(response); checkSignal(signal); }
      if (response.redirected || (response.url && response.url !== url)) { discard(response); throw new ModelApiError("invalid-response"); }
      if (response.status === 429 && init.method === "POST" && attempt < MODEL_API_LIMITS.retriesOn429) {
        const delay = retryDelay(response, attempt);
        discard(response);
        if (delay === undefined) throw new ModelApiError("busy", 429);
        // Only rejected pure-inference requests are retried; same URL/token/body/model each time.
        await pause(delay, signal); continue;
      }
      if (!response.ok) {
        discard(response);
        const code = response.status === 429 ? "busy" : response.status === 401 ? "unauthorized"
          : response.status === 403 ? "forbidden" : response.status === 413 ? "too-large"
            : response.status === 400 || response.status === 422 ? "invalid-input" : "unavailable";
        throw new ModelApiError(code, response.status);
      }
      return response;
    }
  }
}

export async function readBytes(response: Response, maxBytes: number, expected: "json" | "wav", signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (expected === "json" ? mime !== "application/json" : !["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"].includes(mime ?? "")) {
    discard(response); throw new ModelApiError("invalid-response");
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    discard(response); throw new ModelApiError("too-large");
  }
  if (!response.body) throw new ModelApiError("invalid-response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await bounded(reader.read(), signal);
      checkSignal(signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new ModelApiError("too-large");
      chunks.push(chunk.value);
    }
  } catch (error) { checkSignal(signal); throw error instanceof ModelApiError ? error : new ModelApiError("invalid-response"); }
  finally { void reader.cancel().catch(() => {}); }
  if (!size || (length !== null && Number(length) !== size)) throw new ModelApiError("invalid-response");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const bytes = await readBytes(response, MODEL_API_LIMITS.jsonResponseBytes, "json", signal);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ModelApiError("invalid-response"); }
}
