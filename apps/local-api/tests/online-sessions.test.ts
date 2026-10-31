import { afterEach, describe, expect, it, vi } from "vitest";
import { createOnlineHandler, ONLINE_COOKIE, type OnlineHandlerOptions, type OnlineSessionApp } from "../src/online/sessions.js";
import { createOnlineSessionApp } from "../src/online/appFactory.js";

const ORIGIN = "https://vivic.example";
const running: ReturnType<typeof createOnlineHandler>[] = [];
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const request = (route: string, method = "GET", cookie?: string, body?: unknown, extra?: HeadersInit) => {
  const headers = new Headers({ Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", ...extra });
  if (cookie) headers.set("Cookie", cookie);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(ORIGIN + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
};
const setup = (options: Partial<OnlineHandlerOptions> = {}) => {
  const apps: { token: string; dispose: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn> }[] = [];
  const handler = createOnlineHandler({ origin: ORIGIN, createSessionApp: ({ token }) => {
    const app = { token, dispose: vi.fn(), fetch: vi.fn(async (input: Request) => response({
      authorization: input.headers.get("authorization"), cookie: input.headers.get("cookie"),
    })) };
    apps.push(app); return app;
  }, ...options });
  running.push(handler);
  return { handler, apps };
};
const begin = async (handler: ReturnType<typeof createOnlineHandler>, cookie?: string) => {
  const res = await handler.fetch(request("/api/online/session", "POST", cookie, {}));
  expect(res.status).toBe(200);
  const header = res.headers.get("set-cookie")!;
  await res.json();
  return { cookie: header.split(";")[0]!, header };
};
const read = async (handler: ReturnType<typeof createOnlineHandler>, cookie: string, route = "/api/providers/status") => {
  const res = await handler.fetch(request(route, "GET", cookie));
  return { status: res.status, body: await res.json() };
};
afterEach(async () => { await Promise.all(running.splice(0).map(handler => handler.dispose())); });

describe("online cookie sessions", () => {
  it("advertises online capabilities without allocating an app or exposing credentials", async () => {
    const { handler, apps } = setup();
    const res = await handler.fetch(request("/api/runtime"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ mode: "online", capabilities: { gptOAuth: false, localModels: false, mobilePairing: true }, session: "missing" });
    expect(await (await handler.fetch(request("/healthz"))).json()).toEqual({ ok: true, service: "vivic-online-api" });
    expect(apps).toHaveLength(0);
  });
  it("uses host-only secure HttpOnly Strict cookies and reuses a valid session", async () => {
    const { handler, apps } = setup();
    const first = await begin(handler);
    expect(first.header).toMatch(new RegExp(`^${ONLINE_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Max-Age=1800; HttpOnly; Secure; SameSite=Strict$`));
    expect(first.header).not.toContain("Domain=");
    expect((await begin(handler, first.cookie)).cookie).toBe(first.cookie);
    expect(apps).toHaveLength(1);
    const state = await handler.fetch(request("/api/runtime", "GET", first.cookie));
    expect(await state.json()).toMatchObject({ session: "ready" });
  });
  it("isolates two apps and injects different server-only bearer values", async () => {
    const { handler, apps } = setup();
    const a = await begin(handler), b = await begin(handler);
    expect(a.cookie).not.toBe(b.cookie);
    const first = await read(handler, a.cookie), second = await read(handler, b.cookie);
    expect(first.body).toEqual({ authorization: `Bearer ${apps[0]!.token}`, cookie: null });
    expect(second.body).toEqual({ authorization: `Bearer ${apps[1]!.token}`, cookie: null });
    expect(apps[0]!.token).not.toBe(apps[1]!.token);
    expect(a.header).not.toContain(apps[0]!.token);
  });
  it("rejects missing, forged, and duplicate cookies even with a correct internal bearer", async () => {
    const { handler, apps } = setup();
    const a = await begin(handler);
    expect((await read(handler, "")).status).toBe(401);
    expect((await read(handler, `${ONLINE_COOKIE}=${"a".repeat(43)}`)).status).toBe(401);
    expect((await read(handler, `${a.cookie}; ${a.cookie}`)).status).toBe(401);
    const res = await handler.fetch(request("/api/providers/status", "GET", a.cookie, undefined, { Authorization: `Bearer ${apps[0]!.token}` }));
    expect(res.status).toBe(400);
    expect(apps[0]!.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    { Origin: "https://other.vivic.example", "Sec-Fetch-Site": "same-site" },
    { Origin: "null", "Sec-Fetch-Site": "none" },
  ])("blocks cross-origin and sibling-origin CSRF %o", async headers => {
    const { handler, apps } = setup();
    const res = await handler.fetch(request("/api/online/session", "POST", undefined, {}, headers));
    expect(res.status).toBe(403); expect(apps).toHaveLength(0);
  });
  it("requires Origin or same-origin Fetch Metadata for mutations", async () => {
    const { handler } = setup();
    const missing = new Request(ORIGIN + "/api/online/session", { method: "POST" });
    expect((await handler.fetch(missing)).status).toBe(403);
    const metadata = new Request(ORIGIN + "/api/online/session", { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } });
    expect((await handler.fetch(metadata)).status).toBe(200);
  });
  it("allows no local, GPT, OAuth, worker, model-prepare, or mobile routes", async () => {
    const { handler, apps } = setup();
    const a = await begin(handler);
    for (const route of ["/api/gpt/connect", "/api/gpt/login/start", "/api/decision/prepare", "/api/decision/enable", "/api/decision/clear", "/api/mobile/session", "/api/worker/start"]) {
      expect((await handler.fetch(request(route, "POST", a.cookie, {}))).status).toBe(404);
    }
    expect((await handler.fetch(request("/api/decision/models", "GET", a.cookie))).status).toBe(404);
    for (const route of ["/api/providers/select", "/api/providers/model"]) {
      expect((await handler.fetch(request(route, "POST", a.cookie, { provider: "gpt", model: "x" }))).status).toBe(400);
    }
    expect(apps[0]!.fetch).not.toHaveBeenCalled();
  });
  it("clears, disposes and expires the deleted session while leaving another session intact", async () => {
    const { handler, apps } = setup();
    const a = await begin(handler), b = await begin(handler);
    const res = await handler.fetch(request("/api/online/session", "DELETE", a.cookie));
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(apps[0]!.dispose).toHaveBeenCalledOnce(); expect(apps[1]!.dispose).not.toHaveBeenCalled();
    expect((await read(handler, a.cookie)).status).toBe(401);
    expect((await read(handler, b.cookie)).status).toBe(200);
  });
  it("expires idle sessions and enforces an absolute lifetime despite activity", async () => {
    let time = 0;
    const { handler, apps } = setup({ now: () => time, limits: { idleTtlMs: 100, absoluteTtlMs: 250 } });
    const a = await begin(handler);
    time = 90; expect((await read(handler, a.cookie)).status).toBe(200);
    time = 180; expect((await read(handler, a.cookie)).status).toBe(200);
    time = 250; expect((await read(handler, a.cookie)).status).toBe(401);
    await Promise.resolve(); expect(apps[0]!.dispose).toHaveBeenCalledOnce();
    const b = await begin(handler); time = 350;
    expect((await read(handler, b.cookie)).status).toBe(401);
  });
  it("bounds capacity and creation rate, without evicting another user's live session", async () => {
    const { handler, apps } = setup({ limits: { maxSessions: 1 } });
    const a = await begin(handler);
    expect((await handler.fetch(request("/api/online/session", "POST", undefined, {}))).status).toBe(503);
    expect((await begin(handler, a.cookie)).cookie).toBe(a.cookie); expect(apps).toHaveLength(1);
    const limited = setup({ limits: { sessionCreationsPerMinute: 1 } });
    await begin(limited.handler);
    expect((await limited.handler.fetch(request("/api/online/session", "POST", undefined, {}))).status).toBe(429);
  });
  it("bounds per-session API rate independently", async () => {
    const { handler } = setup({ limits: { requestsPerMinute: 1 } });
    const a = await begin(handler), b = await begin(handler);
    expect((await read(handler, a.cookie)).status).toBe(200);
    expect((await read(handler, a.cookie)).status).toBe(429);
    expect((await read(handler, b.cookie)).status).toBe(200);
  });
  it("bounds total concurrency and request rate across distinct cookies", async () => {
    const { handler } = setup({ limits: { maxConcurrentTotal: 1 }, createSessionApp: () => ({ dispose() {}, fetch: () => new Response(new ReadableStream()) }) });
    const a = await begin(handler), b = await begin(handler);
    const first = await handler.fetch(request("/api/providers/status", "GET", a.cookie));
    expect((await handler.fetch(request("/api/providers/status", "GET", b.cookie))).status).toBe(429);
    await first.body!.cancel();
    const second = await handler.fetch(request("/api/providers/status", "GET", b.cookie));
    expect(second.status).toBe(200); await second.body!.cancel();
    const limited = setup({ limits: { globalRequestsPerMinute: 3 } });
    const c = await begin(limited.handler), d = await begin(limited.handler);
    expect((await read(limited.handler, c.cookie)).status).toBe(200);
    expect((await read(limited.handler, d.cookie)).status).toBe(429);
  });
  it("caps bodies without trusting Content-Length and does not dispatch oversized requests", async () => {
    const { handler, apps } = setup(); const a = await begin(handler);
    const res = await handler.fetch(request("/api/credentials/stepfun/validate", "POST", a.cookie, { apiKey: "x".repeat(65536) }));
    expect(res.status).toBe(413); expect(apps[0]!.fetch).not.toHaveBeenCalled();
    for (const body of [null, [], 3, "", { token: "client-chosen" }]) {
      expect((await handler.fetch(request("/api/online/session", "POST", undefined, body))).status).toBe(400);
    }
  });
  it("holds concurrency until stream consumption and frees it on cancel while aborting upstream", async () => {
    const signals: AbortSignal[] = [], cancelled = vi.fn();
    const { handler } = setup({ limits: { maxConcurrentPerSession: 1 }, createSessionApp: () => ({ dispose() {}, fetch(input) {
      signals.push(input.signal);
      return new Response(new ReadableStream({ start(target) { target.enqueue(new TextEncoder().encode("hello")); }, cancel: cancelled }));
    } }) });
    const a = await begin(handler);
    const first = await handler.fetch(request("/api/intent/stream", "POST", a.cookie, {}));
    expect((await handler.fetch(request("/api/providers/status", "GET", a.cookie))).status).toBe(429);
    await first.body!.cancel();
    expect(signals[0]!.aborted).toBe(true); expect(cancelled).toHaveBeenCalledOnce();
    const second = await handler.fetch(request("/api/providers/status", "GET", a.cookie));
    expect(second.status).toBe(200); await second.body!.cancel();
  });
  it("aborts pending work on session deletion and never returns its late response", async () => {
    let signal: AbortSignal | undefined;
    const { handler } = setup({ createSessionApp: () => ({ dispose() {}, fetch(input) {
      signal = input.signal; return new Promise<Response>(() => {});
    } }) });
    const a = await begin(handler);
    const pending = handler.fetch(request("/api/providers/status", "GET", a.cookie));
    await Promise.resolve();
    await handler.fetch(request("/api/online/session", "DELETE", a.cookie));
    expect((await pending).status).toBe(408); expect(signal!.aborted).toBe(true);
  });
  it("cancels opened streams on idle expiry and browser disconnection", async () => {
    let time = 0;
    const cancelled = vi.fn();
    const { handler } = setup({ now: () => time, limits: { idleTtlMs: 100 }, createSessionApp: () => ({ dispose() {}, fetch: () => new Response(new ReadableStream({ cancel: cancelled })) }) });
    const a = await begin(handler);
    const first = await handler.fetch(request("/api/providers/status", "GET", a.cookie));
    const pending = first.body!.getReader().read();
    time = 100; handler.sweep();
    await expect(pending).rejects.toThrow(); expect(cancelled).toHaveBeenCalledOnce();
    const b = await begin(handler);
    const browser = new AbortController();
    const req = new Request(request("/api/providers/status", "GET", b.cookie), { signal: browser.signal });
    const second = await handler.fetch(req), reading = second.body!.getReader().read();
    browser.abort(); await expect(reading).rejects.toThrow(); expect(cancelled).toHaveBeenCalledTimes(2);
  });
  it("times out ignored upstream requests and bounds response streams", async () => {
    const stuck = setup({ limits: { requestTimeoutMs: 10 }, createSessionApp: () => ({ dispose() {}, fetch: () => new Promise<Response>(() => {}) }) });
    const a = await begin(stuck.handler);
    expect((await stuck.handler.fetch(request("/api/providers/status", "GET", a.cookie))).status).toBe(408);
    const oversized = setup({ limits: { responseLimitBytes: 8 }, createSessionApp: () => ({ dispose() {}, fetch: () => new Response("123456789") }) });
    const b = await begin(oversized.handler);
    const res = await oversized.handler.fetch(request("/api/providers/status", "GET", b.cookie));
    await expect(res.text()).rejects.toThrow();
  });
  it("strips inner cookies, CORS and cache headers and never reveals thrown exception text", async () => {
    const { handler } = setup({ createSessionApp: () => ({ dispose() {}, fetch: () => new Response("ok", { headers: {
      "Set-Cookie": "shared=unsafe", "Access-Control-Allow-Origin": "*", "Cache-Control": "public",
    } }) }) });
    const a = await begin(handler);
    const res = await handler.fetch(request("/api/providers/status", "GET", a.cookie));
    expect(res.headers.get("set-cookie")).toBe(a.header);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store"); await res.text();
    const failing = setup({ createSessionApp: () => ({ dispose() {}, fetch() { throw new Error("SECRET_DO_NOT_RETURN"); } }) });
    const b = await begin(failing.handler);
    const failed = await failing.handler.fetch(request("/api/providers/status", "GET", b.cookie));
    expect(failed.status).toBe(502); expect(await failed.text()).not.toContain("SECRET");
  });
  it("requires a canonical HTTPS origin outside local development", () => {
    for (const origin of ["http://vivic.example", "https://vivic.example/", "https://vivic.example/path", "https://user:password@vivic.example"]) {
      expect(() => createOnlineHandler({ origin, createSessionApp: () => ({ fetch: () => response({}), dispose() {} }) })).toThrow();
    }
    expect(setup({ origin: "http://localhost:8790" }).handler).toBeDefined();
  });
  it("cleans credentials for actual createApp sessions, with two independent browser cookies", async () => {
    const upstream = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      return response(url.endsWith("/models") ? { data: [{ id: "step-3.5-flash" }] } : { choices: [{ message: { content: '{"ok":true}' } }] });
    });
    const actual: OnlineSessionApp[] = [];
    const { handler } = setup({ createSessionApp: session => {
      const app = createOnlineSessionApp(session, { fetchImpl: upstream }); actual.push(app); return app;
    } });
    const a = await begin(handler), b = await begin(handler);
    const validated = await handler.fetch(request("/api/credentials/stepfun/validate", "POST", a.cookie, { apiKey: "test-session-a-key-123456789" }));
    expect(await validated.json()).toMatchObject({ ok: true, connected: true });
    const aState = await read(handler, a.cookie), bState = await read(handler, b.cookie);
    expect(aState.body.providers).toEqual([expect.objectContaining({ name: "stepfun", connected: true })]);
    expect(bState.body.providers).toEqual([expect.objectContaining({ name: "stepfun", connected: false })]);
    expect(JSON.stringify(aState.body)).not.toContain("test-session-a-key");
    const disconnected = await handler.fetch(request("/api/credentials/stepfun/disconnect", "POST", a.cookie, {})); await disconnected.json();
    expect((await read(handler, a.cookie)).body.providers[0].connected).toBe(false);
    expect(actual).toHaveLength(2);
  });
});
