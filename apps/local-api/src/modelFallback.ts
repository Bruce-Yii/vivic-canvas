import type { CredentialStore } from "./credentials.js";
import { DeepseekCredentialStore, deepseekChat } from "./deepseek.js";
import { chatJson, type ChatMessage, type StepfunDeps, type StepfunResult } from "./stepfun.js";

/** Pure inference only: the fallback never sees a task ID or a persistence operation. */
export function accountPlanner(options: { credentials: CredentialStore; deepseek: DeepseekCredentialStore;
  stepfun: StepfunDeps; selected: "stepfun" | "deepseek"; isCurrent: () => boolean }) {
  const primary = options.credentials.getSecret(), secondary = options.deepseek.getSecret();
  let used: "stepfun" | "deepseek" = options.selected === "deepseek" || !primary && secondary ? "deepseek" : "stepfun";
  const isCurrent = () => options.isCurrent() && options.credentials.getSecret() === primary && options.deepseek.getSecret() === secondary;
  return {
    get provider() { return used; },
    get model() { return `${primary?.defaultModel ?? "none"}+${secondary?.defaultModel ?? "none"}`; },
    connected: options.selected === "deepseek" ? Boolean(secondary) : Boolean(primary || secondary), isCurrent,
    async generate(messages: ChatMessage[], signal?: AbortSignal, maxTokens = 8192, onTextDelta?: (delta: string) => void): Promise<StepfunResult<unknown>> {
      if (signal?.aborted || !isCurrent()) return { ok: false, code: "cancelled", error: "模型请求已取消或连接已改变" };
      const hasImages = messages.some(message => message.images?.length);
      const primaryCanRead = !hasImages || primary && ["step-3.7-flash", "step-5-preview"].includes(primary.defaultModel);
      if (options.selected === "stepfun" && primary && primaryCanRead) {
        used = "stepfun";
        const result = await chatJson(primary, messages, { ...options.stepfun, signal,
          ...(secondary ? { timeoutMs: Math.min(options.stepfun.timeoutMs ?? 90_000, 30_000), retry: false } : {}) }, { maxTokens, ...(onTextDelta ? { onTextDelta } : {}) });
        if (result.ok || result.code === "cancelled" || signal?.aborted || !secondary || !isCurrent()) return result;
      }
      if (!secondary) return { ok: false, code: "provider", error: "请先连接 StepFun 或 DeepSeek" };
      if (signal?.aborted || !isCurrent()) return { ok: false, code: "cancelled", error: "模型请求已取消或连接已改变" };
      used = "deepseek";
      return deepseekChat(secondary, messages, { fetchImpl: options.stepfun.fetchImpl, timeoutMs: 45_000, signal }, maxTokens);
    },
  };
}
