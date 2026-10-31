import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { createSpaceHandler, SpaceError, type SpaceIdentity } from "../space/index.js";
import { createOnlineSessionApp } from "../online/appFactory.js";
import { createModelApiClient, type ModelApiClient, type ModelApiDecisionModel } from "../modelApi/index.js";
import { createHostedAssetService } from "./assets.js";
import { createHostedEvents } from "./events.js";
import { createHostedTaskService } from "./tasks.js";
import { createHostedReminderScheduler } from "./reminders.js";
import { createHostedMigrationService } from "./migration.js";
import { boundedBytes, hostedBody, hostedFailure, hostedForm, hostedJson } from "./http.js";
import { ownerCanvas, ownerRoute } from "./owner.js";
import { createIntentRouter, type IntentRouter } from "../decision/router.js";
import { decisionOutcome } from "../decision/logging.js";
import type { PipelineDeps } from "../intent/pipeline.js";
import { IntentRequestSchema } from "../schemas.js";
import { imageInputErrorMessage } from "../images.js";
import { cardPackageRoute, readEnabledCardDefinitions } from "./cardPackages.js";
import { createFixedSetup, DEMO_DECISION_MODEL } from "./setup.js";

type SessionApp = ReturnType<typeof createOnlineSessionApp>;
interface AccountApp { app: SessionApp; token: string; created: number; touched: number }
interface DecisionConnection { model: ModelApiDecisionModel; connectedAt: string }
interface ModelConnection { client: ModelApiClient; key?: string; created: number; touched: number; controller: AbortController; decision?: DecisionConnection }
export interface HostedServiceOptions {
  origin: string; dataDir: string; inviteCode?: string; now?: () => number; fetchImpl?: typeof fetch;
  modelApiBaseUrl?: string; modelApiToken?: string; allowLoopbackModelApi?: boolean;
  autoStartReminders?: boolean;
  router?: IntentRouter;
}
const IDLE = 30 * 60_000, MAX_AGE = 8 * 60 * 60_000;
const DECISION_TEST_INPUT = "请把所有卡片显示在一屏里";
const DECISION_MODELS = ["startlux-decision-2b", "startlux-decision-4b", "gliner2.5-multi-decide"] as const;
const DecisionModelSchema = z.enum(DECISION_MODELS);
const wireProtocol = (model: ModelApiDecisionModel) => model === "startlux-decision-4b" ? "native" as const : "legacy" as const;
const DECISION_LABELS = {
  fit: "在一屏显示全部卡片", restore: "恢复之前的画布视图", focus: "聚焦一张卡片", delete: "删除卡片",
  expand: "展开便笺并查看全文", collapse: "收起便笺只显示摘要", other: "不明确、否定、复合或其他要求",
};
const proxyGet = new Set(["/api/providers/status", "/api/speech/voices", "/api/decision/status", "/api/connections/status", "/api/connections/authorization/capabilities"]);
const proxyPost = new Set(["/api/credentials/stepfun/validate", "/api/credentials/stepfun/disconnect", "/api/credentials/deepseek/validate", "/api/credentials/deepseek/disconnect", "/api/credentials/platform/validate", "/api/credentials/platform/disconnect", "/api/providers/select", "/api/providers/model", "/api/intent", "/api/intent/stream", "/api/speech", "/api/files/read", "/api/weather/here", "/api/travel/refresh", "/api/locale", "/api/search", "/api/connections/connect", "/api/connections/disconnect", "/api/connections/query"]);
for (const route of ["configure", "test", "ask", "authorization/start", "authorization/poll", "authorization/cancel"]) proxyPost.add(`/api/connections/${route}`);

