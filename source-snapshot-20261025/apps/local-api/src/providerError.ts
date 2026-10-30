/** Bounded provider diagnostics: never forward headers, HTML or raw bodies. */
export const describeProviderError = async (
  response: Response,
  apiKey: string,
): Promise<string> => {
  const sanitize = (text: string, max: number): string => text
    .split(apiKey).join("[已隐藏]")
    .replace(/Bearer\s+[^\s"'<>;,]+/gi, "Bearer [已隐藏]")
    .replace(/\bsk-[A-Za-z0-9_-]+/gi, "[已隐藏]")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ").trim().slice(0, max);
  const parts = [`模型服务返回 HTTP ${response.status}`];
  let body: unknown;
  // Read a small prefix only, including when Content-Length is missing.
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 8192) break;
        chunks.push(next.value);
      }
      if (bytes <= 8192) {
        const buffer = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
        body = JSON.parse(new TextDecoder().decode(buffer));
      }
    } catch {
      // Non-JSON proxy pages and unreadable error bodies are not displayed.
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const root = body as Record<string, unknown>;
    const error = root.error && typeof root.error === "object" && !Array.isArray(root.error)
      ? root.error as Record<string, unknown> : root;
    if (typeof error.code === "string") {
      const code = sanitize(error.code, 64);
      if (/^[\w.-]+$/.test(code)) parts.push(`错误码：${code}`);
    }
    if (typeof error.message === "string") {
      const message = sanitize(error.message, 160);
      if (message && !/[<>]/.test(message)) parts.push(`服务端原因：${message}`);
    }
  }
  const trace = response.headers.get("x-trace-id");
  if (trace) {
    const id = sanitize(trace, 80);
    if (/^[\w.-]+$/.test(id)) parts.push(`追踪号：${id}`);
  }
  return parts.join("；");
};

export const providerRecoveryHint = (status?: number): string => {
  if (status === 403) return "请检查该 Key 所属账号的有效 Plan 套餐和模型权限；仅凭 403 不能确定具体原因，断开重连通常不能解决权限拒绝。";
  if (status === 401) return "请检查 API Key 是否正确或已被撤销。";
  if (status === 402) return "请检查 Plan 套餐额度。";
  if (status === 429) return "请检查限流或套餐额度，并稍后重试。";
  return "请根据服务端原因检查连接或稍后重试。";
};
