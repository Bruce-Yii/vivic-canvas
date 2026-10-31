import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { createSearchClient, QuerySchema, type SearchClient, type SearchConfig } from "./client.js";
import { publicSearchError, SearchError } from "./errors.js";

export { createSearchClient, SEARCH_PROVIDER, SEARCH_TOOL_NAMES } from "./client.js";
export type { SearchClient, SearchConfig, SearchEvidence, FetchEvidence } from "./client.js";
export { SearchError } from "./errors.js";
export { STEPSEARCH_PROVIDER } from "./stepsearch.js";

const SearchBody = z.strictObject({ query: QuerySchema });
const FetchBody = z.strictObject({ url: z.string().min(1).max(2048) });

/** Mount AFTER the parent's bearer/CORS/body-limit middleware: app.route('/api', routes). */
export function createSearchRoutes(options: { client?: SearchClient; config?: Partial<SearchConfig> } = {}) {
  if (options.client && options.config) throw new TypeError("Configure the shared search client when creating it; pass only { client } to routes.");
  const client = options.client ?? createSearchClient({ config: options.config });
  const routes = new Hono();
  routes.onError((error, c) => {
    const safe = publicSearchError(error);
    return c.json({ ok: false, code: safe.code, error: safe.message }, safe.status);
  });
  // Hono flattens child middleware when mounting; '*' would also match the
  // parent's status and multipart routes after app.route('/api', routes).
  for (const path of ["/search", "/fetch"] as const) {
    routes.use(path, async (c, next) => {
      c.header("Cache-Control", "no-store");
      c.header("X-Content-Type-Options", "nosniff");
      await next();
    });
    routes.use(path, bodyLimit({
      maxSize: 4096,
      onError: c => c.json({ ok: false, code: "search-invalid-input", error: "搜索请求体过大。" }, 413),
    }));
    routes.use(path, async (c, next) => {
      if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
        return c.json({ ok: false, code: "search-invalid-input", error: "搜索请求必须使用 application/json。" }, 415);
      }
      await next();
    });
  }
  routes.post("/search", async c => {
    const raw: unknown = await c.req.json().catch(() => { throw new SearchError("search-invalid-input", "请求体不是合法 JSON。", 400); });
    const parsed = SearchBody.safeParse(raw);
    if (!parsed.success) throw new SearchError("search-invalid-input", "请求仅接受 query（1–500 字符）。", 400);
    const results = await client.webSearch(parsed.data.query, c.req.raw.signal);
    return c.json({ ok: true, results });
  });
  routes.post("/fetch", async c => {
    const raw: unknown = await c.req.json().catch(() => { throw new SearchError("search-invalid-input", "请求体不是合法 JSON。", 400); });
    const parsed = FetchBody.safeParse(raw);
    if (!parsed.success) throw new SearchError("search-invalid-input", "请求仅接受 url（公开 HTTPS 网页）。", 400);
    const result = await client.fetchContent(parsed.data.url, c.req.raw.signal);
    return c.json({ ok: true, ...result });
  });
  return routes;
}
