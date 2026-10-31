import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { createSpaceHandler, SpaceError, type SpaceIdentity } from "../space/index.js";
import { createOnlineSessionApp } from "../online/appFactory.js";
import { createModelApiClient, type ModelApiClient } from "../modelApi/index.js";
import { createHostedAssetService } from "./assets.js";
import { createHostedTaskService } from "./tasks.js";
import { createHostedReminderScheduler } from "./reminders.js";
import { createHostedMigrationService } from "./migration.js";
import { boundedBytes, hostedBody, hostedFailure, hostedForm, hostedJson } from "./http.js";

type SessionApp = ReturnType<typeof createOnlineSessionApp>;
interface AccountApp { app: SessionApp; token: string; created: number; touched: number }
interface ModelConnection { client: ModelApiClient; key?: string; created: number; touched: number; controller: AbortController }
export interface HostedServiceOptions {
  origin: string; dataDir: string; inviteCode?: string; now?: () => number; fetchImpl?: typeof fetch;
  modelApiBaseUrl?: string; modelApiToken?: string; allowLoopbackModelApi?: boolean;
  autoStartReminders?: boolean;
}
const IDLE = 30 * 60_000, MAX_AGE = 8 * 60 * 60_000;
const proxyGet = new Set(["/api/providers/status", "/api/speech/voices", "/api/decision/status"]);
const proxyPost = new Set(["/api/credentials/stepfun/validate", "/api/credentials/stepfun/disconnect", "/api/providers/select", "/api/providers/model"]);

