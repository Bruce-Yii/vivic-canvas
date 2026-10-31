import { randomBytes } from "node:crypto";
import { createOnlineMobileBridge } from "./mobileBridge.js";

export const ONLINE_COOKIE = "__Host-vivic_online";
export interface OnlineSessionApp {
  fetch(request: Request): Response | Promise<Response>;
  /** Must forget credentials and invalidate any in-flight provider work. */
  dispose(): void | Promise<void>;
}
export interface OnlineLimits {
  maxSessions: number;
  idleTtlMs: number;
  absoluteTtlMs: number;
  maxConcurrentPerSession: number;
  maxConcurrentTotal: number;
  requestsPerMinute: number;
  globalRequestsPerMinute: number;
  sessionCreationsPerMinute: number;
  requestTimeoutMs: number;
  responseLimitBytes: number;
  cleanupIntervalMs: number;
}
export interface OnlineHandlerOptions {
  origin: string;
  createSessionApp: (session: { token: string; origin: string }) => OnlineSessionApp;
  limits?: Partial<OnlineLimits>;
  now?: () => number;
}
const DEFAULTS: OnlineLimits = {
  maxSessions: 256, idleTtlMs: 30 * 60_000, absoluteTtlMs: 8 * 60 * 60_000,
  maxConcurrentPerSession: 4, maxConcurrentTotal: 64,
  requestsPerMinute: 120, globalRequestsPerMinute: 1200, sessionCreationsPerMinute: 30,
  requestTimeoutMs: 120_000, responseLimitBytes: 16 * 1024 * 1024, cleanupIntervalMs: 60_000,
};
interface Budget { started: number; count: number }
interface Session {
  id: string; token: string; app: OnlineSessionApp; created: number; touched: number;
  requests: Budget; controllers: Set<AbortController>;
}
const GET_ROUTES = new Set([
  "/api/providers/status", "/api/speech/voices", "/api/decision/status",
  "/api/connections/status",
]);
const POST_ROUTES = new Set([
  "/api/credentials/stepfun/validate", "/api/credentials/stepfun/disconnect",
  "/api/providers/select", "/api/providers/model", "/api/intent", "/api/intent/stream",
  "/api/speech", "/api/transcribe", "/api/search", "/api/weather/here", "/api/locale", "/api/travel/refresh",
  "/api/connections/configure", "/api/connections/test", "/api/connections/disconnect", "/api/connections/query",
  "/api/connections/ask",
  "/api/files/read",
]);
const json = (value: unknown, status = 200, extra?: HeadersInit) => {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(value), { status, headers });
};
const failure = (status: number, code: string, extra?: HeadersInit) => json({ ok: false, code }, status, extra);
const clearCookie = () => `${ONLINE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
const cookieId = (request: Request): string | undefined => {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim())
    .filter(value => value.startsWith(`${ONLINE_COOKIE}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0]!.slice(ONLINE_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
};
const take = (budget: Budget, limit: number, now: number) => {
  if (now - budget.started >= 60_000) { budget.started = now; budget.count = 0; }
  return ++budget.count <= limit;
};
const abortError = () => new DOMException("Online request ended", "AbortError");
const abortable = <T>(task: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const abort = () => reject(signal.reason ?? abortError());
  signal.addEventListener("abort", abort, { once: true });
  task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  if (signal.aborted) abort();
});
class BodyTooLarge extends Error {}
const readBody = async (request: Request, max: number, signal: AbortSignal) => {
  const declared = Number(request.headers.get("content-length"));
  if (declared > max) throw new BodyTooLarge();
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) throw new BodyTooLarge();
      chunks.push(part.value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
};

