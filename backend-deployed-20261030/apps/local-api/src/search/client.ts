import { z } from "zod";
import { SearchError, publicSearchError } from "./errors.js";
import { publicHttpsUrl } from "./policy.js";
import { abortError, requestPublicHttps } from "./transport.js";
import { callExaMcp, parseMcpResults } from "./upstream/exa.js";
import type { CredentialStore } from "../credentials.js";
import { callStepSearch, STEPSEARCH_PROVIDER, untilAborted } from "./stepsearch.js";
import { extractArticle } from "./article.js";

export const SEARCH_TOOL_NAMES = Object.freeze(["web_search", "fetch_content"] as const);
export const SEARCH_PROVIDER = "pi-web-access/exa-mcp-keyless";

export interface SearchEvidence {
  title: string;
  url: string;
  snippet: string;
  fetchedAt: string;
  provider: typeof SEARCH_PROVIDER | typeof STEPSEARCH_PROVIDER | "pi-web-access/gpt-oauth";
  readFullPage: false;
}

export interface SearchConfig {
  timeoutMs: number;
  fetchTimeoutMs: number;
  maxResults: number;
  maxResponseBytes: number;
  maxTextChars: number;
  maxConcurrent: number;
  requestsPerMinute: number;
  publicDnsFallback: boolean;
  /** Optional lower cap on every provider's own deadline. */
  attemptTimeoutMs?: number;
}

const ConfigSchema = z.strictObject({
  publicDnsFallback: z.boolean().default(false),
  // Whole fallback chain; each provider additionally has its own cap below.
  timeoutMs: z.number().int().min(1).max(60_000).default(50_000),
  attemptTimeoutMs: z.number().int().min(1).max(30_000).optional(),
  fetchTimeoutMs: z.number().int().min(1).max(30_000).default(12_000),
  maxResults: z.number().int().min(1).max(10).default(5),
  maxResponseBytes: z.number().int().min(1).max(512 * 1024).default(256 * 1024),
  maxTextChars: z.number().int().min(1).max(30_000).default(20_000),
  maxConcurrent: z.number().int().min(1).max(4).default(2),
  requestsPerMinute: z.number().int().min(1).max(30).default(10),
});

export const QuerySchema = z.string().trim().min(1).max(500)
  .refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const JsonResultsSchema = z.object({ results: z.array(z.object({
  title: z.string().optional(), url: z.string(), text: z.string().optional(),
  highlights: z.array(z.string()).optional(),
})).max(100) });

const clean = (text: string, length: number) => text.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/g, " ").trim().slice(0, length);

/** Normalization only; these are provider excerpts, never an assertion that pages were read. */
export function normalizeSearchResults(text: string, maxResults: number, fetchedAt: string): SearchEvidence[] {
  let json: unknown;
  try { json = JSON.parse(text); } catch { /* Upstream basic tool normally returns text blocks. */ }
  const structured = JsonResultsSchema.safeParse(json);
  const rows = structured.success
    ? structured.data.results.map(row => ({ ...row, content: row.highlights?.join(" ") || row.text || "" }))
    : parseMcpResults(text);
  if (!rows || (json !== undefined && !structured.success)) {
    throw new SearchError("search-invalid-response", "搜索源未返回有效的来源列表。", 502);
  }
  const seen = new Set<string>();
  const results: SearchEvidence[] = [];
  for (const row of rows) {
    let url: URL;
    try { url = publicHttpsUrl(row.url); } catch { continue; }
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    results.push({
      title: clean(row.title || url.hostname, 300), url: url.href,
      snippet: clean(row.content, 700), fetchedAt,
      provider: SEARCH_PROVIDER, readFullPage: false,
    });
    if (results.length >= maxResults) break;
  }
  if (rows.length && !results.length) throw new SearchError("search-invalid-response", "搜索源未返回可引用的公开 HTTPS 来源。", 502);
  return results;
}

export interface FetchEvidence {
  url: string;
  text: string;
  contentType: string;
  format: "raw-text" | "extracted-text";
  title?: string;
  fetchedAt: string;
  provider: "vivic-bounded-https";
  readFullPage: boolean;
  truncated: boolean;
  trust: "untrusted-web-data";
}

