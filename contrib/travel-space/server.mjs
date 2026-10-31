import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon" };

/** Static DEMO server. This release deliberately has no key reader or upstream transport. */
export function createTravelServer({ origin = "http://127.0.0.1:5196", root = path.join(here, "dist"), sessionLimit = 2000, requestLimit = 20, now = Date.now } = {}) {
  const allowedOrigin = new URL(origin).origin;
  const secure = allowedOrigin.startsWith("https:");
  const sessions = new Map(), buckets = new Map();
  const lifetime = 60 * 60 * 1000;
  const withinLimit = key => {
    const stamp = now();
    for (const [id, bucket] of buckets) if (stamp - bucket.start >= 60000) buckets.delete(id);
    const old = buckets.get(key);
    if (!old) { if (buckets.size >= sessionLimit) return false; buckets.set(key, { start: stamp, count: 1 }); return true; }
    return ++old.count <= requestLimit;
  };
  return http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url ?? "/", allowedOrigin).pathname); } catch { json(400, { error: "invalid_path" }); return; }
    if (pathname.startsWith("/api/")) {
      if (req.method === "GET" && pathname === "/api/travel/capabilities") { json(200, { mode: "demo", liveEnabled: false, provider: "vivic-demo", storage: "browser-only", booking: false }); return; }
      // Fixed external origin, never trust Host or forwarded headers as authorization.
      if (req.method !== "POST") { json(405, { error: "method_not_allowed" }); return; }
      if (req.headers.origin !== allowedOrigin || req.headers["sec-fetch-site"] === "cross-site") { json(403, { error: "origin_denied" }); return; }
      if (!withinLimit(req.socket.remoteAddress ?? "unknown")) { res.setHeader("Retry-After", "60"); json(429, { error: "rate_limit" }); return; }
      if (Number(req.headers["content-length"] ?? 0) > 4096) { json(413, { error: "payload_too_large" }); return; }
      // No request body is needed or accepted until an audited live adapter exists.
      if (req.headers["transfer-encoding"] || Number(req.headers["content-length"] ?? 0) > 0) { json(400, { error: "body_not_supported_in_demo" }); return; }
      if (pathname === "/api/travel/session") {
        const stamp = now();
        for (const [id, session] of sessions) if (session.expiresAt <= stamp) sessions.delete(id);
        if (sessions.size >= sessionLimit) { json(503, { error: "session_limit" }); return; }
        const id = randomBytes(32).toString("base64url");
        sessions.set(id, { expiresAt: stamp + lifetime, remainingCalls: 0 });
        res.setHeader("Set-Cookie", `travel_visitor=${id}; HttpOnly; SameSite=Strict; Path=/api/travel; Max-Age=3600${secure ? "; Secure" : ""}`);
        json(200, { mode: "demo", liveEnabled: false }); return;
      }
      if (pathname === "/api/travel/query") {
        const id = req.headers.cookie?.match(/(?:^|;\s*)travel_visitor=([\w-]{43})(?:;|$)/)?.[1];
        const session = id ? sessions.get(id) : null;
        if (!session || session.expiresAt <= now()) { json(401, { error: "visitor_session_required" }); return; }
        // Zero paid-call budget is intentional. Setting an API key cannot enable live mode.
        json(503, { error: "live_not_configured", mode: "demo", liveEnabled: false }); return;
      }
      json(404, { error: "not_found" }); return;
    }
    if (!["GET", "HEAD"].includes(req.method ?? "")) { json(405, { error: "method_not_allowed" }); return; }
    if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some(segment => segment.startsWith("."))) { json(404, { error: "not_found" }); return; }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(root, relative);
    if (!target.startsWith(path.resolve(root) + path.sep)) { json(404, { error: "not_found" }); return; }
    try {
      const body = await readFile(target);
      res.writeHead(200, { "Content-Type": MIME[path.extname(target)] ?? "application/octet-stream", "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch { json(404, { error: "not_found" }); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.TRAVEL_PORT ?? 5196);
  const host = process.env.TRAVEL_HOST ?? "127.0.0.1";
  const origin = process.env.TRAVEL_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("TRAVEL_PORT must be a valid port");
  if (host !== "127.0.0.1" && !process.env.TRAVEL_PUBLIC_ORIGIN) throw new Error("Set TRAVEL_PUBLIC_ORIGIN before external binding");
  const server = createTravelServer({ origin });
  server.headersTimeout = 10000; server.requestTimeout = 15000; server.keepAliveTimeout = 5000;
  server.listen(port, host, () => process.stdout.write(`Travel Vivic Space DEMO listening on ${host}:${port}\n`));
}
