import { Hono } from "hono";
import type { LocalApiConfig } from "./config.js";
import type { CredentialStore } from "./credentials.js";
import { AsrAudioError, extractAsrPcm, MAX_ASR_FILE_BYTES } from "./asrAudio.js";

export const ASR_MODEL = "stepaudio-2.5-asr";
export const ASR_TIMEOUT_MS = 30_000;
/** File limit plus a small fixed multipart framing allowance. */
export const ASR_BODY_LIMIT_BYTES = MAX_ASR_FILE_BYTES + 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const PLAN_BASE = "https://api.stepfun.com/step_plan/v1";

export interface AsrDeps {
  config: LocalApiConfig & { asrTimeoutMs?: number };
  credentials: CredentialStore;
  fetchImpl?: typeof fetch;
}

class AsrFailure extends Error {
  readonly status: 400 | 413 | 415 | 502 | 503 | 504;
  readonly code: string;
  constructor(status: AsrFailure["status"], code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Also bounds injected transports and parsers that do not themselves honor signals. */
const abortable = <T>(task: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  if (signal.aborted) abort();
});

const cancelBody = (body: ReadableStream | null) => { void body?.cancel().catch(() => {}); };

/** Incremental byte limit works without Content-Length; abort cancels blocked reads. */
const readChunks = async (
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  maxBytes: number,
  onChunk: (chunk: Uint8Array, done: boolean) => boolean | void,
  tooLarge: AsrFailure,
) => {
  if (!body) throw new AsrFailure(400, "asr-empty-input", "没有收到音频文件。");
  const reader = body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      size += value?.byteLength ?? 0;
      if (size > maxBytes) throw tooLarge;
      if (onChunk(value ?? new Uint8Array(), done) || done) break;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    // Never let a broken transport's cancel promise hold the response open.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};

const invalidResponse = () => new AsrFailure(502, "asr-invalid-response", "识别服务未返回有效的最终文字，请重新录音；未执行任何指令。");

const readTranscript = async (response: Response, signal: AbortSignal): Promise<string> => {
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream" || !response.body) {
    cancelBody(response.body);
    throw invalidResponse();
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let data: string[] = [];
  let text: string | undefined;
  const dispatch = () => {
    if (!data.length) return;
    const raw = data.join("\n");
    data = [];
    let event: unknown;
    try { event = JSON.parse(raw); } catch { throw invalidResponse(); }
    if (!event || typeof event !== "object" || !("type" in event)) throw invalidResponse();
    if (event.type === "error") throw new AsrFailure(503, "asr-upstream-error", "Plan 语音识别失败，请检查套餐权限或额度后重试；未执行任何指令。");
    if (event.type === "transcript.text.delta") {
      if (!("delta" in event) || typeof event.delta !== "string") throw invalidResponse();
    } else if (event.type === "transcript.text.done") {
      if (!("text" in event) || typeof event.text !== "string") throw invalidResponse();
      const finalText = event.text.trim();
      if (!finalText || !/[^\p{C}\p{Z}\s]/u.test(finalText)) {
        throw new AsrFailure(502, "asr-empty-text", "没有识别到有效文字，请靠近麦克风重新录音；未执行任何指令。");
      }
      if (finalText.length > 500) throw new AsrFailure(502, "asr-text-too-long", "识别文字超过 500 字符，请分段录音；未执行任何指令。");
      if (/[\p{Cc}\p{Cf}]/u.test(finalText)) throw invalidResponse();
      text = finalText;
    } else throw invalidResponse();
  };
  await readChunks(response.body, signal, MAX_RESPONSE_BYTES, (chunk, eof) => {
    pending += decoder.decode(chunk, { stream: !eof });
    // SSE line endings may be LF, CRLF or CR, even split across network chunks.
    for (;;) {
      const match = /[\r\n]/.exec(pending);
      if (!match || (!eof && match.index === pending.length - 1 && match[0] === "\r")) break;
      const line = pending.slice(0, match.index);
      const width = pending.slice(match.index, match.index + 2) === "\r\n" ? 2 : 1;
      pending = pending.slice(match.index + width);
      if (!line) dispatch();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      if (text !== undefined) return true;
    }
    // An incomplete SSE event at EOF is not a successful final transcript.
    if (eof && text === undefined) throw invalidResponse();
  }, new AsrFailure(502, "asr-response-too-large", "识别服务响应过大，请重新录音；未执行任何指令。"));
  if (text === undefined) throw invalidResponse();
  return text;
};

/** Mount under /api after the existing session-auth/origin middleware. No intent execution. */
export const createAsrRoutes = ({ config, credentials, fetchImpl = fetch }: AsrDeps) => {
  const routes = new Hono();
  routes.post("/transcribe", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    const credential = credentials.getSecret();
    const deadline = new AbortController();
    const configured = config.asrTimeoutMs;
    const timeout = typeof configured === "number" && Number.isFinite(configured) && configured >= 1
      ? Math.min(Math.floor(configured), 90_000) : ASR_TIMEOUT_MS;
    const timer = setTimeout(() => deadline.abort(new DOMException("ASR deadline", "TimeoutError")), timeout);
    const signal = AbortSignal.any([deadline.signal, c.req.raw.signal]);
    let upstreamResponse: Response | undefined;
    try {
      signal.throwIfAborted();
      if (!credential) throw new AsrFailure(503, "asr-disconnected", "请先连接 StepFun Plan Key，再进行语音识别。");
      // Exact allowlist: no proxy, ordinary billing base, redirects or alternate provider.
      if (config.stepfunBaseUrl.replace(/\/+$/, "") !== PLAN_BASE) {
        throw new AsrFailure(503, "asr-plan-required", "识别不可用：必须使用官方 StepFun Plan 地址，不会切换按量计费接口。");
      }
      if (new URL(c.req.url).search) throw new AsrFailure(400, "asr-invalid-input", "识别接口不接受 URL 查询参数，仅接受一个 file 音频字段。");
      const contentType = c.req.header("content-type") ?? "";
      if (contentType.split(";")[0]?.trim().toLowerCase() !== "multipart/form-data") {
        throw new AsrFailure(415, "asr-invalid-input", "请使用 multipart/form-data 上传单个 file WAV 音频文件。");
      }
      const tooLarge = new AsrFailure(413, "asr-input-too-large", "音频文件最多 5 MiB，multipart 请求体超限；请缩短录音。");
      if (Number(c.req.header("content-length") ?? 0) > ASR_BODY_LIMIT_BYTES) {
        cancelBody(c.req.raw.body);
        throw tooLarge;
      }
      const chunks: Uint8Array[] = [];
      await readChunks(c.req.raw.body, signal, ASR_BODY_LIMIT_BYTES, (chunk) => { chunks.push(chunk); }, tooLarge);
      const body = Buffer.concat(chunks);
      let form: FormData;
      try {
        form = await abortable(new Response(body, { headers: { "content-type": contentType } }).formData(), signal);
      } catch {
        signal.throwIfAborted();
        throw new AsrFailure(400, "asr-invalid-input", "无法解析 multipart 音频文件，请重新录音上传。");
      }
      const fields = [...form.entries()];
      if (fields.length !== 1 || fields[0][0] !== "file" || typeof fields[0][1] === "string") {
        throw new AsrFailure(400, "asr-invalid-input", "仅允许一个 file 文件字段，不接受 URL、路径、prompt 或任何 API 参数。");
      }
      const file = fields[0][1];
      if (!file.size) throw new AsrFailure(400, "asr-empty-input", "录音文件为空，请重新录音。");
      if (file.size > MAX_ASR_FILE_BYTES) throw tooLarge;
      if (!["audio/wav", "audio/wave", "audio/x-wav"].includes(file.type.toLowerCase())) {
        throw new AsrFailure(415, "asr-unsupported-audio", "仅支持 PCM WAV 音频，请由浏览器采集并封装 16kHz 单声道 16bit WAV。");
      }
      const pcm = extractAsrPcm(new Uint8Array(await abortable(file.arrayBuffer(), signal)));
      signal.throwIfAborted();
      if (credentials.getSecret() !== credential) throw new AsrFailure(503, "asr-disconnected", "识别已取消：模型连接已变更，请重新录音。");
      const request = fetchImpl(`${PLAN_BASE}/audio/asr/sse`, {
        method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${credential.apiKey}`, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ audio: {
          data: Buffer.from(pcm).toString("base64"),
          input: {
            transcription: { model: ASR_MODEL, language: "zh", enable_itn: true },
            format: { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 },
          },
        } }),
      });
      void request.then((response) => { if (signal.aborted) cancelBody(response.body); }, () => {});
      const response = await abortable(request, signal);
      upstreamResponse = response;
      signal.throwIfAborted();
      if (!response.ok) {
        cancelBody(response.body);
        throw new AsrFailure(503, "asr-unavailable", `Plan 识别请求被拒绝（HTTP ${response.status}），请检查套餐权限或额度；不会切换计费接口。`);
      }
      const text = await readTranscript(response, signal);
      signal.throwIfAborted();
      if (credentials.getSecret() !== credential) throw new AsrFailure(503, "asr-disconnected", "识别已取消：模型连接已变更，旧转写已丢弃。");
      return c.json({ ok: true, text });
    } catch (error) {
      let failure: AsrFailure;
      if (credentials.getSecret() !== credential) {
        failure = new AsrFailure(503, "asr-disconnected", "识别已取消：模型连接已变更，旧转写已丢弃。");
      } else if (signal.aborted) {
        failure = deadline.signal.aborted
          ? new AsrFailure(504, "asr-timeout", "语音识别超时，请重新录音重试；未执行任何指令。")
          : new AsrFailure(503, "asr-cancelled", "语音识别请求已取消，旧转写已丢弃。");
      } else if (error instanceof AsrFailure) failure = error;
      else if (error instanceof AsrAudioError) failure = new AsrFailure(400, "asr-invalid-audio", error.message);
      else failure = new AsrFailure(503, "asr-unavailable", "语音识别不可用：网络或响应读取失败，请重试；未执行任何指令。");
      // No upstream body, exception detail, audio, filename or key is serialized/logged.
      return c.json({ ok: false, code: failure.code, error: failure.message }, failure.status);
    } finally {
      clearTimeout(timer);
      cancelBody(upstreamResponse?.body ?? null);
    }
  });
  return routes;
};