/** Durable domain data and short-lived model credentials have deliberately separate lifetimes. */
export function createHostedService(options: HostedServiceOptions) {
  const now = options.now ?? Date.now;
  // Hosted turns use deterministic contracts first, then the selected main
  // model. Keep the previous classifier path as an explicit operator opt-in.
  const router = options.router ?? createIntentRouter({ fetchImpl: options.fetchImpl,
    policy: process.env.VIVIC_DECISION_POLICY?.trim().toLowerCase() === "full" ? "full" : "main-only" });
  const space = createSpaceHandler({ origin: options.origin, dataDir: options.dataDir, inviteCode: options.inviteCode, now });
  const apps = new Map<string, AccountApp>(), models = new Map<string, ModelConnection>();
  const setup = createFixedSetup({ ...options, store: space.store, changed: accountId => {
    const app = apps.get(accountId); if (app) { void app.app.dispose(); apps.delete(accountId); }
    const model = models.get(accountId); if (model) { model.controller.abort(); models.delete(accountId); }
    disabledModels.delete(accountId);
  } });
  const disabledModels = new Set<string>();
  const assets = createHostedAssetService({ store: space.store, dataDir: options.dataDir, now });
  const reminders = createHostedReminderScheduler(space.store, { now, autoStart: options.autoStartReminders });
  let closed = false;
  let httpActive = 0;
  const httpBySession = new Map<string, number>();
  const recentDecisionReceipts = new Map<string, { outcome: "succeeded" | "failed"; at: number }>();
  function sessionOptions(accountId: string) {
    const onDecisionTrace: NonNullable<PipelineDeps["onDecisionTrace"]> = (request, trace, result) => {
      const saved = space.store.recordDecisionLog(accountId, { spaceId: request.canvasContext.canvasId,
        path: request.tracePath ?? "browser", text: request.text, trace, outcome: decisionOutcome(result) });
      const receipt = trace.taskId ? recentDecisionReceipts.get(JSON.stringify([accountId, trace.taskId])) : undefined;
      if (trace.taskId && receipt && now() - receipt.at <= 60_000) space.store.setDecisionTaskOutcome(accountId, trace.taskId, receipt.outcome);
      if (saved.inserted && trace.legacyActionTypes.includes("history.undo")) space.store.markLastDecisionUndone(accountId, request.canvasContext.canvasId);
    };
    return { fetchImpl: options.fetchImpl, router, onDecisionTrace,
      getEnabledDefinitions: () => readEnabledCardDefinitions(space.store, accountId),
      onDecisionReceipt: (taskId: string, outcome: "succeeded" | "failed") => {
        const key = JSON.stringify([accountId, taskId]);
        recentDecisionReceipts.delete(key); recentDecisionReceipts.set(key, { outcome, at: now() });
        for (const [id, value] of recentDecisionReceipts) if (now() - value.at > 60_000) recentDecisionReceipts.delete(id);
        while (recentDecisionReceipts.size > 256) { const first = recentDecisionReceipts.keys().next().value; if (first === undefined) break; recentDecisionReceipts.delete(first); }
        space.store.setDecisionTaskOutcome(accountId, taskId, outcome);
      } };
  }
  function appFor(accountId: string, activity: boolean): AccountApp {
    let value = apps.get(accountId);
    if (value && (now() - value.created >= MAX_AGE || now() - value.touched >= IDLE)) {
      void value.app.dispose(); apps.delete(accountId); value = undefined;
    }
    if (!value) {
      const token = randomBytes(32).toString("base64url");
      const providerDataDir = path.join(options.dataDir, "account-providers", accountId);
      // Existing deployment settings were intentionally shared operator defaults.
      // Copy them once, through their encrypted stores, before account-local edits.
      // Never use another account's private directory as a template.
      // New accounts configure their own three keys. Operator defaults are never copied.
      const decisionStore = setup.providerStore(accountId), decision = decisionStore.findForRole("decision");
      const decisionKey = decision && decisionStore.getApiKey(decision.id);
      // startlux-decision-4b p50 is ~2.7s on the platform: a 1500ms budget timed out on every turn.
      const accountRouter = options.router ?? (decisionKey ? createIntentRouter({ mode: "on", policy: "full", model: DEMO_DECISION_MODEL,
        url: `${decision!.baseUrl.replace(/\/+$/, "")}/decisions`, apiKey: decisionKey, timeoutMs: 6000, fetchImpl: options.fetchImpl,
        directRoutes: ["countdown", "todo", "note", "overview", "restore"] }) : router);
      // Provider settings share the deployment's durable data root, so a saved
      // main/decision provider survives session turnover and process restarts.
      value = { token, app: createOnlineSessionApp({ token, origin: options.origin },
        { ...sessionOptions(accountId), router: accountRouter, providerDataDir, providerSeed: false }), created: now(), touched: now() };
      apps.set(accountId, value);
    }
    if (activity) value.touched = now(); return value;
  }
  async function invoke(accountId: string, route: string, body: unknown, signal?: AbortSignal, tracePath: "browser" | "task" = "browser", trustedImageRef?: string): Promise<Response> {
    const value = appFor(accountId, route !== "/api/providers/status");
    return value.app.fetch(new Request(`${options.origin}${route}`, { method: body === undefined ? "GET" : "POST", signal,
      headers: { authorization: `Bearer ${value.token}`, origin: options.origin, "content-type": "application/json", "x-vivic-trace-path": tracePath,
        ...(trustedImageRef ? { "x-vivic-intent-image-ref": trustedImageRef } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  }
  async function invokeMethod(accountId: string, route: string, method: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const value = appFor(accountId, true);
    return value.app.fetch(new Request(`${options.origin}${route}`, { method, signal,
      headers: { authorization: `Bearer ${value.token}`, origin: options.origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  }
  const tasks = createHostedTaskService({ store: space.store,
    invoke: (accountId, route, body, signal) => invoke(accountId, route, body, signal, "task"), now });
  const events = createHostedEvents(space.store, now);
  const migration = createHostedMigrationService({ store: space.store, assetService: assets });
  function modelFor(accountId: string) {
    let session = models.get(accountId);
    if (session && (now() - session.created >= MAX_AGE || now() - session.touched >= IDLE)) {
      session.key = undefined; session.controller.abort(); models.delete(accountId); session = undefined;
    }
    const saved = setup.providerStore(accountId), provider = saved.findForRole("decision");
    const key = provider && saved.getApiKey(provider.id);
    if (!session && key && !disabledModels.has(accountId)) {
      session = connection(key); session.decision = { model: DEMO_DECISION_MODEL, connectedAt: provider!.updatedAt }; models.set(accountId, session);
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
      decision: { configured: Boolean(model?.key && model.decision), model: model?.decision?.model ?? null,
        wireProtocol: model?.decision ? wireProtocol(model.decision.model) : null,
        executionEnabled: false, protocol: "classification-only", quality: "not-tested", connectedAt: model?.decision?.connectedAt ?? null } });
    if (!model?.key) throw new SpaceError(503, "model-not-connected", "请在连接设置中填写语音与小模型API Key。");
    model.touched = now();
    const signal = AbortSignal.any([request.signal, model.controller.signal]);
    if (route === "/api/space/models/decision/connect" && request.method === "POST") {
      const input = z.strictObject({ model: DecisionModelSchema }).parse(await hostedBody(request));
      const result = await model.client.classify(DECISION_TEST_INPUT, { model: input.model, labels: DECISION_LABELS, signal });
      if (!result.ok) {
        if (result.error.code === "protocol-mismatch") {
          const native = input.model === "startlux-decision-4b";
          return hostedJson({ ok: false, code: native ? "decision-native-protocol-unsupported" : "decision-protocol-mismatch",
            message: native ? "平台返回了旧协议格式，未接受 4B 原生 state/questions；本次未连接，也不会静默改用旧协议。"
              : "平台返回了 4B 原生格式，但所选模型使用旧 input/labels 协议；本次未连接，也不会静默改用 4B。" }, 502);
        }
        // A 4B-native body rejected by the platform means the gateway still speaks only the legacy protocol.
        if (input.model === "startlux-decision-4b" && result.error.code === "invalid-input") {
          return hostedJson({ ok: false, code: "decision-native-protocol-unsupported",
            message: "平台拒绝了 4B 原生 state/questions 请求；请确认平台已支持 startlux-decision-4b。本次未连接，也不会静默改用旧协议。" }, 422);
        }
        return hostedJson({ ok: false, code: result.error.code, message: result.error.message }, result.error.status ?? 503);
      }
      request.signal.throwIfAborted();
      space.store.assertDeviceActive(accountId, identity.device.id);
      if (models.get(accountId) !== model || !model.key) throw new SpaceError(409, "model-connection-changed", "模型连接已改变，请重新连接后再试。");
      model.decision = { model: input.model, connectedAt: new Date(now()).toISOString() };
      return hostedJson({ configured: true, model: input.model, connectedAt: model.decision.connectedAt,
        executionEnabled: false, protocol: "classification-only", wireProtocol: wireProtocol(input.model), quality: "not-tested",
        probe: { choice: result.value.choice, score: result.value.score, needsReview: result.value.needs_review } });
    }
    if (route === "/api/space/models/decision/disconnect" && request.method === "POST") {
      z.strictObject({}).parse(await hostedBody(request, 4096));
      model.decision = undefined;
      space.store.assertDeviceActive(accountId, identity.device.id);
      return hostedJson({ configured: false, executionEnabled: false, protocol: "classification-only", quality: "not-tested" });
    }
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
            const data = z.strictObject({ input: z.string().min(1).max(2000), model: DecisionModelSchema,
              labels: z.record(z.string(), z.string()) }).parse(await hostedBody(request));
            if (!model.decision) throw new SpaceError(503, "decision-model-not-connected", "请先连接并测试决策模型。");
            if (data.model !== model.decision.model) throw new SpaceError(409, "decision-model-mismatch", "请求的决策模型与当前连接不一致。");
            return model.client.classify(data.input, { model: data.model, labels: data.labels, signal });
          })()
            : undefined;
    if (!result) throw new SpaceError(404, "not-found", "没有此模型接口。");
    space.store.assertDeviceActive(accountId, identity.device.id);
    if (!result.ok) {
      if (result.error.code === "protocol-mismatch") {
        const native = model.decision?.model === "startlux-decision-4b";
        return hostedJson({ ok: false, code: native ? "decision-native-protocol-unsupported" : "decision-protocol-mismatch",
          message: native ? "平台返回了旧协议格式，未接受 4B 原生 state/questions；本次未执行分类，也不会静默改用旧协议。"
            : "平台返回了 4B 原生格式，但当前模型使用旧 input/labels 协议；本次未执行分类，也不会静默改用 4B。" }, 502);
      }
      return hostedJson({ ok: false, code: result.error.code, message: result.error.message }, result.error.status ?? 503);
    }
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
      const event = await events.handle(request, identity); if (event) return event;
      const nativeSnapshot = /^\/api\/space\/native\/spaces\/([A-Za-z0-9_-]{1,128})$/.exec(route);
      if (nativeSnapshot && request.method === "GET") {
        const snapshot = space.store.getSnapshot(accountId, nativeSnapshot[1]!);
        const projected = ownerCanvas(space.store, accountId, nativeSnapshot[1]!).record;
        return hostedJson({ ...snapshot, space: { ...snapshot.space,
          cards: projected.cardOrder.map(id => projected.cardsById[id]!) } });
      }
      if (route === "/api/space/decision-log" && request.method === "GET") {
        const raw = url.searchParams.get("limit") ?? "200";
        if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 200) throw new SpaceError(400, "invalid-limit", "limit 需要为1–200。");
        return hostedJson({ entries: space.store.listDecisionLogs(accountId, Number(raw)) });
      }
      const packages = await cardPackageRoute(space.store, request, identity); if (packages) return packages;
      const owner = await ownerRoute(space.store, request, identity); if (owner) { if (request.method !== "GET") { events.changed(accountId, identity.device.id, owner); reminders.check(); } return owner; }
      if (route === "/api/transcribe" && request.method === "POST") {
        const value = appFor(accountId, true), bytes = await boundedBytes(request, 22 * 1024 * 1024);
        return await value.app.fetch(new Request(`${options.origin}${route}`, { method: "POST", signal: request.signal,
          headers: { authorization: `Bearer ${value.token}`, origin: options.origin, "content-type": request.headers.get("content-type") ?? "" }, body: bytes }));
      }
      const configured = await setup.handle(request, identity); if (configured) return configured;
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
      // PR3 provider settings: the online owner panel is the same app as the
      // local one, so CRUD/list/presets/preview/test must reach the session
      // app instead of 404 at the hosted boundary. Settings are deployment
      // scoped to the authenticated account, including encrypted persistence.
      const providerCrud = route === "/api/providers" || route === "/api/providers/presets"
        || route.startsWith("/api/providers/preview/")
        || /^\/api\/providers\/(?!status$|select$|model$)[^/]+(?:\/(?:test|models))?$/.test(route);
      if (providerCrud) {
        const accountHint = request.headers.get("x-vivic-account");
        if (accountHint && accountHint !== accountId) throw new SpaceError(409, "account-changed", "账号已切换，请重新打开模型设置。");
        if (!["GET", "POST", "PATCH", "DELETE"].includes(request.method)) throw new SpaceError(405, "method-not-allowed", "此接口不支持该请求方法。");
        const body = request.method === "GET" ? undefined : await hostedBody(request, 128 * 1024);
        const response = await invokeMethod(accountId, route, request.method, body, request.signal);
        space.store.assertDeviceActive(accountId, identity.device.id);
        return response;
      }
      if (proxyGet.has(route) && request.method === "GET") return await invoke(accountId, route, undefined, request.signal);
      if (proxyPost.has(route) && request.method === "POST") {
        const accountHint = request.headers.get("x-vivic-account");
        if (route.startsWith("/api/credentials/") && accountHint && accountHint !== accountId)
          throw new SpaceError(409, "account-changed", "账号已切换，请重新打开连接设置。");
        // Each provider validates atomically inside the account app. Replacing the
        // whole app here would discard the other provider and break failover.
        const body = await hostedBody(request, route.startsWith("/api/intent") || route === "/api/files/read" ? 6 * 1024 * 1024 : 64 * 1024);
        let trustedImageRef: string | undefined;
        if (route.startsWith("/api/intent") && router.mode !== "off") {
          const stripped = body && typeof body === "object" && !Array.isArray(body)
            ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "extensionDefinitions")) : body;
          const parsed = IntentRequestSchema.safeParse(stripped);
          if (parsed.success && parsed.data.attachments?.length) {
            try { trustedImageRef = await assets.persistIntentImage(accountId, parsed.data.canvasContext.canvasId, parsed.data.attachments[0]!, identity.device.id, request.signal); }
            catch (error) {
              if (error instanceof SpaceError) throw error;
              return hostedJson({ kind: "error", message: imageInputErrorMessage(error) });
            }
          }
        }
        const response = await invoke(accountId, route, body, request.signal, "browser", trustedImageRef);
        space.store.assertDeviceActive(accountId, identity.device.id);
        return response;
      }
      if (route.startsWith("/api/space/")) {
        const response = await space.fetch(request);
        if (response.ok && request.method !== "GET") { events.changed(accountId, identity.device.id, response); reminders.check(); }
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
    async dispose() { closed = true; clearInterval(expiry); events.dispose(); reminders.dispose(); await tasks.dispose();
      recentDecisionReceipts.clear();
      for (const model of models.values()) { model.key = undefined; model.controller.abort(); } models.clear();
      await Promise.allSettled([...apps.values()].map(record => Promise.resolve(record.app.dispose()))); apps.clear(); space.dispose(); } };
}