/** A slow or stalled provider must still leave time for the next one. */
const ATTEMPT_TIMEOUT_MS = { gpt: 30_000, stepsearch: 20_000, exa: 25_000 } as const;
const PROVIDER_LABEL = { gpt: "GPT 搜索", stepsearch: "StepSearch", exa: "公共搜索" } as const;
const EVIDENCE_PROVIDER = { gpt: "pi-web-access/gpt-oauth", stepsearch: STEPSEARCH_PROVIDER, exa: SEARCH_PROVIDER } as const;

/** Which route a user expects, versus the one that actually answered, in plain words. */
export function searchFallbackNote(expected: keyof typeof PROVIDER_LABEL, results: SearchEvidence[]): string | undefined {
  const actual = (Object.keys(EVIDENCE_PROVIDER) as (keyof typeof EVIDENCE_PROVIDER)[])
    .find(id => EVIDENCE_PROVIDER[id] === results[0]?.provider);
  return actual && actual !== expected ? `${PROVIDER_LABEL[expected]}不可用，已改用${PROVIDER_LABEL[actual]}` : undefined;
}

export interface GptSearchSource {
  /** Only a verified, connected GPT login is tried. */
  connected: () => boolean;
  /** GPT is the user's selected model, so its search goes first. */
  preferred: () => boolean;
  search: (query: string, signal: AbortSignal) => Promise<SearchEvidence[]>;
}