/** Durable domain data and short-lived model credentials have deliberately separate lifetimes. */
export function createHostedService(options: HostedServiceOptions) {
  const now = options.now ?? Date.now;
  const space = createSpaceHandler({ origin: options.origin, dataDir: options.dataDir, inviteCode: options.inviteCode, now });
  const apps = new Map<string, AccountApp>(), models = new Map<string, ModelConnection>();
  const disabledModels = new Set<string>();
  const assets = createHostedAssetService({ store: space.store, dataDir: options.dataDir, now });
  const reminders = createHostedReminderScheduler(space.store, { now, autoStart: options.autoStartReminders });
  let closed = false;
  let httpActive = 0;
  const httpBySession = new Map<string, number>();
  function appFor(accountId: string, activity: boolean): AccountApp {
    let value = apps.get(accountId);
    if (value && (now() - value.created >= MAX_AGE || now() - value.touched >= IDLE)) {
      void value.app.dispose(); apps.delete(accountId); value = undefined;
    }
    if (!value) {
      const token = randomBytes(32).toString("base64url");
      value = { token, app: createOnlineSessionApp({ token, origin: options.origin }, { fetchImpl: options.fetchImpl }), created: now(), touched: now() };
      apps.set(accountId, value);
    }
    if (activity) value.touched = now(); return value;
  }
  async function invoke(accountId: string, route: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const value = appFor(accountId, route !== "/api/providers/status");
    return value.app.fetch(new Request(`${options.origin}${route}`, { method: body === undefined ? "GET" : "POST", signal,
      headers: { authorization: `Bearer ${value.token}`, origin: options.origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  }
  const tasks = createHostedTaskService({ store: space.store, invoke, now });
  const migration = createHostedMigrationService({ store: space.store, assetService: assets });
  function modelFor(accountId: string) {
    let session = models.get(accountId);
    if (session && (now() - session.created >= MAX_AGE || now() - session.touched >= IDLE)) {
      session.key = undefined; session.controller.abort(); models.delete(accountId); session = undefined;
    }
    if (!session && options.modelApiToken && !disabledModels.has(accountId)) {
      session = connection(options.modelApiToken); models.set(accountId, session);
    }
    return session;
  }
  function connection(key: string): ModelConnection {
    const record = { key, created: now(), touched: now(), controller: new AbortController() } as ModelConnection;
    record.client = createModelApiClient({ baseUrl: options.modelApiBaseUrl ?? "https://edsionc.top/api/v1", getToken: () => record.key,
      fetchImpl: options.fetchImpl, timeoutMs: 180_000, allowLoopbackHttp: options.allowLoopbackModelApi });
    return record;
  }
  async function modelRoute(request: Request, identity: SpaceIdentity) {
    const { accountId } = identity;
    const route = new URL(request.url).pathname;
    if (route === "/api/space/models/connect" && request.method === "POST") {
      const input = z.strictObject({ apiKey: z.string().min(8).max(512).regex(/^\S+$/) }).safeParse(await hostedBody(request));
      if (!input.success) throw new SpaceError(400, "invalid-key", "请在密码框输入有效模型API Key。");
      const next = connection(input.data.apiKey), result = await next.client.status({ signal: request.signal });
      if (!result.ok) { next.key = undefined; next.controller.abort(); return hostedJson({ ok: false, code: result.error.code, message: result.error.message }, result.error.status ?? 503); }
      request.signal.throwIfAborted();
      try { space.store.assertDeviceActive(accountId, identity.device.id); } catch (error) { next.key = undefined; next.controller.abort(); throw error; }
      const previous = models.get(accountId); if (previous) { previous.key = undefined; previous.controller.abort(); }
      models.set(accountId, next); disabledModels.delete(accountId);
      return hostedJson({ configured: true, models: result.value.models, inference: "not-tested", quality: "not-tested" });
    }
    if (route === "/api/space/models/disconnect" && request.method === "POST") {
      await boundedBytes(request, 4096);
      const old = models.get(accountId); if (old) { old.key = undefined; old.controller.abort(); }
      models.delete(accountId); disabledModels.add(accountId); return hostedJson({ ok: true, configured: false });
    }
    const model = modelFor(accountId);
    if (route === "/api/space/models/status" && request.method === "GET") return hostedJson({ configured: Boolean(model?.key),
      capabilities: ["speech", "transcribe", "classification"], inference: "not-tested", quality: "not-tested",
      decision: { executionEnabled: false, protocol: "classification-only", quality: "not-tested" } });
    if (!model?.key) throw new SpaceError(503, "model-not-connected", "请在连接设置中填写语音与小模型API Key。");
    model.touched = now();
    const signal = AbortSignal.any([request.signal, model.controller.signal]);
    const result = route === "/api/space/models/voices" && request.method === "GET" ? await model.client.voices({ signal })
      : route === "/api/space/models/speech" && request.method === "POST" ? await (async () => {
        const data = z.strictObject({ text: z.string().min(1).max(2400), voice: z.string().max(80).optional() }).parse(await hostedBody(request));
        return model.client.synthesize(data.text, { voice: data.voice, signal });
      })()
        : route === "/api/space/models/transcribe" && request.method === "POST" ? await (async () => {
          const form = await hostedForm(request, 22 * 1024 * 1024), file = form.get("file");
          if (!(file instanceof File)) throw new SpaceError(400, "audio-required", "请选择录音。");
          return model.client.transcribe(file, { filename: file.name, signal });
        })()
          : route === "/api/space/models/classify" && request.method === "POST" ? await (async () => {
            const data = z.strictObject({ input: z.string().min(1).max(2000), model: z.enum(["startlux-decision-2b", "gliner2.5-multi-decide"]),
              labels: z.record(z.string(), z.string()) }).parse(await hostedBody(request));
            return model.client.classify(data.input, { model: data.model, labels: data.labels, signal });
          })()
            : undefined;
    if (!result) throw new SpaceError(404, "not-found", "没有此模型接口。");
    space.store.assertDeviceActive(accountId, identity.device.id);
    if (!result.ok) return hostedJson({ ok: false, code: result.error.code, message: result.error.message }, result.error.status ?? 503);
    if ("segments" in result.value) return hostedJson({ segments: result.value.segments.map(segment => ({ ...segment, audio: Buffer.from(segment.audio).toString("base64") })) });
    return hostedJson(result.value);
  }
  async function fetch(request: Request): Promise<Response> {
    if (closed) return hostedJson({ ok: false, code: "shutting-down", message: "服务正在停止。" }, 503);
    const url = new URL(request.url), route = url.pathname;
    if (route === "/healthz" && request.method === "GET") return hostedJson({ ok: true, service: "vivic-space-api", mode: "online", persistentSpace: true });
    // These endpoints perform their own authentication and strict same-origin checks.
    const authRoute = /^\/api\/space\/(session|login|register|logout|devices(?:\/[^/]+)?|pair(?:\/claim)?)$/.test(route);
    if (authRoute) return space.fetch(request);
    try {
      const identity = space.authenticate(request);
      if (route === "/api/runtime" && request.method === "GET") return hostedJson({ mode: "online", session: identity ? "ready" : "missing",
        capabilities: { persistentSpace: true, independentMobile: true, localModels: false, gptOAuth: false } });
      if (!identity) throw new SpaceError(401, "login-required", "请先登录或连接此设备。");
      const { accountId } = identity;
      if (!space.store.takeRateLimit(`hosted:${accountId}`, 180)) throw new SpaceError(429, "rate-limit", "请求较多，请稍后重试。");
      if (route.startsWith("/api/space/models/")) return await modelRoute(request, identity);
      if (route === "/api/space/reminders/status" && request.method === "GET") return hostedJson(reminders.status());
      const migrationResult = await migration.handle(request, identity); if (migrationResult) return migrationResult;
      const assetResult = await assets.handle(request, identity); if (assetResult) return assetResult;
      const taskResult = await tasks.handle(request, identity); if (taskResult) return taskResult;
      const ask = /^\/api\/space\/spaces\/([^/]+)\/assets\/([^/]+)\/ask$/.exec(route);
      if (ask && request.method === "POST") {
        const asset = assets.get(accountId, ask[1]!, ask[2]!);
        if (!["application/pdf", "text/markdown"].includes(asset.mediaType) || !asset.text.trim()) throw new SpaceError(409, "no-readable-text", "此原件没有可供问答的文字，仍可阅读原页或下载。");
        const data = z.strictObject({ question: z.string().trim().min(1).max(1000) }).parse(await hostedBody(request));
        const response = await invoke(accountId, "/api/files/read", { name: asset.name, text: asset.text, partial: asset.parseStatus === "partial", question: data.question }, request.signal);
        space.store.assertDeviceActive(accountId, identity.device.id); return response;
      }
      if (proxyGet.has(route) && request.method === "GET") return await invoke(accountId, route, undefined, request.signal);
      if (proxyPost.has(route) && request.method === "POST") {
        if (route === "/api/credentials/stepfun/validate") {
          const token = randomBytes(32).toString("base64url");
          const candidate: AccountApp = { token, app: createOnlineSessionApp({ token, origin: options.origin }, { fetchImpl: options.fetchImpl }), created: now(), touched: now() };
          try {
            const body = await hostedBody(request);
            const response = await candidate.app.fetch(new Request(`${options.origin}${route}`, { method: "POST", signal: request.signal,
              headers: { authorization: `Bearer ${token}`, origin: options.origin, "content-type": "application/json" }, body: JSON.stringify(body) }));
            request.signal.throwIfAborted(); space.store.assertDeviceActive(accountId, identity.device.id);
            if (response.ok) { const previous = apps.get(accountId); apps.set(accountId, candidate); if (previous) void previous.app.dispose(); }
            else await candidate.app.dispose();
            return response;
          } catch (error) { await candidate.app.dispose(); throw error; }
        }
        const response = await invoke(accountId, route, await hostedBody(request), request.signal);
        space.store.assertDeviceActive(accountId, identity.device.id);
        return response;
      }
      if (route.startsWith("/api/space/")) {
        const response = await space.fetch(request);
        if (response.ok && request.method !== "GET") reminders.check();
        return response;
      }
      throw new SpaceError(404, "not-found", "没有此接口。");
    } catch (error) {
      if (error instanceof z.ZodError) return hostedJson({ ok: false, code: "invalid-input", message: "请求未通过格式校验。" }, 400);
      return hostedFailure(error);
    }
  }
  const expiry = setInterval(() => {
    for (const [id, app] of apps) if (now() - app.created >= MAX_AGE || now() - app.touched >= IDLE) { apps.delete(id); void app.app.dispose(); }
    for (const [id, model] of models) if (now() - model.created >= MAX_AGE || now() - model.touched >= IDLE) { model.key = undefined; model.controller.abort(); models.delete(id); }
  }, 60_000); expiry.unref();
  async function boundedFetch(request: Request): Promise<Response> {
    const scope = createHash("sha256").update(request.headers.get("cookie") ?? "anonymous").digest("hex");
    if (httpActive >= 16 || (httpBySession.get(scope) ?? 0) >= 4) return hostedJson({ ok: false, code: "request-busy", message: "请求较多，请稍后重试。" }, 429, { "Retry-After": "1" });
    const controller = new AbortController(); let timedOut = false;
    const abort = () => controller.abort(); request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 185_000); timer.unref();
    httpActive++; httpBySession.set(scope, (httpBySession.get(scope) ?? 0) + 1);
    try {
      const response = await fetch(new Request(request, { signal: controller.signal }));
      if (timedOut) return hostedJson({ ok: false, code: "request-timeout", message: "等待时间较长，请查询原请求结果。" }, 504);
      const route = new URL(request.url).pathname;
      const publicRoute = route === "/healthz" || route === "/api/runtime"
        || /^\/api\/space\/(session|login|register|logout|devices(?:\/[^/]+)?|pair(?:\/claim)?)$/.test(route);
      if (!publicRoute && response.ok && !space.authenticate(request)) return hostedJson({ ok: false, code: "session-revoked", message: "此设备连接已失效，请重新登录。" }, 401);
      return response;
    } catch (error) { return hostedFailure(error); }
    finally {
      clearTimeout(timer); request.signal.removeEventListener("abort", abort); httpActive--;
      const remaining = (httpBySession.get(scope) ?? 1) - 1; if (remaining) httpBySession.set(scope, remaining); else httpBySession.delete(scope);
    }
  }
  return { fetch: boundedFetch, store: space.store, tasks, assets, reminders,
    async dispose() { closed = true; clearInterval(expiry); reminders.dispose(); await tasks.dispose();
      for (const model of models.values()) { model.key = undefined; model.controller.abort(); } models.clear();
      await Promise.allSettled([...apps.values()].map(record => Promise.resolve(record.app.dispose()))); apps.clear(); space.dispose(); } };
}
