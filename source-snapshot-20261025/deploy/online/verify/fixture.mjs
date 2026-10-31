import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// Verification entry only; never copied into the production application tree.
// It uses the real cookie boundary and real app factory, with a deterministic
// upstream. No live keys, external network, user content or persistent state.
const apiRoot = process.env.VIVIC_CHECK_APP_ROOT || path.resolve(import.meta.dirname, "../../../apps/local-api");
const require = createRequire(path.join(apiRoot, "package.json"));
const { serve } = await import(pathToFileURL(require.resolve("@hono/node-server")));
const { createOnlineHandler } = await import(pathToFileURL(path.join(apiRoot, "src/online/sessions.ts")));
const { createOnlineSessionApp } = await import(pathToFileURL(path.join(apiRoot, "src/online/appFactory.ts")));
const origin = process.env.VIVIC_ONLINE_ORIGIN || "http://localhost:18802";
let now = Date.now();
const handler = createOnlineHandler({ origin, now: () => now, createSessionApp: session => createOnlineSessionApp(session, { fetchImpl: async (input, init) => {
  const url = String(input), authorization = new Headers(init?.headers).get("authorization");
  if (!/^Bearer TEST-online-probe-session-[AB]$/.test(authorization ?? "")) return new Response(null, { status: 401 });
  if (url === "https://api.stepfun.com/v1/models") return Response.json({ data: [{ id: "step-3.5-flash" }] });
  if (url.endsWith("/chat/completions")) {
    if (String(init?.body).includes("ONLINE_PROXY_STREAM_PROBE")) await new Promise(resolve => setTimeout(resolve, 900));
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  }
  throw new Error("Fixture external networking is disabled");
} }) });
const server = serve({ hostname: process.env.VIVIC_CHECK_BIND_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1", port: Number(process.env.PORT || 18802), fetch: async request => {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/__verification/identity") return Response.json({ fixture: "vivic-real-online-app-test-upstream" });
  if (pathname === "/__verification/advance" && request.method === "POST" && request.headers.get("origin") === origin) { now += 31 * 60_000; handler.sweep(); return Response.json({ ok: true }); }
  return handler.fetch(request);
} }, () => console.info("Vivic isolated verification fixture ready (upstream mocked)"));
let stopped = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { if (stopped) return; stopped = true; void handler.dispose().finally(() => server.close()); });
