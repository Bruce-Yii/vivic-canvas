import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { DEEPSEEK_BASE_URL, DEFAULT_DEEPSEEK_MODEL, PLAN_MAX_TOKENS, type LocalApiConfig } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { DeepseekCredentialStore, deepseekModel as normalizeDeepseekModel, validateDeepseek } from "./deepseek.js";
import { accountPlanner } from "./modelFallback.js";
import { resolveSavedMain } from "./providers/main.js";
import type { CardDefinition } from "@vivic/card-runtime";
import { currentCardDefinitions } from "./cards/catalog.js";
import { PlatformCredentialStore } from "./platformCredential.js";
import { createModelApiClient } from "./modelApi/index.js";
import { runIntent, type PipelineDeps } from "./intent/pipeline.js";
import { observeDecision, type PlannerRouteHint } from "./decision/trace.js";
import { splitClauses } from "./decision/split.js";
import { safeDiagnostic, type DiagnosticSink } from "./diagnostics.js";
import {
  IntentRequestSchema,
  WeatherHereRequestSchema,
  IntentResponseSchema,
  SpeechRequestSchema,
  ValidateKeyRequestSchema,
} from "./schemas.js";
import { validateConnection, chatJson, probeAnswered, PLAN_CHAT_MODELS, type StepfunDeps } from "./stepfun.js";
import { providerRecoveryHint } from "./providerError.js";
import { SPEECH_MODEL, synthesizeSpeech } from "./speech.js";
import { resolveSavedSpeech } from "./providers/speech.js";
import { DEFAULT_SPEECH_SPEED, DEFAULT_SPEECH_VOICE, SPEECH_VOICES, SPEECH_VOICES_SOURCE } from "./voices.js";
import { createAsrRoutes, ASR_BODY_LIMIT_BYTES } from "./asr.js";
import { createSearchClient, createSearchRoutes, type SearchClient } from "./search/index.js";
import { GptProvider } from "./gpt/provider.js";
import { searchGpt } from "./gpt/search.js";
import { cachedProxy, resolveSearchProxy } from "./openaiProxy.js";
import { createDataClient, DataError, localeAnswer, weatherCardFields, type DataClient } from "./data/index.js";
import { validateImageAttachment, imageInputErrorMessage, type ImageDecoder } from "./images.js";
import { decodeImage } from "./imageDecoder.js";
import { DecisionManager } from "./decision/manager.js";
import { DecisionRouter, HttpDecisionProvider, decisionTimeout, type DecisionProvider } from "./decision/provider.js";
import { HttpNativeV2Provider, type NativeV2Provider } from "./decision/nativeV2.js";
import { DecisionTaskManager } from "./decision/taskV2.js";
import type { PreferenceStore } from "./preferences.js";
import { TravelQuerySchema } from "@vivic/contracts";
import { buildTravelCard, demoTravelProvider, queryTravel, type TravelProvider } from "./providers/travel.js";
import { ManagedStartluxRuntime } from "./runtime/startluxRuntime.js";
import { ManagedLocalTts, validateLocalWav } from "./runtime/localTts.js";
import path from "node:path";
import { homedir, totalmem, freemem } from "node:os";
import { STARTLUX_DEFAULT_PROFILE_ID, STARTLUX_PROFILES, recommendStartluxProfile } from "./runtime/startluxProfiles.js";
import { MobileSessionBroker } from "./mobile/session.js";
import { ConnectionManager } from "./connections/manager.js";
import { createConnectionRoutes } from "./connections/routes.js";
import { ConnectionError } from "./connections/types.js";
import { createFileReadRoutes, FILE_READ_BODY_LIMIT } from "./files/routes.js";
import {
  ProviderStore, ProviderClient, createProviderRoutes, seedStepFunProvider, type ProviderProtocol,
} from "./providers/index.js";

/**
 * Vivic local decision API. Loopback only, bearer-guarded, zod on every
 * body, no stack traces to clients. StepFun key is accepted here, tested
 * once against the real provider, and kept in process memory only.
 */

export interface AppDeps {
  /** Online sessions never inherit the operator's local files or runtimes. */
  mode?: "local" | "online";
  config: LocalApiConfig;
  credentials?: CredentialStore;
  fetchImpl?: typeof fetch;
  search?: SearchClient;
  gpt?: GptProvider;
  data?: DataClient;
  imageDecoder?: ImageDecoder;
  decision?: DecisionManager;
  /** Optional independent DEC-01 API/local provider. */
  decisionProvider?: DecisionProvider;
  decisionV2Provider?: NativeV2Provider;
  router?: PipelineDeps["router"];
  getEnabledDefinitions?: () => Promise<CardDefinition[]>;
  onDecisionTrace?: PipelineDeps["onDecisionTrace"];
  /** `receiptMs` is the proposal→owner-receipt interval when the proposal was seen
   * by this app; omitted for cancellations and for unknown task ids. */
  onDecisionReceipt?: (taskId: string, outcome: "succeeded" | "failed", receiptMs?: number) => void;
  onDiagnostic?: DiagnosticSink;
  travel?: TravelProvider;
  /** Remembers the chosen connection across restarts; absent in tests. */
  preferences?: PreferenceStore;
  mobileBroker?: Pick<MobileSessionBroker, "status" | "create" | "dispose"> & Partial<Pick<MobileSessionBroker, "resume" | "end">>;
  localTts?: Pick<ManagedLocalTts, "status" | "prepare" | "enable" | "stop" | "clear" | "synthesize">;
  /** Generic model-provider settings. Absent = store built from the fields below. */
  providerStore?: ProviderStore;
  /**
   * Directory for `providers.json` and its `.secret-key`. Local mode defaults
   * to `~/.vivic`; an online session must pass the deployment data directory,
   * otherwise settings stay in memory (no host files are touched).
   */
  providerDataDir?: string;
  /** `false` keeps provider settings in memory. Defaults to on when a directory exists. */
  providerPersist?: boolean;
  providerSeed?: boolean;
}

const tokenOk = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const firstIssue = (error: z.ZodError): string =>
  error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");

type AppContext = Context<{ Variables: { requestId: string } }>;

