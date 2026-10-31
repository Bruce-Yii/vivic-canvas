import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createHostedService } from "../hosted/service.js";
import { publicRequest } from "./publicRequest.js";

// Online deployment deliberately does not import the local entry point,
// loadConfig(), preferences, OS proxy setup, or any server-wide API key.
const origin = process.env.VIVIC_ONLINE_ORIGIN?.trim();
if (!origin) throw new Error("Set VIVIC_ONLINE_ORIGIN to the public HTTPS origin.");
const port = Number(process.env.PORT ?? 8790);
const host = process.env.VIVIC_ONLINE_BIND_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid online PORT.");
const dataDir = process.env.VIVIC_SPACE_DATA_DIR?.trim();
if (!dataDir || !path.isAbsolute(dataDir)) throw new Error("Set VIVIC_SPACE_DATA_DIR to an absolute persistent data directory.");
const handler = createHostedService({ origin, dataDir, inviteCode: process.env.VIVIC_SPACE_INVITE,
  modelApiBaseUrl: process.env.VIVIC_MODEL_API_BASE_URL,
  modelApiToken: process.env.VIVIC_MODEL_API_TOKEN });
const app = new Hono();
app.all("/api/*", c => {
  let request: Request;
  try { request = publicRequest(c.req.raw, origin); }
  catch { return c.json({ code: "invalid-host", message: "请求的服务地址无效。" }, 400); }
  return handler.fetch(request);
});
app.get("/healthz", c => handler.fetch(c.req.raw));

// Use a dedicated origin, rooted at /. Production TLS terminates at the
// reverse proxy; that proxy must forward only to this loopback listener.
const dist = path.resolve(process.env.VIVIC_ONLINE_WEB_DIST?.trim() || path.resolve(import.meta.dirname, "../../../web/dist-online"));
const apiOnly = process.env.VIVIC_SPACE_API_ONLY === "1";
let onlineBuild = false;
try {
  const marker = JSON.parse(fs.readFileSync(path.join(dist, ".vivic-online-build.json"), "utf8")) as { mode?: unknown };
  onlineBuild = marker.mode === "online" && fs.existsSync(path.join(dist, "index.html"));
} catch { /* A local build or missing artifact must fail before listening. */ }
if (!apiOnly && !onlineBuild) {
  void handler.dispose();
  throw new Error("Missing online web build. Build dist-online with its .vivic-online-build.json marker first.");
}
if (!apiOnly) {
  app.use("/*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https:; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:; frame-src 'none'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'");
    c.header("Permissions-Policy", "microphone=(self), camera=(), geolocation=(self)");
    c.header("Cache-Control", /\/assets\/[^/]+\.[a-z0-9]+$/.test(c.req.path) ? "public, max-age=31536000, immutable" : "no-cache");
    await next();
  });
  app.use("/*", serveStatic({ root: dist }));
  for (const route of ["/", "/control", "/display", "/remote", "/remote/", "/remote/index.html"]) app.get(route, serveStatic({ path: path.join(dist, "index.html") }));
}
const server = serve({ fetch: app.fetch, hostname: host, port }, info => {
  console.log(`[vivic-online-api] loopback port ${info.port}; public origin ${origin}`);
});
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(0), 5000);
  deadline.unref();
  void handler.dispose().finally(() => server.close(() => process.exit(0)));
});