/** Only backend in-memory credentials; no Pi tools, host configuration or extensions. */
export function createSearchClient(options: {
  config?: Partial<SearchConfig>; credentials?: CredentialStore; fetchImpl?: typeof fetch;
  gpt?: GptSearchSource;
  /** Proxy for the fixed keyless endpoint only; page fetches never use it. */
  searchProxy?: () => string | undefined;
  captureSession?: () => () => boolean;
} = {}) {
  const config = ConfigSchema.parse(options.config ?? {});
  let active = 0;
  let windowStarted = Date.now();
  let requests = 0;
  async function run<T>(timeout: number, parent: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (Date.now() - windowStarted >= 60_000) { windowStarted = Date.now(); requests = 0; }
    if (active >= config.maxConcurrent) throw new SearchError("search-busy", "联网查询繁忙，请稍后重试。", 429);
    if (requests >= config.requestsPerMinute) throw new SearchError("search-rate-limited", "联网查询过于频繁，请稍后重试。", 429);
    const deadline = AbortSignal.timeout(timeout);
    const signal = parent ? AbortSignal.any([deadline, parent]) : deadline;
    active++; requests++;
    try {
      if (signal.aborted) throw abortError(signal);
      const result = await untilAborted(work(signal), signal);
      if (signal.aborted) throw abortError(signal);
      return result;
    } catch (error) {
      throw signal.aborted ? abortError(signal) : publicSearchError(error);
    } finally { active--; }
  }
  return Object.freeze({
    async webSearch(query: string, parent?: AbortSignal): Promise<SearchEvidence[]> {
      const parsed = QuerySchema.safeParse(query);
      if (!parsed.success) throw new SearchError("search-invalid-input", "搜索词须为 1–500 字符的文本。", 400);
      const sessionCurrent = options.captureSession?.();
      const credential = options.credentials?.getSecret();
      const assertCurrent = () => {
        if ((sessionCurrent && !sessionCurrent()) || options.credentials?.getSecret() !== credential) {
          throw new SearchError("search-cancelled", "联网查询已取消：模型连接已变更。", 503);
        }
      };
      // Every available route is tried in order: the selected model's search,
      // the other connected one, then the keyless public endpoint that needs
      // no account at all. One working route is enough.
      type Attempt = { id: keyof typeof ATTEMPT_TIMEOUT_MS; search: (signal: AbortSignal) => Promise<SearchEvidence[]> };
      const gpt: Attempt | undefined = options.gpt?.connected()
        ? { id: "gpt", search: signal => options.gpt!.search(parsed.data, signal) } : undefined;
      const stepsearch: Attempt | undefined = credential ? { id: "stepsearch", search: signal => callStepSearch({
        apiKey: credential.apiKey, query: parsed.data, maxResults: config.maxResults, maxBytes: config.maxResponseBytes,
        signal, fetchImpl: options.fetchImpl, assertCurrent }) } : undefined;
      const exa: Attempt = { id: "exa", search: async signal => normalizeSearchResults(
        await callExaMcp(parsed.data, config.maxResults, signal, config.maxResponseBytes, config.publicDnsFallback, options.searchProxy?.()),
        config.maxResults, new Date().toISOString()) };
      const chain = [...(options.gpt?.preferred() ? [gpt, stepsearch] : [stepsearch, gpt]), exa]
        .filter((attempt): attempt is Attempt => Boolean(attempt));
      try {
        return await run(config.timeoutMs, parent, async signal => {
          const failures: { id: Attempt["id"]; error: SearchError }[] = [];
          let empty = false;
          for (const attempt of chain) {
            assertCurrent();
            const own = AbortSignal.any([signal, AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS[attempt.id], config.attemptTimeoutMs ?? Infinity))]);
            try {
              const results = await untilAborted(attempt.search(own), own);
              if (results.length) return results;
              empty = true;
            } catch (error) {
              // The caller's deadline/cancellation and a changed connection end the chain.
              if (signal.aborted) throw abortError(signal);
              const safe = own.aborted ? abortError(own) : publicSearchError(error);
              if (safe.code === "search-cancelled") throw safe;
              failures.push({ id: attempt.id, error: safe });
            }
          }
          if (empty || !failures.length) return [];
          const [first] = failures;
          if (failures.length === 1) throw first!.error;
          const tried = failures.map(failure => PROVIDER_LABEL[failure.id]).join("、");
          throw new SearchError(first!.error.code, `已依次尝试${tried}，均不可用。${first!.error.message}`.slice(0, 300), first!.error.status);
        });
      } finally { assertCurrent(); }
    },
    async fetchContent(raw: string, parent?: AbortSignal, article = false): Promise<FetchEvidence> {
      const first = publicHttpsUrl(raw);
      return run(config.fetchTimeoutMs, parent, async signal => {
        let current = first;
        for (let hop = 0; hop <= 3; hop++) {
          const reply = await requestPublicHttps(current.href, {
            publicDnsFallback: config.publicDnsFallback,
            signal, maxBytes: config.maxResponseBytes,
            headers: { Accept: "text/plain, text/markdown, text/html, application/xhtml+xml" },
            acceptContentType: type => ["text/plain", "text/markdown", "text/html", "application/xhtml+xml"].includes(type),
          });
          if ([301, 302, 303, 307, 308].includes(reply.status)) {
            if (!reply.location || hop === 3) throw new SearchError("search-unavailable", "网页重定向无效或次数过多。", 502);
            try { current = publicHttpsUrl(new URL(reply.location, current).href); }
            catch { throw new SearchError("search-blocked-url", "网页重定向至不允许的地址。", 400); }
            continue;
          }
          if (reply.status < 200 || reply.status >= 300) throw new SearchError("search-unavailable", "当前网页不可读取。", 502);
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(reply.body);
          const extracted = article ? extractArticle(decoded, current.href, reply.contentType) : null;
          const text = extracted?.text ?? decoded;
          return {
            url: current.href, text: text.slice(0, config.maxTextChars),
            contentType: reply.contentType, format: article ? "extracted-text" : "raw-text", ...(extracted ? { title: extracted.title } : {}), fetchedAt: new Date().toISOString(),
            provider: "vivic-bounded-https", readFullPage: article && text.length <= config.maxTextChars,
            truncated: text.length > config.maxTextChars, trust: "untrusted-web-data",
          };
        }
        throw new SearchError("search-unavailable", "当前网页不可读取。", 502);
      });
    },
  });
}

export type SearchClient = ReturnType<typeof createSearchClient>;