export const createApp = (deps: AppDeps) => {
  const { config } = deps;
  const online = deps.mode === "online";
  // Deployment switch for the SSE-only first sentence. Absent keeps today's
  // behavior (on); ordinary JSON requests never take the streaming branch.
  const sseStreamFeedback = config.streamFeedback !== false;
  const connections = new ConnectionManager({ fetchImpl: deps.fetchImpl });
  let localTts = online ? undefined : deps.localTts;
  const localTtsRuntime = () => online ? undefined : localTts ??= new ManagedLocalTts(path.join(homedir(), ".vivic", "runtime", "local-tts"));
  const mobileBroker: NonNullable<AppDeps["mobileBroker"]> = online ? { status: async () => ({ configured: false, mobileUrl: null }),
    create: async (): Promise<never> => { throw new Error("unavailable_online"); }, dispose: () => undefined }
    : deps.mobileBroker ?? new MobileSessionBroker(path.join(homedir(), ".vivic", "mobile-relay.json"));
  const credentials = deps.credentials ?? new CredentialStore();
  // Generic provider settings. Local sessions persist to ~/.vivic/providers.json.
  // Online sessions persist to the deployment data directory (providers.json +
  // .secret-key, both 0600) so a saved provider survives restarts; without a
  // supplied directory they stay in memory, so tests and stray callers still
  // never read or write the host's home directory.
  const providerDataDir = deps.providerDataDir;
  const providerStore = deps.providerStore ?? new ProviderStore({
    dataDir: providerDataDir ?? path.join(homedir(), ".vivic"),
    persist: deps.providerPersist ?? Boolean(providerDataDir),
  });
  // Deployment seed (online only): VIVIC_STEPFUN_API_KEY becomes a normal
  // encrypted "main" provider exactly once. An existing main provider wins,
  // and local mode keeps its previous behaviour byte for byte.
  if (online && deps.providerSeed !== false) seedStepFunProvider(providerStore);
  // Settings win over env in both modes. An empty store leaves today's
  // StepFun/DeepSeek environment path untouched.
  const savedDecision = providerStore.findForRole("decision");
  // `VIVIC_MAIN_PROVIDER=deepseek` only changes the main planner transport. A
  // separate in-memory store keeps speech/ASR on their StepFun credential, and
  // the key comes from DEEPSEEK_API_KEY without touching disk or logs.
  const mainProvider = config.mainProvider ?? "stepfun";
  const envMainCredentials = mainProvider === "deepseek" ? deps.credentials ?? new CredentialStore() : credentials;
  const settingsCredentials = new CredentialStore();
  let mainCredentials = envMainCredentials;
  let mainDirectDeepseek = mainProvider === "deepseek";
  const deepseekModel = config.deepseekModel ?? DEFAULT_DEEPSEEK_MODEL;
  if (mainProvider === "deepseek" && !mainCredentials.getSecret()) {
    const deepseekKey = config.deepseekApiKey?.trim();
    if (deepseekKey) mainCredentials.set({ apiKey: deepseekKey, models: [deepseekModel], defaultModel: deepseekModel, checkedAt: new Date().toISOString() });
    else mainCredentials.recordError("未配置 DEEPSEEK_API_KEY，DeepSeek 官方快路径不可用；不会回退 StepFun。");
  }
  const platform = new PlatformCredentialStore();
  let platformRevision = 0;
  let platformAttempt: AbortController | undefined;
  const gpt = deps.gpt ?? new GptProvider({ fetchImpl: deps.fetchImpl });
  const data = deps.data ?? createDataClient({ fetchImpl: deps.fetchImpl,
    ...(online ? { config: { deviceLocation: true, networkRegionFallback: false } } : {}) });
  let decisionConfigurationError: string | undefined;
  let decisionProviderFromSettings = false;
  // Even status() on the legacy manager inspects its cache. An online session
  // without a usable decision provider therefore gets a disabled, non-local
  // provider and never touches the filesystem or spawns a runtime.
  const disabledDecisionProvider: DecisionProvider = { decide: async () => ({ state: "disabled" }) };
  // A programmatic provider (tests, embeds) keeps its previous precedence in
  // local mode; online sessions only ever run an explicitly saved provider.
  const configuredProvider: DecisionProvider | undefined = (!online ? deps.decisionProvider : undefined) ?? (() => {
    // A saved decision provider (settings) wins over the env-configured one in
    // both modes; the protocol mapping is unchanged (4B native → startlux,
    // 2B legacy → adapter, other endpoints → local chat).
    const decisionProtocol = (protocol: ProviderProtocol) => protocol === "startlux-native" ? "startlux" as const
      : protocol === "legacy-2b" ? "adapter" as const : "local-chat" as const;
    if (savedDecision) {
      try {
        const protocol = decisionProtocol(savedDecision.protocol);
        const provider = new HttpDecisionProvider(savedDecision.baseUrl, {
          name: protocol === "local-chat" ? "local" : "api",
          timeoutMs: config.decisionProviderTimeoutMs,
          fetchImpl: deps.fetchImpl,
          protocol,
          model: savedDecision.model,
          getToken: () => providerStore.getApiKey(savedDecision.id),
        });
        decisionProviderFromSettings = true;
        return provider;
      } catch {
        decisionConfigurationError = "已保存的决策服务配置无效，已回退到原有指令流程。请检查地址、协议和模型名称。";
        console.warn(JSON.stringify({ event: "decision.configuration_invalid", source: "settings" }));
        safeDiagnostic(deps.onDiagnostic, { event: "decision.configuration_invalid" });
        return online ? disabledDecisionProvider : undefined;
      }
    }
    if (online) return disabledDecisionProvider;
    if (deps.decision || !config.decisionProviderUrl) return undefined;
    try {
    const primary = new HttpDecisionProvider(config.decisionProviderUrl, {
      name: config.decisionProviderKind ?? "api", timeoutMs: config.decisionProviderTimeoutMs,
      fetchImpl: deps.fetchImpl, protocol: config.decisionProviderProtocol, model: config.decisionProviderModel,
      getToken: () => config.decisionProviderToken,
    });
    const fallback = config.decisionProviderFallbackUrl ? new HttpDecisionProvider(config.decisionProviderFallbackUrl, {
      name: "local", timeoutMs: config.decisionProviderTimeoutMs, fetchImpl: deps.fetchImpl,
    }) : undefined;
    return new DecisionRouter(primary, fallback);
    } catch {
      // Operator configuration must not take down the text/rules/LLM path.
      // Never echo the configured URL, token, or upstream exception.
      decisionConfigurationError = "决策服务配置无效，已回退到原有指令流程。请检查地址、协议、服务类型和模型名称后重启。";
      console.warn(JSON.stringify({ event: "decision.configuration_invalid" }));
      safeDiagnostic(deps.onDiagnostic, { event: "decision.configuration_invalid" });
      return undefined;
    }
  })();
  const managed = !online && !deps.decision && !configuredProvider && !decisionConfigurationError && config.managedDecisionEnabled === true
    ? new ManagedStartluxRuntime(config.managedDecisionRoot ?? path.join(homedir(), ".vivic", "runtime", "startlux-decision")) : undefined;
  const decision = (!online && deps.decision) || new DecisionManager(undefined, configuredProvider ?? managed, {
    // Online, only an explicit saved decision provider may run: the hosted
    // deployment keeps the env-driven DecisionManager opt-in off. Local mode
    // keeps the existing env switch unchanged.
    enabled: online ? decisionProviderFromSettings : config.decisionProviderEnabled !== false,
    timeoutMs: 2 * decisionTimeout(config.decisionProviderTimeoutMs),
    modelLabel: online
      ? decisionProviderFromSettings ? savedDecision?.model ?? "已保存的决策服务" : "在线决策未配置"
      : config.decisionProviderProtocol === "startlux" ? "StartLux · 服务端选型" : undefined,
  });
  let nativeV2 = deps.decisionV2Provider;
  if (!nativeV2 && config.decisionV2Url) {
    try { nativeV2 = new HttpNativeV2Provider(config.decisionV2Url, { fetchImpl: deps.fetchImpl,
      timeoutMs: config.decisionV2TimeoutMs, getToken: () => config.decisionV2Token }); }
    catch { safeDiagnostic(deps.onDiagnostic, { event: "decision.configuration_invalid" }); }
  }
  // The managed runtime has a separate native state/questions readout. Never
  // route v2 through DecisionProvider.decide(), which is the legacy seven labels.
  const managedNativeV2 = !nativeV2 && !config.decisionV2Url && managed;
  if (managedNativeV2) nativeV2 = { decide: (state, questions, signal) => managedNativeV2.decideNative(state, questions, signal) };
  const decisionTasks = new DecisionTaskManager({ provider: nativeV2, gate: { executionEnabled: config.decisionV2ExecutionEnabled === true } });
  const preferences = online ? undefined : deps.preferences;
  const saved = preferences?.read() ?? {};
  let activeProvider: "stepfun" | "gpt" = saved.activeProvider ?? "stepfun";
  let providerRevision = 0;
  let connectionRevision = 0;
  let connectionAttempt: AbortController | undefined;
  const deepseek = new DeepseekCredentialStore();
  let deepseekRevision = 0;
  let deepseekAttempt: AbortController | undefined;
  let disposed = false;
  // Proposal→owner-receipt latency is transport telemetry: the receipt request
  // carries no trace, so the proposal time is remembered by task id here.
  const receiptTimes = new Map<string, number>();
  // Lets the page tell "the backend restarted and dropped the in-memory key"
  // apart from a key that stopped working.
  const instance = randomUUID();
  const rememberGpt = () => {
    const status = gpt.status();
    if (status.connected && status.source) preferences?.update({ gptSource: status.source, gptModel: status.defaultModel });
  };
  // A restart must not drop a GPT login the user never disconnected. Requests
  // arriving meanwhile wait for this instead of reporting "not connected".
  let restoringGpt: Promise<void> | undefined = saved.gptSource ? (async () => {
    const source = saved.gptSource!;
    const ok = await gpt.connect(source, saved.gptModel) || (saved.gptModel ? await gpt.connect(source) : false);
    if (ok) { providerRevision++; rememberGpt(); }
  })().catch(() => undefined).finally(() => { restoringGpt = undefined; }) : undefined;
  const searchProxy = !online && config.searchProxy ? cachedProxy(() => resolveSearchProxy(config.searchProxy, process.env)) : undefined;
  const search = deps.search ?? (config.searchEnabled ? createSearchClient({ credentials, fetchImpl: deps.fetchImpl,
    config: { publicDnsFallback: config.publicDnsFallback === true },
    gpt: { connected: () => !online && gpt.status().connected, preferred: () => !online && activeProvider === "gpt",
      search: (query, signal) => searchGpt(gpt, query, signal, deps.fetchImpl) },
    searchProxy: () => searchProxy?.()?.url,
    captureSession: () => { const version = providerRevision; return () => version === providerRevision; },
  }) : undefined);
  const stepfun = {
    baseUrl: config.stepfunBaseUrl,
    fetchImpl: deps.fetchImpl,
    timeoutMs: config.requestTimeoutMs,
  };
  // Only the planner uses the DeepSeek fast path; speech/ASR/readers keep the
  // StepFun deps and credential above. A saved main provider overrides both.
  let mainModel: StepfunDeps = mainProvider === "deepseek"
    ? { baseUrl: config.deepseekBaseUrl ?? DEEPSEEK_BASE_URL, provider: "deepseek" as const,
      fetchImpl: deps.fetchImpl, timeoutMs: config.requestTimeoutMs }
    : stepfun;
  const isDeepseek = (value: ReturnType<ProviderStore["list"]>[number]) => /^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/.test(value.baseUrl);
  const registryRevision = () => JSON.stringify(providerStore.list().filter(value => value.roles.includes("main")));
  let loadedRegistry: string | undefined;
  const syncRegistry = () => {
    const next = registryRevision();
    if (loadedRegistry === next) return;
    const previous = loadedRegistry; loadedRegistry = next;
    const entries = providerStore.list().filter(value => value.enabled && value.roles.includes("main"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const selected = resolveSavedMain(providerStore, { fetchImpl: deps.fetchImpl, timeoutMs: config.requestTimeoutMs });
    const secondary = entries.find(isDeepseek);
    if (selected) {
      mainCredentials = settingsCredentials;
      mainModel = selected.transport;
      mainDirectDeepseek = selected.provider === "deepseek" && !isDeepseek(selected.saved!);
      const primary = selected.provider !== "deepseek" || mainDirectDeepseek ? selected.credential : undefined;
      const current = settingsCredentials.getSecret();
      if (!primary) settingsCredentials.clear();
      else if (current?.apiKey !== primary.apiKey || current.defaultModel !== primary.defaultModel)
        settingsCredentials.set(primary);
    } else if (providerStore.list().some(value => value.roles.includes("main"))) {
      mainCredentials = settingsCredentials; settingsCredentials.clear(); mainDirectDeepseek = false; mainModel = stepfun;
    } else {
      mainCredentials = envMainCredentials; mainDirectDeepseek = mainProvider === "deepseek";
      mainModel = mainDirectDeepseek ? { ...stepfun, baseUrl: config.deepseekBaseUrl ?? DEEPSEEK_BASE_URL, provider: "deepseek" as const } : stepfun;
    }
    const model = secondary && normalizeDeepseekModel(secondary.model);
    if (secondary?.apiKey && model) {
      const current = deepseek.getSecret();
      if (current?.apiKey !== secondary.apiKey || current.defaultModel !== model)
        deepseek.set({ apiKey: secondary.apiKey, defaultModel: model, checkedAt: secondary.updatedAt });
    } else if (previous !== undefined) deepseek.clear();
    if (previous !== undefined) providerRevision++;
  };
  const rememberConnection = (brand: "stepfun" | "deepseek", apiKey?: string, model?: string) => {
    const existing = providerStore.list().find(value => brand === "deepseek" ? isDeepseek(value) : value.protocol === "stepfun-plan");
    if (!apiKey || !model) {
      for (const entry of providerStore.list()) if (brand === "deepseek" ? isDeepseek(entry) : entry.protocol.startsWith("stepfun"))
        providerStore.update(entry.id, { enabled: false });
      return;
    }
    const input = { name: brand === "stepfun" ? "StepFun" : "DeepSeek", apiKey, model, roles: ["main" as const], enabled: true,
      presetId: brand, protocol: brand === "stepfun" ? "stepfun-plan" as const : "openai-compatible" as const,
      baseUrl: brand === "stepfun" ? config.stepfunBaseUrl : "https://api.deepseek.com" };
    if (existing) providerStore.update(existing.id, input); else providerStore.create(input);
  };
  syncRegistry();
  const makePlanner = (): NonNullable<PipelineDeps["planner"]> => {
    syncRegistry();
    const revision = providerRevision, generation = gpt.generation(), registry = registryRevision();
    const current = () => !disposed && providerRevision === revision && registryRevision() === registry;
    if (activeProvider === "gpt") return { provider: "gpt" as const, connected: gpt.status().connected,
      generate: (messages, signal, _maxTokens, onTextDelta) => gpt.generate(messages, signal, onTextDelta),
      isCurrent: () => current() && gpt.isCurrent(generation) };
    if (mainDirectDeepseek) {
      const credential = mainCredentials.getSecret();
      return { provider: "deepseek", connected: Boolean(credential), isCurrent: () => current() && credential === mainCredentials.getSecret(),
        generate: (messages, signal, maxTokens, onTextDelta) => credential
          ? chatJson(credential, messages, { ...mainModel, signal }, { maxTokens, onTextDelta })
          : Promise.resolve({ ok: false, code: "provider", error: "DeepSeek 未连接" }) };
    }
    return accountPlanner({ credentials: mainCredentials, deepseek, stepfun: mainModel, selected: "stepfun", isCurrent: current });
  };

  const app = new Hono<{ Variables: { requestId: string } }>();
  app.use("*", async (c, next) => {
    syncRegistry();
    const requestId = randomUUID(), started = performance.now();
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    await next();
    safeDiagnostic(deps.onDiagnostic, { event: "request.complete", requestId,
      method: c.req.method, route: c.req.routePath, status: c.res.status,
      elapsedMs: Math.round(performance.now() - started) });
  });
  app.onError((_error, c) => {
    safeDiagnostic(deps.onDiagnostic, { event: "request.error", requestId: c.get("requestId"),
      method: c.req.method, route: c.req.routePath, status: 500 });
    return c.json({ ok: false, error: "本地服务暂时无法完成请求。" }, 500);
  });

  // unauthenticated liveness probe (process manager / playwright webServer)
  app.get("/healthz", (c) => c.json({ ok: true, service: "vivic-local-api" }));

  app.use(
    "/api/*",
    cors({
      origin: (origin) =>
        origin && config.allowedOrigins.includes(origin) ? origin : null,
      allowHeaders: ["authorization", "content-type"],
      allowMethods: ["GET", "POST"],
      maxAge: 600,
    }),
  );

  // Hard body size cap before any parsing.
  app.use("/api/*", async (c, next) => {
    if (disposed) return c.json({ ok: false, error: "会话已结束，请重新连接。" }, 410);
    if (c.req.method === "POST") {
      const len = Number(c.req.header("content-length") ?? 0);
      const limit = c.req.path === "/api/transcribe" ? ASR_BODY_LIMIT_BYTES : c.req.path === "/api/files/read" ? FILE_READ_BODY_LIMIT : /^\/api\/intent(?:\/stream)?$/.test(c.req.path) ? 6 * 1024 * 1024 : config.bodyLimitBytes;
      if (len > limit) {
        return c.json({ ok: false, error: "请求体过大" }, 413);
      }
    }
    await next();
  });

  if (online) app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/gpt/") || c.req.path.startsWith("/api/mobile/") || c.req.path.startsWith("/api/local-tts/")
      || c.req.path.startsWith("/api/decision/") && c.req.path !== "/api/decision/status") {
      return c.json({ ok: false, code: "unavailable-online", error: "此功能仅在本地模式提供。" }, 404);
    }
    await next();
  });

  // Local session bearer. The browser never holds it: the vite dev proxy
  // injects it server-side; tests and operators use .env.local directly.
  app.use("/api/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!presented || !tokenOk(presented, config.token)) {
      return c.json({ ok: false, error: "未授权的本地会话" }, 401);
    }
    // Multipart voice uploads are simple browser requests, so CORS response
    // headers alone do not prevent another origin from spending a local key.
    if (c.req.method === "POST") {
      const origin = c.req.header("origin");
      if ((origin && !config.allowedOrigins.includes(origin)) || c.req.header("sec-fetch-site") === "cross-site") {
        return c.json({ ok: false, error: "请求来源不在本地控制页范围内。" }, 403);
      }
    }
    await next();
  });

  app.route("/api/connections", createConnectionRoutes(connections, async (messages, signal) => {
    if (restoringGpt && activeProvider === "gpt") await restoringGpt;
    const planner = makePlanner();
    const result = planner.connected ? await planner.generate(messages, signal, 2048) : undefined;
    if (!planner.isCurrent()) throw new ConnectionError("model-changed", "模型连接已改变，请重新查询。", 409);
    if (!result?.ok) throw new ConnectionError("planner-unavailable", "语言模型暂不可用，请检查连接或使用指定查询。", 409);
    return result.value;
  }));
  app.route("/api/files", createFileReadRoutes(async () => {
    if (restoringGpt && activeProvider === "gpt") await restoringGpt;
    const planner = makePlanner();
    return {
      isCurrent: planner.isCurrent,
      generate: (messages, signal) => planner.connected ? planner.generate(messages, signal, 4096)
          : Promise.resolve({ ok: false as const, code: "provider" as const, error: "模型未连接" }),
    };
  }));

  app.post("/api/credentials/stepfun/validate", async (c) => {
    if (mainProvider === "deepseek") {
      return c.json({ ok: false, connected: false,
        error: "当前使用 DeepSeek 官方快路径（VIVIC_MAIN_PROVIDER=deepseek），模型由 DEEPSEEK_API_KEY 和 VIVIC_DEEPSEEK_MODEL 配置，不接受 StepFun Key。" }, 400);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "请求体不是合法 JSON" }, 400);
    }
    const parsed = ValidateKeyRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { ok: false, error: `请求格式不正确：${firstIssue(parsed.error)}` },
        400,
      );
    }
    const revision = ++connectionRevision;
    connectionAttempt?.abort();
    const controller = new AbortController(); connectionAttempt = controller;
    const result = await validateConnection(parsed.data.apiKey, {
      ...stepfun, timeoutMs: config.connectionTimeoutMs ?? 12000,
      signal: AbortSignal.any([c.req.raw.signal, controller.signal]),
    }).finally(() => { if (connectionAttempt === controller) connectionAttempt = undefined; });
    if (disposed || revision !== connectionRevision || c.req.raw.signal.aborted) {
      return c.json({ ok: false, connected: false, error: "连接请求已取消或被新的连接替代。" }, 409);
    }
    providerRevision++;
    if (!result.ok) {
      // A failed key must not leave stale credentials around (fail closed).
      credentials.clear();
      rememberConnection("stepfun");
      const error = `${result.error}。${providerRecoveryHint(result.status)}`;
      credentials.recordError(error);
      return c.json({ ok: false, connected: false, error });
    }
    // Replace credentials atomically; the key object never leaves this scope.
    credentials.set({ apiKey: parsed.data.apiKey, ...result.value });
    rememberConnection("stepfun", parsed.data.apiKey, result.value.defaultModel);
    return c.json({ ok: true, ...credentials.status() });
  });

  app.post("/api/credentials/stepfun/disconnect", (c) => {
    connectionRevision++; providerRevision++;
    connectionAttempt?.abort(); connectionAttempt = undefined;
    credentials.clear();
    rememberConnection("stepfun");
    if (mainCredentials !== credentials) mainCredentials.clear();
    return c.json({ ok: true, connected: false });
  });

  app.post("/api/credentials/deepseek/validate", async c => {
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return c.json({ ok: false, connected: false, error: "请输入有效的 DeepSeek Key。" }, 400); }
    const input = z.strictObject({ apiKey: z.string().min(8).max(512).regex(/^\S+$/),
      model: z.enum(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"]).optional() }).safeParse(raw);
    if (!input.success) return c.json({ ok: false, connected: false, error: "请输入有效的 DeepSeek Key 和模型。" }, 400);
    const revision = ++deepseekRevision; deepseekAttempt?.abort();
    const controller = new AbortController(); deepseekAttempt = controller;
    const result = await validateDeepseek(input.data.apiKey, normalizeDeepseekModel(input.data.model)!, {
      fetchImpl: deps.fetchImpl, timeoutMs: config.connectionTimeoutMs ?? 12_000,
      signal: AbortSignal.any([c.req.raw.signal, controller.signal]),
    }).finally(() => { if (deepseekAttempt === controller) deepseekAttempt = undefined; });
    if (disposed || revision !== deepseekRevision || c.req.raw.signal.aborted)
      return c.json({ ok: false, connected: false, error: "连接已取消或已被新的连接替代。" }, 409);
    providerRevision++;
    if (!result.ok) { deepseek.clear(); rememberConnection("deepseek"); deepseek.recordError(result.error); return c.json({ ok: false, connected: false, error: result.error }); }
    deepseek.set({ apiKey: input.data.apiKey, ...result.value });
    rememberConnection("deepseek", input.data.apiKey, result.value.defaultModel);
    return c.json({ ok: true, ...deepseek.status() });
  });
  app.post("/api/credentials/deepseek/disconnect", c => {
    deepseekRevision++; providerRevision++; deepseekAttempt?.abort(); deepseekAttempt = undefined; deepseek.clear();
    rememberConnection("deepseek");
    return c.json({ ok: true, connected: false });
  });

  app.post("/api/credentials/platform/validate", async (c) => {
    let raw: unknown;
    try { raw = await c.req.json(); }
    catch { return c.json({ ok: false, error: "请求体不是合法 JSON" }, 400); }
    const parsed = z.strictObject({
      apiKey: z.string().min(8).max(512).regex(/^\S+$/, "API Key 不应包含空白字符"),
    }).safeParse(raw);
    if (!parsed.success) return c.json({ ok: false, error: "请输入有效的本地 API 平台 Key。" }, 400);
    const revision = ++platformRevision;
    platformAttempt?.abort();
    const controller = new AbortController();
    platformAttempt = controller;
    const client = createModelApiClient({
      baseUrl: config.modelApiBaseUrl, token: parsed.data.apiKey,
      fetchImpl: deps.fetchImpl, timeoutMs: 12_000,
    });
    const result = await client.status({ signal: AbortSignal.any([c.req.raw.signal, controller.signal]) })
      .finally(() => { if (platformAttempt === controller) platformAttempt = undefined; });
    if (disposed || revision !== platformRevision || c.req.raw.signal.aborted) {
      return c.json({ ok: false, connected: false, error: "连接请求已取消或被新的连接替代。" }, 409);
    }
    if (!result.ok) {
      platform.clear();
      platform.recordError(result.error.message);
      return c.json({ ok: false, connected: false, error: result.error.message });
    }
    platform.set(parsed.data.apiKey);
    return c.json({ ok: true, connected: true });
  });

  app.post("/api/credentials/platform/disconnect", (c) => {
    platformRevision++;
    platformAttempt?.abort(); platformAttempt = undefined;
    platform.clear();
    return c.json({ ok: true, connected: false });
  });

  app.get("/api/providers/status", (c) => {
    c.header("Cache-Control", "no-store");
    // The "stepfun" slot is the main planner slot: in DeepSeek mode it reports
    // the env-keyed fixed model so existing clients keep working unchanged.
    const status = mainCredentials.status();
    // Legacy clients still read the "stepfun" main slot, but when the provider
    // store selects DeepSeek the displayed provider must say DeepSeek.
    const mainSlotName = mainDirectDeepseek || !status.connected && deepseek.status().connected ? "deepseek" : "stepfun";
    const displayStatus = mainSlotName === "deepseek" && !mainDirectDeepseek ? deepseek.status() : { ...status, name: mainSlotName };
    rememberGpt();
    if (activeProvider === "gpt") gpt.keepWarm();
    return c.json({
      activeProvider: activeProvider === "gpt" ? "gpt" : mainSlotName, mainProvider: mainSlotName, instance,
      ...(restoringGpt ? { restoring: "gpt" } : {}),
      // Keep the established provider array shape for deployed clients. New
      // clients discover the additive DeepSeek connection through this field.
      providers: online ? [displayStatus] : [displayStatus, gpt.status()],
      deepseek: deepseek.status(),
      fallback: { preferred: "stepfun", secondary: "deepseek", configured: deepseek.status().connected },
      platform: platform.status(),
      degradations: (activeProvider === "stepfun" ? status.connected || deepseek.status().connected : gpt.status().connected)
        ? []
        : [
            {
              code: mainProvider === "deepseek" ? "deepseek-disconnected" : "stepfun-disconnected",
              message: mainProvider === "deepseek"
                ? "DeepSeek 官方快路径未连接：未配置 DEEPSEEK_API_KEY。不会回退 StepFun，复杂指令暂不可用。"
                : "所选模型未连接，/api/intent 只做本地规则，复杂指令暂不可用。",
            },
          ],
    });
  });

  const readJson = async (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);
  app.post("/api/providers/select", async c => {
    const body = z.strictObject({ provider: z.enum(["stepfun", "gpt"]) }).safeParse(await readJson(c));
    if (!body.success) return c.json({ ok: false, error: "仅支持 StepFun Coding Plan 或 GPT。" }, 400);
    if (online && body.data.provider === "gpt") return c.json({ ok: false, error: "线上模式暂支持 StepFun。" }, 400);
    if (activeProvider !== body.data.provider) { activeProvider = body.data.provider; providerRevision++; }
    preferences?.update({ activeProvider });
    return c.json({ ok: true, activeProvider });
  });
  app.post("/api/providers/model", async c => {
    const body = z.strictObject({ provider: z.enum(["stepfun", "gpt"]), model: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/) }).safeParse(await readJson(c));
    if (!body.success) return c.json({ ok: false, error: "模型选择无效。" }, 400);
    if (online && body.data.provider === "gpt") return c.json({ ok: false, error: "线上模式暂支持 StepFun。" }, 400);
    if (body.data.provider === "gpt") {
      const source = gpt.status().source;
      if (!source) return c.json({ ok: false, error: "请先连接 GPT。" }, 503);
      const ok = await gpt.connect(source, body.data.model); providerRevision++; rememberGpt();
      return c.json({ ok, ...gpt.status() });
    }
    if (mainProvider === "deepseek") {
      return c.json({ ok: false, error: "当前使用 DeepSeek 官方快路径，模型由 VIVIC_DEEPSEEK_MODEL 固定配置。" }, 400);
    }
    const credential = credentials.getSecret();
    if (!credential || !credential.models.includes(body.data.model) || !PLAN_CHAT_MODELS.includes(body.data.model)) return c.json({ ok: false, error: "请选择已连接套餐中的推理模型。" }, 400);
    const candidate = { ...credential, defaultModel: body.data.model };
    const probe = await chatJson(candidate, [{ role: "system", content: '只输出JSON {"ok":true}' }, { role: "user", content: "测试连接" }], { ...stepfun, timeoutMs: config.connectionTimeoutMs ?? 12000, signal: c.req.raw.signal }, { maxTokens: 256 });
    if (disposed || c.req.raw.signal.aborted || credentials.getSecret() !== credential) return c.json({ ok: false, error: "连接已变更，请重新选择。" }, 409);
    if (!probe.ok && !probeAnswered(probe)) return c.json({ ok: false, error: probe.error });
    credentials.set({ ...candidate, checkedAt: new Date().toISOString() }); providerRevision++;
    rememberConnection("stepfun", candidate.apiKey, candidate.defaultModel);
    return c.json({ ok: true, ...credentials.status() });
  });
  app.post("/api/gpt/connect", async c => {
    const body = z.strictObject({ source: z.enum(["pi", "vivic"]).default("pi") }).safeParse(await readJson(c));
    if (!body.success) return c.json({ ok: false, error: "登录来源无效。" }, 400);
    const ok = await gpt.connect(body.data.source); providerRevision++; rememberGpt();
    return c.json({ ok, ...gpt.status() });
  });
  app.post("/api/gpt/login/start", async c => {
    const body = z.strictObject({}).safeParse(await readJson(c));
    if (!body.success) return c.json({ ok: false, error: "登录请求不接受额外配置。" }, 400);
    providerRevision++;
    return c.json({ ok: true, login: await gpt.startLogin() });
  });
  app.get("/api/gpt/login/status", c => { c.header("Cache-Control", "no-store"); return c.json({ login: gpt.loginStatus(), provider: gpt.status() }); });
  app.post("/api/gpt/login/input", async c => {
    const body = z.strictObject({ value: z.string().min(1).max(8192) }).safeParse(await readJson(c));
    if (!body.success) return c.json({ ok: false, error: "回调地址无效。" }, 400);
    return c.json({ ok: gpt.provideLoginInput(body.data.value) });
  });
  app.post("/api/gpt/login/cancel", c => { gpt.cancelLogin(); return c.json({ ok: true }); });
  app.post("/api/gpt/disconnect", async c => {
    providerRevision++; await gpt.disconnect();
    preferences?.update({ gptSource: undefined, gptModel: undefined });
    return c.json({ ok: true });
  });

  // Generic model-provider management. Registered AFTER the legacy
  // /api/providers/status|select|model handlers so those keep winning.
  app.route("/api/providers", createProviderRoutes({
    store: providerStore,
    ...(deps.fetchImpl ? { client: new ProviderClient({ fetchImpl: deps.fetchImpl }) } : {}),
  }));

  app.get("/api/speech/voices", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      model: SPEECH_MODEL, voices: SPEECH_VOICES, defaultVoice: DEFAULT_SPEECH_VOICE,
      speed: { min: 0.5, max: 2, default: DEFAULT_SPEECH_SPEED },
      source: SPEECH_VOICES_SOURCE, verifiedAt: "2026-10-15",
    });
  });

  app.post("/api/speech", bodyLimit({
    maxSize: 4096,
    onError: (c) => c.json({ ok: false, code: "speech-invalid-input", error: "语音请求体过大" }, 413),
  }), async (c) => {
    c.header("Cache-Control", "no-store");
    if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return c.json({ ok: false, code: "speech-invalid-input", error: "语音请求必须使用 application/json" }, 415);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ ok: false, code: "speech-invalid-input", error: "请求体不是合法 JSON" }, 400);
    }
    const parsed = SpeechRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({
        ok: false, code: "speech-invalid-input",
        error: "语音请求仅接受 text（1–200 字符可见短句）、voice（可选官方音色）、speed（可选 0.5–2）、timestamps（可选布尔值）。",
      }, 400);
    }
    const selected = resolveSavedSpeech(providerStore);
    if (selected && "error" in selected) return c.json({ ok: false, code: "speech-disconnected", error: selected.error }, 503);
    const saved = selected?.saved;
    const credential = saved ? { apiKey: "", models: [selected.backend.model], defaultModel: selected.backend.model, checkedAt: saved.updatedAt }
      : credentials.getSecret();
    if (!credential) return c.json({ ok: false, code: "speech-disconnected", error: "语音未连接：请在模型设置中配置 TTS，或连接 StepFun API。" }, 503);
    const speechRevision = JSON.stringify(providerStore.list());
    const result = await synthesizeSpeech(credential, parsed.data.text, {
      ...stepfun, timeoutMs: config.speechTimeoutMs ?? 15000,
    }, c.req.raw.signal, parsed.data, selected?.backend);
    // A disconnect/reconnect during synthesis must not deliver stale audio.
    if (saved ? JSON.stringify(providerStore.list()) !== speechRevision : credentials.getSecret() !== credential) {
      return c.json({ ok: false, code: "speech-disconnected", error: "语音已取消：模型连接已变更。" }, 503);
    }
    if (!result.ok) {
      return c.json({ ok: false, code: result.code, error: result.error }, result.status);
    }
    if (parsed.data.timestamps && (selected?.backend.supportsTimestamps ?? true)) return c.json({ audioBase64: Buffer.from(result.audio).toString("base64"), words: result.words ?? [] });
    c.header("Content-Type", result.mime ?? "audio/mpeg");
    if (selected?.backend.clientSpeed) c.header("X-Vivic-Speech-Playback-Rate", "client");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(result.audio, 200);
  });

  const nativeStatus = () => ({ ...decisionTasks.status(),
    source: managedNativeV2 ? "managed-startlux" : deps.decisionV2Provider ? "injected-native" : nativeV2 ? "configured-native-service" : "unconfigured",
    ...(managedNativeV2 ? { available: managedNativeV2.status().phase === "ready", runtimePhase: managedNativeV2.status().phase,
      profileId: managedNativeV2.status().profileId } : {}),
  });
  const decisionStatus = (status = decision.status()) => ({ ...status, v2: nativeStatus(), ...(decisionConfigurationError
    ? { configurationError: decisionConfigurationError, error: status.error ?? decisionConfigurationError } : {}) });
  app.get("/api/decision/status", async c => { c.header("Cache-Control", "no-store"); if (managed) await managed.refreshResources(); return c.json(decisionStatus()); });
  app.get("/api/decision/models", c => c.json({
    defaultProfileId: STARTLUX_DEFAULT_PROFILE_ID,
    recommendation: recommendStartluxProfile({ totalMemoryBytes: totalmem(), freeMemoryBytes: freemem() }),
    profiles: STARTLUX_PROFILES,
    // Metadata is advisory. Only /status describes what is actually running.
    selectionMode: managed ? "managed-startlux" : "official-startlux-service", installationState: managed ? "managed" : "not-inspected",
  }));
  app.post("/api/decision/profile", async c => {
    if (!managed) return c.json({ ok: false, error: "当前使用外部决策服务，模型由该服务选择。" }, 404);
    const body = z.strictObject({ profileId: z.enum(["startlux-0.8b", "startlux-2b", "startlux-4b", "startlux-9b"]) }).safeParse(await readJson(c));
    if (!body.success) return c.json({ ok: false, error: "请选择有效的本地模型。" }, 400);
    try { return c.json(managed.selectProfile(body.data.profileId)); }
    catch { return c.json({ ok: false, error: "请先停止当前模型或等待准备完成，再切换模型。" }, 409); }
  });
  app.post("/api/decision/prepare", c => c.json(decisionStatus(decision.prepare())));
  app.post("/api/decision/stop", c => c.json(decisionStatus(decision.stop())));
  app.get("/api/local-tts/status", c => c.json(localTtsRuntime()!.status()));
  for (const operation of ["prepare", "enable", "stop", "clear"] as const) {
    app.post(`/api/local-tts/${operation}`, c => c.json(localTtsRuntime()![operation]()));
  }
  app.post("/api/local-tts/synthesize", async c => {
    const body = z.strictObject({ text: z.string().trim().min(1).max(200).refine(s => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s)), speed: z.number().finite().min(.5).max(2).optional() }).safeParse(await readJson(c));
    if (!body.success) return c.json({ ok: false, error: "语音只接受 1–200 个可见字符与有效语速。" }, 400);
    try {
      const audio = validateLocalWav(await localTtsRuntime()!.synthesize(body.data.text, body.data.speed, c.req.raw.signal));
      c.header("content-type", "audio/wav"); c.header("cache-control", "no-store"); c.header("x-content-type-options", "nosniff");
      return c.body(new Uint8Array(audio).buffer, 200);
    } catch (error) {
      const code = error instanceof Error ? error.message : "local_tts_failed";
      if (code === "local_tts_busy") return c.json({ ok: false, error: "本地语音正在处理上一条请求，请稍后重试。" }, 409);
      if (code === "local_tts_not_ready") return c.json({ ok: false, error: "请先在本地能力中准备并启动音色。" }, 409);
      if (code === "local_tts_cancelled" || c.req.raw.signal.aborted) return new Response(JSON.stringify({ ok: false, error: "语音请求已取消。" }), { status: 499, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      return c.json({ ok: false, error: "本地语音未能完成，文字内容仍然可用。" }, 502);
    }
  });
  app.post("/api/decision/clear", c => c.json(decisionStatus(decision.clear())));
  app.post("/api/decision/enable", c => c.json(decisionStatus(decision.enable())));
  app.get("/api/mobile/status", async c => { c.header("Cache-Control", "no-store"); return c.json(await mobileBroker.status()); });
  const mobileSlot = (c: AppContext, id: string) => `${c.req.header("origin") ?? new URL(c.req.url).origin}:${id}`;
  for (const action of ["resume", "end"] as const) app.post(`/api/mobile/session/${action}`, async c => {
    c.header("Cache-Control", "no-store");
    const body = z.strictObject({ ownerSlot: z.uuid() }).safeParse(await readJson(c));
    if (!body.success || online) return c.json({ error: "手机会话请求无效。" }, 400);
    const slot = mobileSlot(c, body.data.ownerSlot);
    if (action === "resume") return c.json({ session: mobileBroker.resume?.(slot) ?? null });
    try { await mobileBroker.end?.(slot); return c.json({ ok: true }); }
    catch { return c.json({ ok: false, error: "会话已在本机停用；中继撤权尚未确认，请检查连接。" }, 503); }
  });
  app.post("/api/mobile/session", async c => {
    c.header("Cache-Control", "no-store");
    const body = z.strictObject({ ownerSlot: z.uuid().optional() }).safeParse(await readJson(c) ?? {});
    if (!body.success) return c.json({ error: "手机会话请求无效。" }, 400);
    try { return c.json(await mobileBroker.create(body.data.ownerSlot ? mobileSlot(c, body.data.ownerSlot) : undefined)); }
    catch { return c.json({ error: "手机中继暂不可用，请稍后重试或检查本机中继配置。" }, 503); }
  });

  app.post("/api/travel/refresh", async c => {
    const parsed = z.strictObject({ query: TravelQuerySchema }).safeParse(await readJson(c));
    if (!parsed.success) return c.json({ kind: "error", message: "旅游查询参数不正确。" }, 400);
    const lookup = await queryTravel(deps.travel ?? demoTravelProvider, parsed.data.query, c.req.raw.signal);
    if (!lookup.ok) return c.json({ kind: "error", message: lookup.message });
    return c.json({ kind: "travel", card: buildTravelCard(lookup.result) });
  });

  // Live refresh of a "where I am" weather card. Returns verified card fields
  // only; Control replaces the card body locally, so no Action is involved.
  app.post("/api/weather/here", async c => {
    const body = WeatherHereRequestSchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ kind: "error", message: "定位数据格式不正确。" }, 400);
    try {
      const weather = await data.weatherHere(body.data.deviceLocation, c.req.raw.signal);
      if (weather.kind === "clarify") return c.json({ kind: "clarify", message: weather.message });
      const { spokenText: _spoken, ...fields } = weatherCardFields(weather);
      return c.json({ kind: "weather", ...fields });
    } catch (error) {
      return c.json({ kind: "error", message: (error instanceof DataError ? error : new DataError("unavailable")).message });
    }
  });

  // "我在哪里": the place alone, with no card and no model.
  app.post("/api/locale", async c => {
    const body = WeatherHereRequestSchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ kind: "error", message: "定位数据格式不正确。" }, 400);
    try {
      const found = await data.locale(body.data.deviceLocation, c.req.raw.signal);
      if (found.kind !== "locale") return c.json({ kind: found.kind, message: found.message });
      const { basis, name, admin1, country, country_code } = found;
      return c.json({ kind: "locale", locale: { name, ...(admin1 ? { admin1 } : {}), ...(country ? { country } : {}), ...(country_code ? { country_code } : {}),
        basis, answer: localeAnswer(found) } });
    } catch (error) {
      return c.json({ kind: "error", message: (error instanceof DataError ? error : new DataError("unavailable")).message });
    }
  });

  const handleIntent = async (c: AppContext) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "请求体不是合法 JSON" }, 400);
    }
    if (deps.getEnabledDefinitions && raw && typeof raw === "object" && !Array.isArray(raw)) {
      const { extensionDefinitions: _clientCatalog, ...serverRequest } = raw as Record<string, unknown>;
      raw = serverRequest;
    }
    const parsed = IntentRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { ok: false, error: `请求格式不正确：${firstIssue(parsed.error)}` },
        400,
      );
    }
    if (restoringGpt && activeProvider === "gpt") await restoringGpt;
    const version = providerRevision;
    const gptVersion = gpt.generation();
    const imageCredential = mainCredentials.getSecret();
    if (parsed.data.attachments?.length) {
      const vision = activeProvider === "gpt" ? gpt.status().connected && gpt.status().capabilities.includes("vision")
        : credentials.status().connected && credentials.status().capabilities.includes("vision")
          || deepseek.status().connected && deepseek.status().capabilities.includes("vision");
      if (!vision) return c.json({ kind: "error", message: "当前所选模型没有可用的视觉能力。请选择支持图片的模型，或移除图片后发送文字。" });
      try {
        for (const attachment of parsed.data.attachments) await validateImageAttachment(attachment, deps.imageDecoder ?? decodeImage);
      } catch (error) { return c.json({ kind: "error", message: imageInputErrorMessage(error) }); }
      if (c.req.raw.signal.aborted) return c.json({ kind: "error", message: "图片请求已取消。" });
      if (version !== providerRevision || (activeProvider === "gpt" ? !gpt.isCurrent(gptVersion) : imageCredential !== mainCredentials.getSecret())) {
        return c.json({ kind: "error", message: "模型连接已变更，图片请求已取消。" });
      }
    }
    const requestId = c.get("requestId");
    let installedDefinitions: CardDefinition[] | undefined;
    let requestRouter = deps.router;
    if (deps.getEnabledDefinitions) {
      try {
        installedDefinitions = currentCardDefinitions(await deps.getEnabledDefinitions());
        requestRouter = deps.router?.forDefinitions?.(installedDefinitions) ?? deps.router;
      } catch { return c.json({ kind: "error", message: "已安装卡片校验失败，请检查或重新导入卡片包。" }); }
    }
    const observeStage: NonNullable<PipelineDeps["onStage"]> = event => safeDiagnostic(deps.onDiagnostic, {
      event: "intent.stage", requestId, stage: event.stage, state: event.status,
      ...(event.elapsedMs !== undefined ? { elapsedMs: Math.round(event.elapsedMs) } : {}),
    });
    const execute = (signal: AbortSignal, onStage = observeStage, streamFeedback = false) => {
      const pipeline: PipelineDeps = { credentials: mainCredentials, stepfun: mainModel, mainProvider,
      planMaxTokens: config.planMaxTokens ?? PLAN_MAX_TOKENS, search, data, decision, onStage, streamFeedback, travel: deps.travel,
      router: requestRouter, onDecisionTrace: deps.onDecisionTrace,
      decisionTelemetry: { plannerCalls: 0, directClauses: 0 },
      slotPlanning: requestRouter?.mode === "shadow" || requestRouter?.mode === "on",
      compactContext: online && mainProvider === "deepseek" ? true : undefined,
      isSessionCurrent: () => version === providerRevision,
      planner: makePlanner(),
      };
      const intent = { ...parsed.data, requestId,
        tracePath: c.req.header("x-vivic-trace-path") === "task" ? "task" as const : "browser" as const,
        ...(installedDefinitions ? { installedDefinitions, extensionDefinitions: undefined } : {}),
        ...(online && c.req.header("x-vivic-intent-image-ref") ? { trustedImageRef: c.req.header("x-vivic-intent-image-ref") } : {}) };
      const clauseCount = splitClauses(intent.text).length;
      // ChatPage sends a task id on every request, so `task` alone must not own
      // the first sentence. A request that can publish a route hint waits for
      // it; only the paths that deliberately have no single route use a scene
      // line immediately. Priority: target frame > route hint > scene > neutral.
      const routeHintEligible = requestRouter?.mode === "on" && clauseCount === 1
        && !parsed.data.attachments?.length && !parsed.data.continuation
        && !parsed.data.task?.receipt && !parsed.data.task?.cancel;
      const fallbackScene = !streamFeedback ? undefined
        : parsed.data.attachments?.length ? "attachment" as const
          : parsed.data.continuation ? "continuation" as const
            : clauseCount > 1 ? "multi" as const
              : parsed.data.task ? "task" as const : undefined;
      let scenePublished = false;
      const publishScene = () => {
        if (scenePublished || !fallbackScene) return;
        scenePublished = true;
        // This frame carries no business data and no route claim.
        try { onStage({ stage: "decision", status: "started", scene: fallbackScene }); } catch { /* progress is advisory */ }
      };
      // Multi-clause, attachment, continuation and receipt paths never publish a
      // route hint, so their scene line is sent now. A route-eligible request
      // must not send `scene:"task"` first: the client schedules a 600ms preset
      // from it and then ignores the later route hint.
      if (!routeHintEligible) publishScene();
      // The on-mode router hint already exists for every clause. Publish it on the
      // existing progress channel as optional fields instead of opening a second
      // message chain; older clients strip the unknown keys and see today's label.
      const publishRouteHint = (hint: Promise<PlannerRouteHint | null> | undefined) => {
        if (!streamFeedback || requestRouter?.mode !== "on" || !routeHintEligible) return;
        if (!hint) { publishScene(); return; }
        void hint.then(value => {
          if (signal.aborted) return;
          if (!value) { publishScene(); return; }
          const result = value.result;
          // A slow or failed classifier falls back to the safe scene line, never
          // to a committed route or action sentence.
          if (!result?.route || result.none || result.probability < 0.8) { publishScene(); return; }
          const { route } = result;
          // "decision" is an existing stage, so old clients keep their old label.
          const progress = { stage: "decision" as const, status: "started" as const,
            route: route.slice(0, 90), feedbackSource: "preset" as const };
          try { onStage(progress); } catch { /* progress is advisory */ }
          // The route is known before the target is; only a later frame unlocks
          // an action sentence for focus/edit/highlight. Delete stays confirmation.
          if (["focus", "edit", "delete", "highlight"].includes(route)) {
            void value.target.then(target => {
              if (signal.aborted) return;
              const targetState = !target ? "unresolved" as const
                : "targetId" in target ? "resolved" as const
                  : "missing" in target ? "missing" as const : "ambiguous" as const;
              try { onStage({ ...progress, targetState }); } catch { /* progress is advisory */ }
            }).catch(() => { /* a target frame never fails the request */ });
          }
        }).catch(() => { publishScene(); });
      };
      if (requestRouter?.mode !== "on" && !nativeV2 && !parsed.data.task) return runIntent(intent, pipeline, signal);
      return observeDecision(intent, pipeline, signal, routeHint => {
        publishRouteHint(routeHint);
        return decisionTasks.run(intent, {
          // Deletion safety is a host policy, not a benefit of having a decision
          // router: a missing target clarifies, an ambiguous target asks which
          // card, and a known target is frozen behind an explicit confirmation.
          // Without a route hint the planner proposal still goes through the same
          // freeze; no configured model must never mean "delete immediately".
          safetyMode: true, routeHint,
          legacy: (request, taskSignal, plannerOnly) => runIntent({ ...request,
            offlineReferenceCompatibility: request.offlineReferenceCompatibility === true
              && (online || !configuredProvider && !deps.decision && !decision.status().enabled),
          }, { ...pipeline, routeHint, executionRouter: requestRouter, router: undefined, onDecisionTrace: undefined }, taskSignal, false, plannerOnly),
          isCurrent: () => version === providerRevision,
          tools: {
            weather: (city, canvasContext, taskSignal) => runIntent({ text: `${city}天气`, canvasContext, deviceLocation: parsed.data.deviceLocation }, { ...pipeline, decision: undefined }, taskSignal, true),
            ...(search ? { search: (query: string, canvasContext: typeof parsed.data.canvasContext, taskSignal: AbortSignal) => runIntent({ text: `搜索 ${query}`, canvasContext }, { ...pipeline, decision: undefined }, taskSignal, true) } : {}),
          },
        }, signal).then(result => {
          if (intent.task && (intent.task.receipt || intent.task.cancel)) {
            const outcome = result.task?.status === "completed" ? "succeeded"
              : result.task?.status === "failed" || result.task?.status === "cancelled" ? "failed" : undefined;
            if (outcome) {
              const proposedAt = receiptTimes.get(intent.task.id);
              receiptTimes.delete(intent.task.id);
              // A cancellation is not an owner receipt, so it has no receipt wait.
              const receiptMs = intent.task.receipt && proposedAt !== undefined
                ? Math.max(0, Math.round(performance.now() - proposedAt)) : undefined;
              try { deps.onDecisionReceipt?.(intent.task.id, outcome, receiptMs); } catch { /* telemetry is advisory */ }
            }
          } else if (result.task?.status === "awaiting_execution") {
            // A taskless proposal still returns its generated task id, which is what
            // the later receipt carries; remember when this app handed it to the owner.
            receiptTimes.set(result.task.id, performance.now());
            while (receiptTimes.size > 256) {
              const oldest = receiptTimes.keys().next().value;
              if (oldest === undefined) break;
              receiptTimes.delete(oldest);
            }
          }
          return result;
        });
      });
    };
    if (c.req.path.endsWith("/stream") || c.req.header("accept")?.includes("text/event-stream")) {
      c.header("X-Accel-Buffering", "no");
      return streamSSE(c, async stream => {
        const controller = new AbortController();
        stream.onAbort(() => controller.abort());
        const signal = AbortSignal.any([c.req.raw.signal, controller.signal]);
        let delivery = Promise.resolve();
        try {
          await stream.writeSSE({ event: "accepted", data: JSON.stringify({ requestId }) });
          const result = await execute(signal, event => {
            observeStage(event);
            if (signal.aborted || stream.closed) return;
            delivery = delivery.then(async () => {
              if (!signal.aborted && !stream.closed) await stream.writeSSE({ event: "progress", data: JSON.stringify({ requestId, ...event }) });
            }).catch(() => controller.abort());
          }, sseStreamFeedback);
          const wire = IntentResponseSchema.safeParse(result);
          await delivery;
          if (!signal.aborted && !stream.closed) await stream.writeSSE({ event: "result", data: JSON.stringify(wire.success
            ? wire.data : { kind: "error", message: "内部结果未能通过响应校验。" }) });
        } catch {
          safeDiagnostic(deps.onDiagnostic, { event: "request.error", requestId, route: "/api/intent/stream", status: 500 });
          if (!signal.aborted && !stream.closed) {
            try { await stream.writeSSE({ event: "result", data: JSON.stringify({ kind: "error", message: "本地服务暂时无法完成请求。" }) }); } catch { /* Reader already disconnected. */ }
          }
        } finally { controller.abort(); }
      });
    }
    const result = await execute(c.req.raw.signal);
    const wire = IntentResponseSchema.safeParse(result);
    if (!wire.success) {
      return c.json({ ok: false, error: "内部结果未能通过响应校验" }, 500);
    }
    return c.json(wire.data);
  };
  const intentLimit = bodyLimit({ maxSize: 6 * 1024 * 1024,
    onError: c => c.json({ ok: false, error: "图片指令请求过大。" }, 413),
  });
  app.post("/api/intent", intentLimit, handleIntent);
  app.post("/api/intent/stream", intentLimit, handleIntent);

  app.route("/api", createAsrRoutes({ config, credentials, providerStore, fetchImpl: deps.fetchImpl }));
  if (search) app.route("/api", createSearchRoutes({ client: search }));
  else app.post("/api/search", c => c.json({ ok: false, error: "联网查询未启用。" }, 503));
  return Object.assign(app, { dispose: () => {
    if (disposed) return;
    disposed = true; connectionRevision++; providerRevision++; platformRevision++;
    connectionAttempt?.abort(); connectionAttempt = undefined;
    deepseekRevision++; deepseekAttempt?.abort(); deepseekAttempt = undefined; deepseek.clear();
    platformAttempt?.abort(); platformAttempt = undefined;
    connections.dispose();
    credentials.clear(); if (mainCredentials !== credentials) mainCredentials.clear();
    platform.clear(); gpt.dispose(); mobileBroker.dispose(); decision.stop(); decisionTasks.dispose(); localTts?.stop();
    receiptTimes.clear();
  } });
};
