import type { ModelApiErrorCode, ModelApiFailure } from "./types.js";

const messages: Record<ModelApiErrorCode, string> = {
  "invalid-config": "模型 API 配置无效。",
  "invalid-input": "模型 API 输入格式或长度不符合限制。",
  "not-configured": "尚未连接模型 API。",
  unauthorized: "模型 API 凭据无效或已撤销。",
  forbidden: "模型 API 拒绝访问，请检查权限。",
  busy: "模型 API 正忙，请稍后重试。",
  timeout: "模型 API 请求超时，请稍后重试。",
  cancelled: "模型 API 请求已取消。",
  unavailable: "模型 API 暂不可用。",
  "invalid-response": "模型 API 返回的数据格式不受支持。",
  "protocol-mismatch": "决策模型与协议不匹配：StartLux 4B 只使用原生 state/questions，2B 与 GLiNER 只使用旧 input/labels；未自动切换。",
  "too-large": "模型 API 输入或响应超过大小限制。",
};
export class ModelApiError extends Error {
  readonly code: ModelApiErrorCode;
  readonly status?: number;
  constructor(code: ModelApiErrorCode, status?: number) { super(messages[code]); this.code = code; this.status = status; }
  toFailure(): ModelApiFailure {
    return { code: this.code, message: messages[this.code], ...(this.status === undefined ? {} : { status: this.status }) };
  }
}

export function abortError(signal: AbortSignal): ModelApiError {
  return new ModelApiError(signal.reason instanceof ModelApiError && signal.reason.code === "timeout" ? "timeout" : "cancelled");
}
export function checkSignal(signal: AbortSignal): void { if (signal.aborted) throw abortError(signal); }

/** Also bounds injected fetch/read/token implementations that ignore AbortSignal. */
export function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(abortError(signal)); };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(value => { signal.removeEventListener("abort", onAbort); resolve(value); }, error => {
      signal.removeEventListener("abort", onAbort); reject(error);
    });
    if (signal.aborted) onAbort();
  });
}

export function deadline(timeoutMs: number, caller?: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  // Caller reasons (which may contain secrets, or a TimeoutError of their own) are never forwarded.
  const onAbort = () => controller.abort(new ModelApiError("cancelled"));
  caller?.addEventListener("abort", onAbort, { once: true });
  if (caller?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new ModelApiError("timeout")), timeoutMs);
  return { signal: controller.signal, dispose() { clearTimeout(timer); caller?.removeEventListener("abort", onAbort); } };
}
