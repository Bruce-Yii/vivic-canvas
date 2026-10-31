import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createModels, type CredentialStore, type AuthPrompt, type AuthEvent, type Model, type Api, type OAuthAuth } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ChatMessage, StepfunResult } from "../stepfun.js";
import { gptFetch, GPT_MODELS, GPT_RESPONSES, CODEX_RESPONSES, GptTransportError } from "./transport.js";

type Route = "openai" | "openai-codex";
// Pi 1.2 does not re-export AuthStorage. Load this exact pinned implementation
// alone rather than importing its CLI/session/tool registry barrel.
let authStorageModule: Promise<{ AuthStorage: { create: (path: string) => CredentialStore } }> | undefined;
const loadStorage = () => authStorageModule ??= import(new URL("./core/auth-storage.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
export type GptSource = "pi" | "vivic";
const routes: Route[] = ["openai", "openai-codex"];
const OAuth = z.object({ type: z.literal("oauth"), access: z.string().min(1), refresh: z.string().min(1), expires: z.number().finite() }).passthrough();
const id = z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/);
// A cold proxied OpenAI request costs up to ~10 s of tunnel setup, and the
// connection check makes three in a row (token refresh, catalog, probe).
export const GPT_CONNECT_TIMEOUT_MS = 60_000;
export const GPT_REQUEST_TIMEOUT_MS = 60_000;
const GPT_RETRY_DELAY_MS = 800;
const GPT_RETRY_MIN_REMAINING_MS = 15_000;
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
// The proxy drops an idle tunnel after 90–150 s (measured 2026-10-17).
export const GPT_KEEP_WARM_MS = 60_000;
const PREFERRED = ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-6-sol", "gpt-6.1-sol"];

/** Only OAuth for the two Pi GPT routes. No command/API-key config resolution. */
function oauthStorage(storage: CredentialStore): CredentialStore {
  const allowed = (provider: string) => { if (!routes.includes(provider as Route)) throw new Error("Provider disabled"); };
  return {
    async read(provider, options) { allowed(provider); const value = await storage.read(provider, options); return OAuth.safeParse(value).success ? value : undefined; },
    async list(options) { return (await storage.list(options)).filter(value => routes.includes(value.providerId as Route) && value.type === "oauth"); },
    async modify(provider, work, options) { allowed(provider); return storage.modify(provider, async value => {
      const result = await work(OAuth.safeParse(value).success ? value : undefined);
      if (result !== undefined && !OAuth.safeParse(result).success) throw new Error("Only OAuth is supported");
      return result;
    }, options); },
    async delete(provider, options) { allowed(provider); return storage.delete(provider, options); },
  };
}
/**
 * Pi bounds a token refresh by a fixed 15 s and passes only that timeout in.
 * Through a slow proxy the cold tunnel alone takes ~10 s, so refreshes timed
 * out roughly hourly — and a refresh abandoned after OpenAI rotated the token
 * can lose the only valid refresh token. Same refresh, longer bound.
 */
export const GPT_REFRESH_TIMEOUT_MS = 60_000;
const patientRefresh = (oauth: OAuthAuth): OAuthAuth => ({
  ...oauth, refresh: credential => oauth.refresh(credential, AbortSignal.timeout(GPT_REFRESH_TIMEOUT_MS)),
});
function runtime(storage: CredentialStore, oauthLogin?: OAuthAuth["login"]) {
  const models = createModels({ credentials: oauthStorage(storage), authContext: { env: async () => undefined, fileExists: async () => false } });
  for (const provider of [openaiProvider(), openaiCodexProvider()]) {
    const oauth = provider.auth.oauth && patientRefresh(provider.auth.oauth);
    models.setProvider({ ...provider, auth: { oauth: oauth && oauthLogin && provider.id === "openai" ? { ...oauth, login: oauthLogin } : oauth } });
  }
  return models;
}
const errorText = (error: unknown) => {
  const parts: string[] = [];
  for (let value = error, depth = 0; value instanceof Error && depth < 4; value = value.cause, depth++) parts.push(value.message);
  return parts.join("\n");
};
const errorCode = (error: unknown) => {
  for (let value = error, depth = 0; value instanceof Error && depth < 4; value = value.cause, depth++) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,40}$/.test(code)) return code;
  }
};
const hasTimeout = (error: unknown) => {
  for (let value = error, depth = 0; value instanceof Error && depth < 4; value = value.cause, depth++) if (value.name === "TimeoutError") return true;
  return false;
};
const UNSUPPORTED_REGION = "unsupported_country_region_territory";
/**
 * Fixed text for OpenAI token-endpoint failures. Upstream messages can embed
 * response bodies, so only an HTTP status and known codes are surfaced.
 */