/** Cookie boundary around isolated existing apps. It never accepts browser bearer tokens. */
export function createOnlineHandler(options: OnlineHandlerOptions) {
  const parsedOrigin = new URL(options.origin);
  if (parsedOrigin.origin !== options.origin || parsedOrigin.username || parsedOrigin.password ||
    !(parsedOrigin.protocol === "https:" || parsedOrigin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsedOrigin.hostname))) {
    throw new Error("Online origin must be one HTTPS origin (HTTP is only allowed on loopback).");
  }
  const limits = { ...DEFAULTS, ...options.limits };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid online limit.");
  const now = options.now ?? Date.now;
  const mobile = createOnlineMobileBridge(now);
  const sessions = new Map<string, Session>();
  const disposal = new Set<Promise<void>>();
  const globalBudget: Budget = { started: now(), count: 0 };
  const createBudget: Budget = { started: now(), count: 0 };
  const mobileBudget: Budget = { started: now(), count: 0 };
  const mobilePairBudget: Budget = { started: now(), count: 0 };
  let active = 0, closed = false;
  const forget = (session: Session) => {
    if (!sessions.delete(session.id)) return Promise.resolve();
    mobile.forget(session.id);
    for (const controller of session.controllers) controller.abort(abortError());
    // Do not serialize exceptions: an upstream error may contain credentials.
    let task: Promise<void>;
    try { task = Promise.resolve(session.app.dispose()); } catch { task = Promise.resolve(); }
    const job = abortable(task, AbortSignal.timeout(Math.min(5000, limits.requestTimeoutMs))).catch(() => {}).then(() => {});
    disposal.add(job);
    void job.finally(() => disposal.delete(job));
    return job;
  };
  const sweep = () => {
    const time = now();
    for (const session of sessions.values()) if (time - session.touched >= limits.idleTtlMs || time - session.created >= limits.absoluteTtlMs) forget(session);
    mobile.sweep();
  };
  const timer = setInterval(sweep, limits.cleanupIntervalMs);
  timer.unref();
  const cookie = (session: Session) => {
    const seconds = Math.max(1, Math.floor(Math.min(limits.idleTtlMs, session.created + limits.absoluteTtlMs - now()) / 1000));
    return `${ONLINE_COOKIE}=${session.id}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict`;
  };
  const sameOrigin = (request: Request, mutation: boolean) => {
    const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
    if (origin !== null && origin !== options.origin) return false;
    if (site !== null && site !== "same-origin" && site !== "none") return false;
    return !mutation || origin === options.origin || site === "same-origin";
  };
  const fetch = async (request: Request): Promise<Response> => {
    if (closed) return failure(503, "online-shutting-down");
    sweep();
    const url = new URL(request.url), route = url.pathname, method = request.method;
    if (method === "GET" && route === "/healthz") return json({ ok: true, service: "vivic-online-api" });
    if (!route.startsWith("/api/")) return failure(404, "not-found");
    if (request.headers.has("authorization")) return failure(400, "browser-bearer-disabled");
    const mobileRoute = /^\/api\/online\/mobile\/(owner|phone)\/(connect|poll|send|disconnect)$/.exec(route);
    if (mobileRoute) {
      if (url.search) return failure(400, "mobile-query-disabled");
      const role = mobileRoute[1] as "owner" | "phone", action = mobileRoute[2]!;
      const nativePhone = role === "phone" && request.headers.get("origin") === "https://appassets.androidplatform.net";
      if (!nativePhone && !sameOrigin(request, true)) return failure(403, "same-origin-required");
      const cors = (response: Response) => {
        if (nativePhone) { response.headers.set("Access-Control-Allow-Origin", "https://appassets.androidplatform.net"); response.headers.set("Vary", "Origin"); }
        return response;
      };
      if (method === "OPTIONS" && nativePhone) return cors(new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600", "Cache-Control": "no-store",
      } }));
      if (method !== "POST") return cors(failure(405, "method-not-allowed"));
      const owner = role === "owner" ? sessions.get(cookieId(request) ?? "") : undefined;
      if (role === "owner" && !owner) return cors(failure(401, "online-session-required"));
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return cors(failure(400, "invalid-mobile-request"));
      if (!take(mobileBudget, limits.globalRequestsPerMinute * 10, now()) || role === "phone" && action === "connect" && !take(mobilePairBudget, 120, now())) return cors(failure(429, "mobile-rate-limit", { "Retry-After": "60" }));
      if (active >= limits.maxConcurrentTotal || owner && owner.controllers.size >= limits.maxConcurrentPerSession) return cors(failure(429, "request-concurrency-limit", { "Retry-After": "1" }));
      const controller = new AbortController();
      const abort = () => controller.abort(abortError()); request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      const deadline = setTimeout(abort, Math.min(limits.requestTimeoutMs, 25_000)); deadline.unref();
      active++; owner?.controllers.add(controller);
      try {
        const body = await readBody(request, 34 * 1024, controller.signal);
        controller.signal.throwIfAborted();
        const data: unknown = JSON.parse(body?.toString("utf8") ?? "null");
        sweep();
        if (owner && !sessions.has(owner.id)) return cors(failure(401, "online-session-required"));
        const bridgeOwner = mobile.ownerForConnection((data as { connectionId?: unknown } | null)?.connectionId);
        // An authenticated desktop request is owner activity. Phone traffic is
        // deliberately excluded; the immutable created time still caps all work.
        if (owner) owner.touched = now();
        const response = await mobile.handle(role, action, data, controller.signal, owner ? { id: owner.id, expiresAt: owner.created + limits.absoluteTtlMs } : undefined);
        sweep();
        if (owner && !sessions.has(owner.id)) return cors(failure(401, "online-session-required"));
        if (bridgeOwner && !sessions.has(bridgeOwner)) return cors(failure(401, "invalid-session"));
        if (owner && sessions.has(owner.id)) { owner.touched = now(); response.headers.set("Set-Cookie", cookie(owner)); }
        return cors(response);
      } catch (error) { return cors(failure(error instanceof BodyTooLarge ? 413 : 400, "invalid-mobile-request")); }
      finally { active--; owner?.controllers.delete(controller); clearTimeout(deadline); request.signal.removeEventListener("abort", abort); }
    }
    if (!sameOrigin(request, method !== "GET" && method !== "HEAD")) return failure(403, "same-origin-required");
    const session = sessions.get(cookieId(request) ?? "");
    if (route === "/api/runtime" && method === "GET") return json({ mode: "online", capabilities: {
      gptOAuth: false, localModels: false, mobilePairing: true,
    }, session: session ? "ready" : "missing" });
    if (route === "/api/online/session" && (method === "POST" || method === "DELETE")) {
      if (!take(globalBudget, limits.globalRequestsPerMinute, now())) return failure(429, "request-rate-limit", { "Retry-After": "60" });
      if (active >= limits.maxConcurrentTotal) return failure(429, "request-concurrency-limit", { "Retry-After": "1" });
      active++;
      try {
        if (method === "DELETE") {
          // This operation accepts no payload; never leave an arbitrary upload
          // unbounded just because credential deletion itself is inexpensive.
          if (request.body) {
            try {
              const body = await readBody(request, 4096, AbortSignal.any([request.signal, AbortSignal.timeout(limits.requestTimeoutMs)]));
              if (body?.length) return failure(400, "invalid-session-request");
            } catch (error) { return failure(error instanceof BodyTooLarge ? 413 : 400, "invalid-session-request"); }
          }
          if (session) await forget(session);
          return json({ ok: true, session: "missing" }, 200, { "Set-Cookie": clearCookie() });
        }
        if (!take(createBudget, limits.sessionCreationsPerMinute, now())) return failure(429, "session-rate-limit", { "Retry-After": "60" });
        if (!session && sessions.size >= limits.maxSessions) return failure(503, "session-capacity");
        try {
          const body = await readBody(request, 4096, AbortSignal.any([request.signal, AbortSignal.timeout(limits.requestTimeoutMs)]));
          if (body?.length) {
            const value: unknown = JSON.parse(body.toString("utf8"));
            if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) return failure(400, "invalid-session-request");
          }
        } catch (error) { return failure(error instanceof BodyTooLarge ? 413 : 400, "invalid-session-request"); }
        if (closed) return failure(503, "online-shutting-down");
        if (request.signal.aborted) return failure(408, "request-ended");
        sweep();
        const liveSession = session && sessions.get(session.id);
        // Capacity is checked again after the body await; no racing creations can overfill it.
        if (!liveSession && sessions.size >= limits.maxSessions) return failure(503, "session-capacity");
        let current = liveSession;
        if (!current) {
          try {
            const token = `online_${randomBytes(32).toString("base64url")}`, id = randomBytes(32).toString("base64url");
            current = { id, token, app: options.createSessionApp({ token, origin: options.origin }),
              created: now(), touched: now(), requests: { started: now(), count: 0 }, controllers: new Set() };
            sessions.set(id, current);
          } catch { return failure(503, "session-unavailable"); }
        }
        current.touched = now();
        return json({ ok: true, session: "ready" }, 200, { "Set-Cookie": cookie(current) });
      } finally { active--; }
    }
    if (!(method === "GET" && GET_ROUTES.has(route) || method === "POST" && POST_ROUTES.has(route))) return failure(404, "online-route-unavailable");
    if (!session) return failure(401, "online-session-required", { "Set-Cookie": clearCookie() });
    if (!take(globalBudget, limits.globalRequestsPerMinute, now()) || !take(session.requests, limits.requestsPerMinute, now())) return failure(429, "request-rate-limit", { "Retry-After": "60" });
    if (active >= limits.maxConcurrentTotal || session.controllers.size >= limits.maxConcurrentPerSession) return failure(429, "request-concurrency-limit", { "Retry-After": "1" });
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal.reason ?? abortError());
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timeout = setTimeout(() => controller.abort(abortError()), limits.requestTimeoutMs);
    timeout.unref();
    session.controllers.add(controller); active++; session.touched = now();
    let released = false;
    const release = () => {
      if (released) return;
      released = true; active--; session.controllers.delete(controller);
      clearTimeout(timeout); request.signal.removeEventListener("abort", abort);
    };
    try {
      const maxBody = route === "/api/transcribe" ? 5 * 1024 * 1024 + 16 * 1024 : route === "/api/files/read" ? 1024 * 1024 : route.startsWith("/api/intent") ? 6 * 1024 * 1024 : 64 * 1024;
      const body = method === "POST" ? await readBody(request, maxBody, controller.signal) : undefined;
      controller.signal.throwIfAborted();
      if (route === "/api/providers/select" || route === "/api/providers/model") {
        let provider: unknown;
        try { provider = JSON.parse(body?.toString("utf8") ?? "null")?.provider; } catch { /* existing schema handles invalid JSON */ }
        if (provider !== "stepfun") { release(); return failure(400, "online-provider-unavailable"); }
      }
      const headers = new Headers({ Authorization: `Bearer ${session.token}`, Origin: options.origin, "Sec-Fetch-Site": "same-origin" });
      for (const name of ["content-type", "accept"]) {
        const value = request.headers.get(name); if (value) headers.set(name, value);
      }
      const internal = new Request(new URL(route + url.search, options.origin), { method, headers, body, signal: controller.signal });
      const pending = Promise.resolve(session.app.fetch(internal));
      void pending.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
      const response = await abortable(pending, controller.signal);
      if (response.status >= 300 && response.status < 400 || Number(response.headers.get("content-length")) > limits.responseLimitBytes) {
        void response.body?.cancel().catch(() => {}); release(); return failure(502, "invalid-online-response");
      }
      const outHeaders = new Headers(response.headers);
      for (const name of [...outHeaders.keys()]) if (name.startsWith("access-control-") || ["set-cookie", "content-length", "connection", "transfer-encoding"].includes(name)) outHeaders.delete(name);
      outHeaders.set("Cache-Control", "no-store"); outHeaders.set("X-Content-Type-Options", "nosniff");
      outHeaders.set("Set-Cookie", cookie(session));
      if (!response.body) { release(); return new Response(null, { status: response.status, headers: outHeaders }); }
      const reader = response.body.getReader();
      let bytes = 0, ended = false;
      const finish = () => { ended = true; controller.signal.removeEventListener("abort", stop); release(); };
      let output: ReadableStreamDefaultController<Uint8Array>;
      const stop = () => {
        if (ended) return;
        finish(); void reader.cancel().catch(() => {}); output.error(abortError());
      };
      const stream = new ReadableStream<Uint8Array>({
        start(target) { output = target; controller.signal.addEventListener("abort", stop, { once: true }); if (controller.signal.aborted) stop(); },
        async pull(target) {
          if (ended) return;
          try {
            const part = await reader.read();
            if (ended) return;
            if (part.done) { finish(); target.close(); return; }
            bytes += part.value.byteLength;
            if (bytes > limits.responseLimitBytes) { controller.abort(abortError()); return; }
            target.enqueue(part.value);
          } catch { if (!ended) { finish(); target.error(abortError()); } }
        },
        cancel() { if (!ended) { finish(); controller.abort(abortError()); } return reader.cancel().catch(() => {}); },
      });
      return new Response(stream, { status: response.status, headers: outHeaders });
    } catch (error) {
      const aborted = controller.signal.aborted;
      controller.abort(abortError()); release();
      return failure(error instanceof BodyTooLarge ? 413 : aborted ? 408 : 502, error instanceof BodyTooLarge ? "request-too-large" : "online-request-failed");
    }
  };
  return { fetch, sweep, async dispose() {
    if (closed) return;
    closed = true; clearInterval(timer);
    mobile.dispose();
    for (const session of [...sessions.values()]) forget(session);
    await Promise.all([...disposal]);
  } };
}
