import { createHash } from "node:crypto";
import { z } from "zod";
import { HostedSpaceCommandRequestSchema } from "@vivic/contracts";
import { SpaceError, invalid } from "./errors.js";
import { HostedSpaceStore, type HostedSpaceStoreOptions, type SpaceIdentity } from "./store.js";
export { HostedSpaceStore, type HostedSpaceStoreOptions, type SpaceIdentity, type SpaceAccount, type SpaceDevice, type SpaceEnvelopeRequest } from "./store.js";
export { SpaceError } from "./errors.js";
export { arrangeHostedCards, hostedCardHeight, type SpaceContent, type SpaceDocument } from "./executor.js";

export const SPACE_COOKIE = "__Host-vivic_space";
export interface SpaceHandlerOptions extends HostedSpaceStoreOptions { origin: string }
const authFields = { username: z.string().min(1).max(80), password: z.string().min(1).max(256), deviceName: z.string().max(80).optional() };
const RegisterSchema = z.strictObject({ ...authFields, invite: z.string().min(1).max(256) });
const LoginSchema = z.strictObject(authFields);
const CreateSchema = z.strictObject({ title: z.string().trim().min(1).max(120), requestId: z.string().min(1).max(128) });
const ClaimSchema = z.strictObject({ code: z.string().regex(/^[A-Za-z0-9_-]{12}$/), deviceName: z.string().max(80).optional() });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown, status = 200, extra?: HeadersInit) => {
  const headers = new Headers(extra);
  const result = value as { snapshot?: { space?: { id?: unknown; version?: unknown } }; space?: { id?: unknown; version?: unknown }; deduplicated?: boolean };
  const changed = result?.snapshot?.space ?? result?.space;
  if (typeof changed?.id === "string" && typeof changed.version === "number") {
    headers.set("X-Vivic-Space", changed.id); headers.set("X-Vivic-Space-Version", String(changed.version));
    if (result.deduplicated) headers.set("X-Vivic-Deduplicated", "1");
  }
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  return new Response(JSON.stringify(value), { status, headers });
};
const cookieToken = (request: Request): string | null => {
  const cookies = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${SPACE_COOKIE}=`));
  if (cookies.length !== 1) return null;
  const token = cookies[0]!.slice(SPACE_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
};
const cookie = (token: string, seconds: number) => `${SPACE_COOKIE}=${token}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict`;
const clearCookie = () => cookie("", 0);
const fail = (status: number, code: string, message: string): never => { throw new SpaceError(status, code, message); };
const validate = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : invalid();
};
const unsafeKeys = (value: unknown): boolean => Boolean(value && typeof value === "object" && Object.entries(value).some(([key, entry]) =>
  ["__proto__", "constructor", "prototype"].includes(key) || unsafeKeys(entry)));
async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") fail(415, "json-required", "请使用JSON请求。");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 65536)) fail(413, "body-too-large", "请求超过64KiB限制。");
  if (!request.body) invalid("请求正文不能为空。");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 5000); timeout.unref();
  let size = 0;
  try {
    if (request.signal.aborted) fail(408, "request-aborted", "请求已取消。");
    while (true) {
      const result = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const onAbort = () => reject(new SpaceError(408, "body-timeout", "请求读取超时或已取消。"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) { controller.signal.removeEventListener("abort", onAbort); onAbort(); return; }
        reader.read().then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", onAbort));
      });
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 65536) fail(413, "body-too-large", "请求超过64KiB限制。");
      chunks.push(result.value);
    }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))); }
    catch { return invalid("请求正文必须是UTF-8 JSON。"); }
    if (!value || typeof value !== "object" || Array.isArray(value) || unsafeKeys(value)) invalid();
    return value;
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { clearTimeout(timeout); request.signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

/** Account/session boundary, independent of online LLM/admin credentials and desktop owners. */
export function createSpaceHandler(options: SpaceHandlerOptions) {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || origin.username || origin.password
    || !(origin.protocol === "https:" || origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) {
    throw new Error("Space origin must be one HTTPS origin (HTTP is permitted on loopback only).");
  }
  const store = new HostedSpaceStore(options), now = options.now ?? Date.now;
  let disposed = false, activeAuth = 0;
  const sameOrigin = (request: Request) => {
    const requestOrigin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site"), mode = request.headers.get("sec-fetch-mode");
    return new URL(request.url).origin === options.origin && !request.headers.has("authorization")
      && (requestOrigin === null || requestOrigin === options.origin)
      && (site === null || ["same-origin", "none"].includes(site))
      && (mode === null || ["cors", "same-origin", "navigate"].includes(mode))
      && (request.method === "GET" || request.method === "HEAD" || requestOrigin === options.origin);
  };
  const authenticate = (request: Request): SpaceIdentity | null => {
    if (disposed || !sameOrigin(request)) return null;
    const token = cookieToken(request);
    return token ? store.authenticateToken(token) : null;
  };
  const take = (key: string, limit: number, windowMs = 60000) => {
    if (!store.takeRateLimit(key, limit, windowMs)) fail(429, "rate-limit", "请求过于频繁，请稍后重试。");
  };
  const sessionResponse = (result: { identity: SpaceIdentity; token: string; expiresAt: number }) => json({ authenticated: true,
    user: result.identity.user, device: result.identity.device }, 200, { "Set-Cookie": cookie(result.token, Math.max(1, Math.floor((result.expiresAt - now()) / 1000))) });
  const fetch = async (request: Request): Promise<Response> => {
    try {
      if (disposed) fail(503, "space-shutting-down", "空间服务已关闭。");
      const url = new URL(request.url), route = url.pathname, method = request.method;
      if (!route.startsWith("/api/space/")) fail(404, "not-found", "接口不存在。");
      if (url.origin !== options.origin || url.search) fail(400, "invalid-url", "请求地址无效。");
      if (request.headers.has("authorization")) fail(400, "browser-bearer-disabled", "此接口仅使用设备Cookie授权。");
      const requestOrigin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site"), mode = request.headers.get("sec-fetch-mode");
      if (requestOrigin !== null && requestOrigin !== options.origin || site !== null && !["same-origin", "none"].includes(site)
        || mode !== null && !["cors", "same-origin", "navigate"].includes(mode)) fail(403, "same-origin-required", "请从当前站点发起请求。");
      if (method !== "GET" && requestOrigin !== options.origin) fail(403, "same-origin-required", "写入请求需要同源确认。");
      if (!["GET", "POST", "DELETE"].includes(method)) fail(405, "method-not-allowed", "不支持此请求方法。");
      take("space:global", 2000);
      const identity = authenticate(request);
      if (identity) take(`space:device:${identity.device.id}`, 240);
      if (method === "GET" && route === "/api/space/session") return json(identity
        ? { authenticated: true, user: identity.user, device: identity.device } : { authenticated: false });
      if (method === "POST" && ["/api/space/register", "/api/space/login", "/api/space/pair/claim"].includes(route)) {
        // Do not silently replace an existing account's cookie during an unrelated authorisation flow.
        if (identity) fail(409, "already-authenticated", "请先退出当前设备，再登录或授权另一个账号。");
        take("space:authentication", 50);
        if (activeAuth >= 2) fail(429, "authentication-busy", "登录请求正在处理，请稍后重试。");
        const body = await readJson(request);
        if (route === "/api/space/pair/claim") {
          const claim = validate(ClaimSchema, body);
          take("space:pair-claim", 20); take(`space:pair-code:${hash(claim.code)}`, 5, 10 * 60_000);
          if (request.signal.aborted) fail(408, "request-aborted", "请求已取消。");
          return sessionResponse(store.claimPair(claim.code, claim.deviceName));
        }
        const registration = route === "/api/space/register" ? validate(RegisterSchema, body) : null;
        const input = registration ?? validate(LoginSchema, body);
        take(`space:login-name:${hash(input.username.normalize("NFKC").trim().toLowerCase())}`, 8, 10 * 60_000);
        if (route === "/api/space/register") take("space:registration", 10, 10 * 60_000);
        activeAuth++;
        try { return sessionResponse(registration ? await store.register(registration) : await store.login(input)); }
        finally { activeAuth--; }
      }
      if (!identity) return fail(401, "session-required", "请先登录或授权此设备。");
      if (request.signal.aborted) fail(408, "request-aborted", "请求已取消。");
      const { accountId, device } = identity;
      if (method === "POST" && route === "/api/space/logout") {
        validate(z.strictObject({}), await readJson(request));
        store.revokeDevice(accountId, device.id, device.id);
        return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
      }
      if (method === "GET" && route === "/api/space/devices") return json({ devices: store.listDevices(accountId).map(entry => ({ ...entry, current: entry.id === device.id })) });
      const deviceRoute = /^\/api\/space\/devices\/([A-Za-z0-9_-]{1,128})$/.exec(route);
      if (method === "DELETE" && deviceRoute) {
        store.revokeDevice(accountId, deviceRoute[1]!, device.id);
        return json({ ok: true }, 200, deviceRoute[1] === device.id ? { "Set-Cookie": clearCookie() } : undefined);
      }
      if (method === "POST" && route === "/api/space/pair") {
        validate(z.strictObject({}), await readJson(request)); take(`space:pair-issue:${device.id}`, 5);
        return json(store.createPair(accountId, device.id));
      }
      if (method === "GET" && route === "/api/space/spaces") return json({ spaces: store.listSpaces(accountId) });
      if (method === "POST" && route === "/api/space/spaces") return json(store.createSpace(accountId, validate(CreateSchema, await readJson(request)), device.id));
      const receiptRoute = /^\/api\/space\/spaces\/([A-Za-z0-9_-]{1,128})\/commands\/([^/]{1,384})$/.exec(route);
      if (method === "GET" && receiptRoute) {
        let requestId: string;
        try { requestId = decodeURIComponent(receiptRoute[2]!); } catch { return invalid("请求编号编码无效。"); }
        if (!requestId || requestId.length > 128) invalid("请求编号无效。");
        const result = store.getReceipt(accountId, receiptRoute[1]!, requestId);
        return result ? json(result) : json({ ok: false, code: "receipt-not-found", message: "此请求尚无已提交的回执。" }, 404);
      }
      const commandRoute = /^\/api\/space\/spaces\/([A-Za-z0-9_-]{1,128})\/commands$/.exec(route);
      if (method === "POST" && commandRoute) {
        const input = validate(HostedSpaceCommandRequestSchema, await readJson(request));
        if (request.signal.aborted) fail(408, "request-aborted", "请求已取消。");
        return json(store.applyCommand(accountId, commandRoute[1]!, input, device.id));
      }
      const spaceRoute = /^\/api\/space\/spaces\/([A-Za-z0-9_-]{1,128})$/.exec(route);
      if (method === "GET" && spaceRoute) return json(store.getSnapshot(accountId, spaceRoute[1]!));
      return fail(404, "not-found", "接口不存在。");
    } catch (error) {
      if (error instanceof SpaceError) return json({ ok: false, code: error.code, message: error.message,
        ...(error.version !== undefined ? { version: error.version } : {}) }, error.status, error.status === 429 ? { "Retry-After": "60" } : undefined);
      // No SQLite paths, password data, request bodies or provider secrets in public diagnostics.
      return json({ ok: false, code: "space-storage-failed", message: "空间服务暂时无法完成请求，未确认保存。" }, 503);
    }
  };
  return { fetch, store, authenticate, dispose: () => { disposed = true; store.dispose(); } };
}