function tokenEndpointFailure(error: unknown, action: string): string | undefined {
  const text = errorText(error);
  const status = /token request failed \((\d{3})\)/.exec(text)?.[1];
  if (status && text.includes(UNSUPPORTED_REGION)) return `${action}失败（HTTP ${status}：${UNSUPPORTED_REGION}）。OpenAI 拒绝了 Vivic 后端当前的网络出口地区。后端会通过系统代理访问 OpenAI，请确认代理已开启且节点所在地区受支持（也可用 VIVIC_OPENAI_PROXY 指定代理）。`;
  if (status) return `${action}失败（HTTP ${status}）。请稍后重新登录。`;
  if (hasTimeout(error)) return `${action}超时：经代理连接 OpenAI 授权服务器太慢。已保存的授权没有失效，请稍后重试，无需重新登录。`;
  const code = errorCode(error);
  if (code || /fetch failed/i.test(text)) return `${action}失败：Vivic 后端无法连接 OpenAI 授权服务器${code ? `（${code}）` : ""}。浏览器能完成授权不代表本机后端可以访问 auth.openai.com，请检查后端网络。`;
}
type LoginStage = "start" | "browser" | "exchange";
function loginFailure(error: unknown, stage: LoginStage, timedOut: boolean): string {
  const text = errorText(error);
  if (timedOut) return "等待 ChatGPT 授权超时（5 分钟），未保存任何授权。请重新登录。";
  if (/Credential store modify failed/.test(text)) return "已取得 ChatGPT 授权，但写入本机凭据（~/.vivic/auth.json）失败，请检查该文件权限或是否被其他程序锁定，然后重新登录。";
  if (/Port 1455 is in use/.test(text) || errorCode(error) === "EADDRINUSE") return "回调端口 1455 已被占用（可能是 Codex CLI 或其他 Pi 会话未完成的登录），本次浏览器回调不会到达 Vivic。请先结束那边的登录再重试；Vivic 不会关闭其他程序。";
  if (stage === "start") return "无法启动 ChatGPT 授权：本机回调服务（127.0.0.1:1455）或设备标识初始化失败。";
  if (stage === "browser") {
    if (/ChatGPT authorization failed/.test(text)) return "ChatGPT 未同意或拒绝了本次授权，未保存任何授权。请重新登录。";
    return "回调地址无效或与本次登录不匹配，未保存任何授权。请重新登录；手动粘贴时需使用本次登录的完整回调地址。";
  }
  if (text.includes("chatgpt.tokens.use.direct")) return "ChatGPT 授权未包含 GPT 推理所需的 chatgpt.tokens.use.direct 权限，账号或套餐可能不支持此登录方式。";
  return tokenEndpointFailure(error, "浏览器授权已完成，但授权码换取令牌") ?? "浏览器授权已完成，但授权码换取令牌失败（OpenAI 返回了无效响应），未保存任何授权。请重新登录。";
}
type Runtime = ReturnType<typeof runtime>;
interface Connection { runtime: Runtime; storage: CredentialStore; source: GptSource; route: Route; model: Model<Api>; models: Model<Api>[]; }
export interface GptStatus {
  name: "gpt"; connected: boolean; capabilities: string[]; models?: string[]; defaultModel?: string;
  source?: GptSource; route?: Route; checkedAt?: string; lastError?: string;
}
interface LoginState { phase: "idle" | "waiting" | "verifying" | "connected" | "error"; authUrl?: string; needsInput?: boolean; prompt?: string; error?: string; }
export interface GptDeps {
  fetchImpl?: typeof fetch; ownStorage?: CredentialStore; piStorage?: CredentialStore; authDir?: string; piAuthPath?: string;
  /** TEST seam: replaces only Pi's browser callback/token exchange; Models.login persistence stays real. */
  oauthLogin?: OAuthAuth["login"];
}
const NOT_FOUND: Record<GptSource, string> = {
  vivic: "本机没有已保存的 ChatGPT 授权记录（~/.vivic/auth.json）。请点击 Continue with ChatGPT 重新授权。",
  pi: "未找到本机 Pi 的 ChatGPT（openai / openai-codex）OAuth 登录；可改用 Continue with ChatGPT。",
};

