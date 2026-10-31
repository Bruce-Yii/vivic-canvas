import path from "node:path";
import { z } from "zod";
import { ProviderStore } from "../providers/store.js";
import type { ProviderConfig } from "../providers/types.js";
import { chatJson } from "../stepfun.js";
import { createModelApiClient } from "../modelApi/index.js";
import { SpaceError, type HostedSpaceStore, type SpaceIdentity } from "../space/index.js";
import { hostedBody, hostedJson } from "./http.js";

export const DEMO_MAIN_MODEL = "deepseek-flash";
export const DEMO_DECISION_MODEL = "startlux-decision-4b";
export const DEMO_ASR_MODEL = "stepaudio-2.5-asr";
export const DEMO_TTS_MODEL = "stepaudio-2.5-tts";
export const PLATFORM_PROBE_LABELS = { fit: "在一屏显示全部卡片", focus: "聚焦一张卡片", other: "其他要求" };
const Input = z.strictObject({ provider: z.enum(["deepseek", "stepfun", "vivic"]), apiKey: z.string().trim().min(8).max(512).regex(/^\S+$/) });

export function createFixedSetup(options: { dataDir: string; store: HostedSpaceStore; fetchImpl?: typeof fetch;
  modelApiBaseUrl?: string; allowLoopbackModelApi?: boolean; changed(accountId: string): void }) {
  const active = new Set<string>();
  const providerStore = (accountId: string) => new ProviderStore({ dataDir: path.join(options.dataDir, "account-providers", accountId) });
  function status(accountId: string) {
    const store = providerStore(accountId), main = store.findForRole("main"), asr = store.findForRole("asr"), tts = store.findForRole("tts"), decision = store.findForRole("decision");
    const has = (p?: ProviderConfig) => Boolean(p?.enabled && store.getApiKey(p.id));
    const deepseek = Boolean(has(main) && new URL(main!.baseUrl).hostname === "api.deepseek.com" && main!.model === DEMO_MAIN_MODEL);
    const stepfun = Boolean(has(asr) && has(tts) && asr?.protocol === "stepfun-v1" && tts?.protocol === "stepfun-v1"
      && asr?.baseUrl === "https://api.stepfun.com/v1" && tts?.baseUrl === "https://api.stepfun.com/v1"
      && asr.model === DEMO_ASR_MODEL && tts.model === DEMO_TTS_MODEL);
    const vivic = Boolean(has(decision) && decision?.model === DEMO_DECISION_MODEL);
    return { ready: deepseek && stepfun && vivic, providers: [
      { id: "deepseek", name: "DeepSeek", role: "内容生成", configured: deepseek, model: DEMO_MAIN_MODEL },
      { id: "stepfun", name: "StepFun", role: "语音识别与朗读", configured: stepfun, model: `${DEMO_ASR_MODEL} / ${DEMO_TTS_MODEL}` },
      { id: "vivic", name: "Vivic API", role: "决策模型", configured: vivic, model: DEMO_DECISION_MODEL },
    ] };
  }
  async function connect(identity: SpaceIdentity, input: z.infer<typeof Input>, signal: AbortSignal) {
    const { accountId, device } = identity;
    if (active.has(accountId)) throw new SpaceError(409, "setup-busy", "正在保存连接，请稍后重试。");
    active.add(accountId);
    try {
      const fetchImpl = options.fetchImpl ?? fetch;
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      if (input.provider === "deepseek") {
        const result = await chatJson({ apiKey: input.apiKey, defaultModel: DEMO_MAIN_MODEL, models: [DEMO_MAIN_MODEL], checkedAt: new Date().toISOString() },
          [{ role: "user", content: '只输出JSON：{"ok":true}' }], { baseUrl: "https://api.deepseek.com/v1", provider: "deepseek", fetchImpl, timeoutMs: 15_000, signal: bounded, retry: false }, { maxTokens: 128 });
        if (!result.ok) throw new SpaceError(400, "deepseek-check-failed", "DeepSeek 验证失败，请检查普通 API Key、余额与连接后重试。");
      } else if (input.provider === "stepfun") {
        // Probe the actual speech endpoint, never a Coding Plan chat route or model catalog.
        const response = await fetchImpl("https://api.stepfun.com/v1/audio/speech", { method: "POST", redirect: "error", signal: bounded,
          headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: DEMO_TTS_MODEL, input: "你好", voice: "wenrounvsheng", response_format: "mp3" }) });
        if (!response.ok || !(response.headers.get("content-type") ?? "").includes("audio/")) {
          await response.body?.cancel();
          throw new SpaceError(400, "stepfun-check-failed", "StepFun 语音验证失败，请使用普通 API Key；Coding Plan 不支持此语音连接。");
        }
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength < 16 || bytes.byteLength > 2_000_000) throw new SpaceError(400, "stepfun-check-failed", "StepFun 未返回有效语音，请检查 Key 后重试。");
      } else {
        const client = createModelApiClient({ baseUrl: options.modelApiBaseUrl ?? "https://edsionc.top/api/v1", getToken: () => input.apiKey,
          fetchImpl, timeoutMs: 15_000, allowLoopbackHttp: options.allowLoopbackModelApi });
        const result = await client.classify("请把所有卡片显示在一屏里", { model: DEMO_DECISION_MODEL, labels: PLATFORM_PROBE_LABELS, signal: bounded });
        if (!result.ok) throw new SpaceError(400, "vivic-check-failed", "Vivic 决策验证失败，请使用拥有决策模型权限的平台 Key。");
      }
      signal.throwIfAborted(); options.store.assertDeviceActive(accountId, device.id);
      const store = providerStore(accountId);
      const upsert = (name: string, role: "main" | "asr" | "tts" | "decision", baseUrl: string, model: string, protocol: "stepfun-v1" | "openai-compatible" | "startlux-native") => {
        const previous = store.list().find(p => p.roles.length === 1 && p.roles[0] === role && (role !== "main" || new URL(p.baseUrl).hostname === "api.deepseek.com"));
        const config = { name, roles: [role], baseUrl, model, protocol, apiKey: input.apiKey, enabled: true };
        const saved = previous ? store.update(previous.id, config) : store.create(config);
        return saved.id;
      };
      const ids: string[] = [];
      if (input.provider === "deepseek") {
        for (const p of store.list()) if (p.roles.includes("main")) store.update(p.id, { enabled: false });
        ids.push(upsert("DeepSeek", "main", "https://api.deepseek.com/v1", DEMO_MAIN_MODEL, "openai-compatible"));
      } else if (input.provider === "stepfun") {
        ids.push(upsert("StepFun ASR", "asr", "https://api.stepfun.com/v1", DEMO_ASR_MODEL, "stepfun-v1"));
        ids.push(upsert("StepFun TTS", "tts", "https://api.stepfun.com/v1", DEMO_TTS_MODEL, "stepfun-v1"));
      } else ids.push(upsert("Vivic API", "decision", options.modelApiBaseUrl ?? "https://edsionc.top/api/v1", DEMO_DECISION_MODEL, "startlux-native"));
      // Do not report persistence success when the filesystem rejected a write.
      const reloaded = providerStore(accountId);
      if (ids.some(id => reloaded.getApiKey(id) !== input.apiKey || !reloaded.get(id)?.enabled)) throw new SpaceError(503, "setup-save-failed", "连接已验证，但配置尚未保存，请保留本页后重试。");
      options.changed(accountId);
      return status(accountId);
    } finally { active.delete(accountId); }
  }
  return { providerStore, status, connect, async handle(request: Request, identity: SpaceIdentity) {
    const route = new URL(request.url).pathname;
    if (route === "/api/setup/status" && request.method === "GET") return hostedJson(status(identity.accountId));
    if (route === "/api/setup/connect" && request.method === "POST") {
      const parsed = Input.safeParse(await hostedBody(request, 4096));
      if (!parsed.success) throw new SpaceError(400, "invalid-setup", "请填写所选服务的有效 API Key。");
      return hostedJson(await connect(identity, parsed.data, request.signal));
    }
    return null;
  } };
}
