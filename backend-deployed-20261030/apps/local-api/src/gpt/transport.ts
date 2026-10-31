/** Fixed provider endpoints, bounded bodies and no redirected credentials. */
export const GPT_RESPONSES = "https://api.openai.com/v1/responses";
export const CODEX_RESPONSES = "https://chatgpt.com/backend-api/codex/responses";
export const GPT_MODELS = "https://api.openai.com/v1/models";
const ALLOWED = new Set([GPT_RESPONSES, CODEX_RESPONSES, GPT_MODELS]);
export const MAX_GPT_RESPONSE_BYTES = 512 * 1024;
// The account catalog includes provider-owned base instructions for each model;
// these fields are ignored, but nine real entries already exceed the SSE cap.
const MAX_GPT_CATALOG_BYTES = 4 * 1024 * 1024;
export class GptTransportError extends Error {}

export function gptFetch(fetchImpl: typeof fetch = fetch, onStatus?: (status: number) => void): typeof fetch {
  return async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    if (!ALLOWED.has(raw)) throw new GptTransportError("Unsupported GPT endpoint");
    const maxBytes = raw === GPT_MODELS ? MAX_GPT_CATALOG_BYTES : MAX_GPT_RESPONSE_BYTES;
    const response = await fetchImpl(input, { ...init, redirect: "error", credentials: "omit" });
    onStatus?.(response.status);
    if (response.redirected || (response.url && response.url !== raw)) {
      void response.body?.cancel(); throw new GptTransportError("Unexpected GPT redirect");
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > maxBytes) { void response.body?.cancel(); throw new GptTransportError("GPT response too large"); }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { reader.releaseLock(); controller.close(); return; }
          bytes += next.value.byteLength;
          if (bytes > maxBytes) throw new Error("GPT response too large");
          controller.enqueue(next.value);
        } catch {
          void reader.cancel().catch(() => {});
          controller.error(new Error("GPT response unavailable"));
        }
      },
      cancel() { return reader.cancel(); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** Completed Responses frames only: partial output is never executable. */
export async function completedResponse(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  // The real subscription Responses route can omit Content-Type. Require a
  // validated completed SSE frame rather than rejecting that valid response.
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!response.ok || !response.body || (contentType && contentType !== "text/event-stream")) {
    void response.body?.cancel(); throw new Error("GPT search unavailable");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let size = 0;
  const doneItems: Record<string, unknown>[] = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_GPT_RESPONSE_BYTES) throw new Error("GPT search response too large");
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      for (;;) {
        const at = buffer.indexOf("\n\n");
        if (at < 0) break;
        const event = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        const value: unknown = JSON.parse(data);
        if (!value || typeof value !== "object" || !("type" in value)) continue;
        if (value.type === "response.output_item.done" && "item" in value && value.item && typeof value.item === "object") {
          if (doneItems.length >= 100) throw new Error("GPT search has too many output items");
          doneItems.push(value.item as Record<string, unknown>);
        }
        if (["error", "response.failed", "response.incomplete"].includes(String(value.type))) throw new Error("GPT search did not complete");
        if (value.type === "response.completed" && "response" in value && value.response && typeof value.response === "object") {
          if (!("status" in value.response) || value.response.status !== "completed" || ("error" in value.response && value.response.error)) throw new Error("GPT response did not complete");
          const completed = value.response as Record<string, unknown>;
          // Migrated pi-web-access behavior: subscription streams can keep the
          // terminal output array empty and send full items only in done frames.
          return { ...completed, output: Array.isArray(completed.output) && completed.output.length ? completed.output : doneItems };
        }
      }
    }
    throw new Error("GPT search stream ended without completion");
  } finally { signal.removeEventListener("abort", abort); void reader.cancel().catch(() => {}); }
}