/** Pi handles OAuth, token refresh and model requests. No agent session exists. */
export class GptProvider {
  #deps: GptDeps;
  #connection?: Connection;
  #version = 0;
  #checkedAt?: string;
  #error?: string;
  #login: LoginState = { phase: "idle" };
  #loginAbort?: AbortController;
  #input?: { resolve: (value: string) => void; reject: () => void; };
  #requests = new Set<AbortController>();
  #lastTraffic = 0;
  constructor(deps: GptDeps = {}) { this.#deps = deps; }
  status(): GptStatus {
    const c = this.#connection;
    return { name: "gpt", connected: Boolean(c), capabilities: ["chat", "structured", ...(c?.model.input.includes("image") ? ["vision"] : [])],
      ...(c ? { models: c.models.map(model => model.id), defaultModel: c.model.id, source: c.source, route: c.route, checkedAt: this.#checkedAt } : {}),
      ...(this.#error ? { lastError: this.#error } : {}) };
  }
  loginStatus() { return { ...this.#login }; }
  generation() { return this.#version; }
  isCurrent(version: number) { return version === this.#version && Boolean(this.#connection); }
  /**
   * While the Control page is open, keep the tunnel to the inference host
   * open so the next request skips the ~10 s cold proxy handshake. The HEAD
   * carries no credentials and its reply is discarded. The same tick lets Pi
   * renew a token that is about to expire (a no-op otherwise), so a request
   * rarely has to wait for the hourly refresh.
   */
  keepWarm(now = Date.now()) {
    const c = this.#connection;
    if (!c || now - this.#lastTraffic < GPT_KEEP_WARM_MS) return;
    this.#lastTraffic = now;
    void c.runtime.getAuth(c.route, { signal: AbortSignal.timeout(GPT_REFRESH_TIMEOUT_MS + 10_000) }).catch(() => undefined);
    void gptFetch(this.#deps.fetchImpl)(c.route === "openai" ? GPT_MODELS : CODEX_RESPONSES, { method: "HEAD", signal: AbortSignal.timeout(30_000) })
      .then(response => response.body?.cancel(), () => undefined);
  }
  async #storage(source: GptSource): Promise<CredentialStore> {
    if (source === "vivic") return this.#deps.ownStorage ?? (await loadStorage()).AuthStorage.create(join(this.#deps.authDir ?? join(homedir(), ".vivic"), "auth.json"));
    if (this.#deps.piStorage) return this.#deps.piStorage;
    const path = this.#deps.piAuthPath ?? join(homedir(), ".pi", "agent", "auth.json");
    if (!existsSync(path)) throw new Error("Pi login not found");
    return (await loadStorage()).AuthStorage.create(path);
  }
  #invalidate() {
    this.#version++;
    this.#connection = undefined;
    for (const request of this.#requests) request.abort();
    this.#requests.clear();
  }
  async connect(source: GptSource, requestedModel?: string): Promise<boolean> {
    this.cancelLogin();
    return this.#connect(source, requestedModel);
  }
  /** Does not touch login state, so a finished login stays "verifying" until the probe settles. */
  async #connect(source: GptSource, requestedModel?: string): Promise<boolean> {
    this.#invalidate(); this.#error = undefined;
    const version = this.#version;
    const controller = new AbortController(); this.#requests.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(GPT_CONNECT_TIMEOUT_MS)]);
    const deadline = Date.now() + GPT_CONNECT_TIMEOUT_MS;
    let phase = source === "pi" ? "读取 Pi 登录" : "读取本机 GPT 授权";
    let httpStatus: number | undefined;
    let detail: string | undefined;
    try {
      let storage: CredentialStore, models: Runtime, route: Route | undefined;
      try {
        storage = await this.#storage(source);
        models = runtime(storage);
        route = (await Promise.all(routes.map(async name => ({ name, value: await models.checkAuth(name, { signal }) })))).find(item => item.value?.type === "oauth")?.name;
      } catch (error) {
        if (!signal.aborted) detail = error instanceof Error && error.message === "Pi login not found" ? NOT_FOUND[source]
          : "授权文件无法读取或格式无效；Vivic 不会自动清理或覆盖它。";
        throw error;
      }
      if (!route) { detail = NOT_FOUND[source]; throw new Error("Pi login not found"); }
      phase = "刷新 GPT 授权";
      let available = [...await models.getAvailable(route, { signal })];
      if (route === "openai") {
        const auth = await models.getAuth(route, { signal }).catch(error => {
          if (!signal.aborted) detail = tokenEndpointFailure(error, "刷新令牌") ?? "已保存的授权无法刷新，可能已被撤销或过期，请重新登录。";
          throw error;
        });
        if (!auth?.auth.apiKey) throw new Error("GPT not authorized");
        phase = "读取 GPT 模型目录";
        const getCatalog = async () => {
          for (let attempt = 0; ; attempt++) {
            try {
              const result = await gptFetch(this.#deps.fetchImpl, status => { httpStatus = status; })(GPT_MODELS, { headers: { authorization: `Bearer ${auth.auth.apiKey}` }, signal });
              if (attempt === 0 && [502, 503, 504].includes(result.status)) { void result.body?.cancel(); continue; }
              return result;
            } catch (error) {
              if (attempt > 0 || signal.aborted || error instanceof GptTransportError) throw error;
              // One retry for this read-only catalog only, sharing the existing
              // deadline. Model inference is never automatically duplicated.
            }
          }
        };
        const response = await getCatalog();
        if (!response.ok) {
          const code = await response.json().then(value => (value as { error?: { code?: unknown } })?.error?.code, () => undefined);
          if (code === UNSUPPORTED_REGION) detail = `OpenAI 拒绝了 Vivic 后端当前的网络出口地区（${UNSUPPORTED_REGION}）。`;
          throw new Error("Model catalog unavailable");
        }
        const catalog = z.union([
          z.object({ models: z.array(z.object({ slug: z.string().max(256), visibility: z.string().nullable().optional() })).max(2000) })
            .transform(value => value.models.filter(row => row.visibility === undefined || row.visibility === "list").map(row => row.slug)),
          z.object({ data: z.array(z.object({ id: z.string().max(256) })).max(2000) }).transform(value => value.data.map(row => row.id)),
        ]).safeParse(await response.json());
        if (!catalog.success) throw new Error("Model catalog unavailable");
        available = [...new Set(catalog.data)].filter(name => id.safeParse(name).success && /^(?:gpt-|o[134])/.test(name)
          && !/audio|realtime|tts|transcrib|image|search|embedding|moderation/i.test(name)).map(name => {
          const known = models.getModel(route, name);
          const fallback = available.find(model => model.id === "gpt-6-luna") ?? available[0];
          if (!fallback) throw new Error("Model catalog empty");
          return known ?? { ...fallback, id: name, name, input: ["text"] as ("text" | "image")[] };
        });
      }
      if (!available.length) throw new Error("Model catalog empty");
      const model = requestedModel ? available.find(item => item.id === requestedModel)
        : PREFERRED.map(name => available.find(item => item.id === name)).find(Boolean) ?? available[0];
      if (!model) throw new Error("Requested model unavailable");
      const connection: Connection = { runtime: models, storage, route, source, model, models: available };
      phase = "验证 GPT 推理"; httpStatus = undefined;
      const probe = await this.#completeWithRetry(connection, [{ role: "system", content: '只输出JSON {"ok":true}。' }, { role: "user", content: "测试连接" }], signal, deadline);
      if (!probe.ok) { httpStatus = probe.status; detail = probe.error; throw new Error("GPT inference unavailable"); }
      if ((probe.value as { ok?: boolean })?.ok !== true) throw new Error("GPT inference unavailable");
      signal.throwIfAborted();
      if (version !== this.#version) return false;
      this.#connection = connection; this.#checkedAt = new Date().toISOString(); this.#lastTraffic = Date.now();
      return true;
    } catch {
      if (version === this.#version) this.#error = `${phase}失败${httpStatus ? `（HTTP ${httpStatus}）` : ""}。${detail ?? `请检查${source === "pi" ? " Pi 登录、" : ""}账号模型权限与套餐额度；也可重新登录。`}`;
      return false;
    } finally { this.#requests.delete(controller); }
  }
  /**
   * A dropped tunnel, a stream cut short or a 429/5xx leaves no usable reply,
   * so one more attempt inside the same deadline costs nothing the user would
   * miss. Invalid JSON and other refusals are never retried here.
   */
  async #completeWithRetry(connection: Connection, messages: ChatMessage[], signal: AbortSignal, deadline: number): Promise<StepfunResult<unknown>> {
    const first = await this.#complete(connection, messages, signal);
    if (first.ok || first.code !== "network" || signal.aborted || Date.now() > deadline - GPT_RETRY_MIN_REMAINING_MS) return first;
    try { await delay(GPT_RETRY_DELAY_MS, undefined, { signal }); } catch { return first; }
    return this.#complete(connection, messages, signal);
  }
  async #complete(connection: Connection, messages: ChatMessage[], signal: AbortSignal): Promise<StepfunResult<unknown>> {
    let completed = false;
    let httpStatus: number | undefined;
    let text: string;
    try {
      this.#lastTraffic = Date.now();
      const result = await connection.runtime.complete(connection.model, { messages: messages.map(message => message.role === "user" ? {
        role: "user" as const, timestamp: Date.now(), content: message.images?.length
          ? [{ type: "text" as const, text: message.content }, ...message.images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mime }))]
          : message.content,
      } : { role: "system" as const, content: message.content, timestamp: Date.now() }) }, {
        signal, timeoutMs: 45_000, maxRetries: 0, fetch: gptFetch(this.#deps.fetchImpl, status => { httpStatus = status; }),
        onPayload(payload) {
          const value = { ...(payload as Record<string, unknown>), store: false, stream: true };
          for (const key of ["tools", "tool_choice", "max_output_tokens", "temperature", "top_p", "metadata", "background", "previous_response_id", "conversation", "prompt_cache_retention", "safety_identifier"]) delete (value as Record<string, unknown>)[key];
          return { ...value, text: { format: { type: "json_object" } } };
        },
        onProviderStreamEvent(event) {
          if (event && typeof event === "object" && "type" in event && event.type === "response.completed" && "response" in event && event.response && typeof event.response === "object") {
            completed = "status" in event.response && event.response.status === "completed" && !("error" in event.response && event.response.error);
          }
        },
        ...(connection.route === "openai-codex" ? { transport: "sse" as const } : {}),
      });
      signal.throwIfAborted();
      if (!completed || result.stopReason !== "stop") {
        // No response at all, a retryable status, or a 200 stream that broke off.
        const transient = httpStatus === undefined || RETRYABLE_STATUS.has(httpStatus) || (httpStatus === 200 && result.stopReason === "error");
        return { ok: false, code: transient ? "network" : "provider", status: httpStatus,
          error: transient && !RETRYABLE_STATUS.has(httpStatus ?? 0) ? "GPT 网络连接中断，未得到完整结果" : "GPT 未完整完成推理，请检查登录或额度后重试" };
      }
      text = result.content.filter(part => part.type === "text").map(part => part.text).join("");
    } catch {
      return signal.aborted ? { ok: false, code: "cancelled", error: "GPT 请求已取消或超时" }
        : { ok: false, code: "network", status: httpStatus, error: "GPT 网络连接中断，未得到完整结果" };
    }
    try { return { ok: true, value: JSON.parse(text) as unknown }; }
    catch { return { ok: false, code: "invalid-response", error: "GPT 未返回可验证的 JSON 结果" }; }
  }
  async generate(messages: ChatMessage[], parent?: AbortSignal): Promise<StepfunResult<unknown>> {
    const c = this.#connection; if (!c) return { ok: false, code: "provider", error: "GPT 未连接" };
    const version = this.#version; const controller = new AbortController(); this.#requests.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(GPT_REQUEST_TIMEOUT_MS), ...(parent ? [parent] : [])]);
    try {
      const result = await this.#completeWithRetry(c, messages, signal, Date.now() + GPT_REQUEST_TIMEOUT_MS);
      return this.isCurrent(version) ? result : { ok: false, code: "cancelled", error: "GPT 连接已变更，旧结果已丢弃" };
    } finally { this.#requests.delete(controller); }
  }
  /** Auth remains private; supplied work must call a fixed provider endpoint. */
  async withSearchAuth<T>(work: (input: { url: string; apiKey: string; model: string; headers: Record<string, string> }) => Promise<T>, signal: AbortSignal): Promise<T> {
    const c = this.#connection; const version = this.#version;
    if (!c) throw new Error("GPT disconnected");
    const auth = await c.runtime.getAuth(c.model, { signal });
    if (!auth?.auth.apiKey) throw new Error("GPT disconnected");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(auth.auth.headers ?? {})) if (typeof value === "string") headers[key] = value;
    if (c.route === "openai-codex") {
      // Same auth claim/header mapping used by Pi and pi-web-access. This only
      // routes an already validated Pi credential; it is not JWT verification.
      const claims = JSON.parse(Buffer.from(auth.auth.apiKey.split(".")[1] ?? "", "base64url").toString("utf8"));
      const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
      if (typeof accountId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(accountId)) throw new Error("Missing GPT account claim");
      headers["chatgpt-account-id"] = accountId;
      headers["OpenAI-Beta"] = "responses=experimental";
      headers.originator = "pi";
    }
    const result = await work({ url: c.route === "openai" ? GPT_RESPONSES : CODEX_RESPONSES,
      apiKey: auth.auth.apiKey, model: c.model.id, headers });
    if (!this.isCurrent(version)) throw new Error("GPT connection changed");
    return result;
  }
  async startLogin() {
    this.cancelLogin(); this.#invalidate(); this.#error = undefined;
    const controller = new AbortController(); this.#loginAbort = controller;
    const version = this.#version;
    this.#login = { phase: "waiting" };
    let models: Runtime;
    try { models = runtime(await this.#storage("vivic"), this.#deps.oauthLogin); } catch {
      if (version === this.#version) { this.#loginAbort = undefined; this.#login = { phase: "error", error: "无法打开本机授权存储（~/.vivic/auth.json），未开始授权。请检查该文件权限后重试。" }; }
      return this.loginStatus();
    }
    // The browser "Authentication successful" page appears once the callback
    // arrives, before the backend exchanges the code; track the real stage.
    let stage: LoginStage = "start";
    const timeout = AbortSignal.timeout(300_000);
    const notify = (event: AuthEvent) => {
      if (version !== this.#version) return;
      if (event.type === "auth_url") {
        const url = new URL(event.url);
        if (url.origin !== "https://auth.openai.com") { controller.abort(); return; }
        stage = "browser";
        this.#login = { ...this.#login, authUrl: url.href };
      }
      if (event.type === "progress" && stage === "browser") stage = "exchange";
    };
    void models.login("openai", "oauth", {
      signal: AbortSignal.any([controller.signal, timeout]), notify,
      prompt: (prompt: AuthPrompt) => new Promise<string>((resolve, reject) => {
        if (prompt.type !== "manual_code") { reject(new Error("Unexpected OAuth prompt")); return; }
        const signal = AbortSignal.any([controller.signal, ...(prompt.signal ? [prompt.signal] : [])]);
        // A superseded login must never clear the input slot of a newer one.
        const settle = () => { signal.removeEventListener("abort", abort); if (this.#input === entry) this.#input = undefined; };
        const abort = () => { settle(); reject(new Error("Login cancelled")); };
        const entry = { resolve: (value: string) => { settle(); resolve(value); }, reject: abort };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted || version !== this.#version) { abort(); return; }
        this.#login = { ...this.#login, needsInput: true, prompt: "在浏览器完成授权；若未自动返回，可粘贴完整回调地址。" };
        this.#input = entry;
      }),
    }, { agentName: "Vivic", getDeviceId: () => {
      const dir = this.#deps.authDir ?? join(homedir(), ".vivic"); mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, "device-id");
      const current = existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
      if (current && z.uuid().safeParse(current).success) return current;
      const value = randomUUID(); writeFileSync(path, value, { mode: 0o600 }); return value;
    } }).then(async () => {
      if (version !== this.#version || controller.signal.aborted) return;
      // Saved credentials only prove authorization; connected requires a real probe.
      const verifying: LoginState = { phase: "verifying" };
      this.#loginAbort = undefined; this.#login = verifying;
      const ok = await this.#connect("vivic");
      if (this.#login === verifying) this.#login = ok ? { phase: "connected" } : { phase: "error", error: this.#error };
    }, error => {
      if (version === this.#version && !controller.signal.aborted) {
        this.#loginAbort = undefined;
        this.#login = { phase: "error", error: loginFailure(error, stage, timeout.aborted) };
      }
    });
    return this.loginStatus();
  }
  provideLoginInput(value: string) { if (!this.#input) return false; this.#input.resolve(value); this.#login = { ...this.#login, needsInput: false }; return true; }
  cancelLogin() {
    // Cancelling during verification must not let that probe connect afterwards.
    if (this.#login.phase === "verifying") this.#invalidate();
    this.#loginAbort?.abort(); this.#loginAbort = undefined; this.#input?.reject(); this.#input = undefined; this.#login = { phase: "idle" };
  }
  async disconnect() {
    const c = this.#connection; this.cancelLogin(); this.#invalidate(); this.#error = undefined;
    // Disconnecting a reused Pi login must not sign the user's Pi CLI out.
    if (c?.source === "vivic") await c.storage.delete(c.route);
  }
  /** End this process/session's work without deleting the user's saved OAuth. */
  dispose() {
    this.cancelLogin(); this.#invalidate(); this.#error = undefined;
  }
}
