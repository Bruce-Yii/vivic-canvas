import type { StepfunCredential } from "./credentials.js";
import type { StepfunDeps } from "./stepfun.js";
import { DEFAULT_SPEECH_SPEED, DEFAULT_SPEECH_VOICE, type SpeechOptions } from "./voices.js";
import { readSpeechStream } from "./speechStream.js";
import type { SpeechWord } from "@vivic/contracts";

export const SPEECH_MODEL = "stepaudio-2.5-tts";
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

type SpeechResult =
  | { ok: true; audio: Uint8Array<ArrayBuffer>; words?: SpeechWord[] }
  | { ok: false; status: 502 | 503 | 504; code: string; error: string };

/** One Plan request, no retries, redirects, alternate models or billing routes. */
export const synthesizeSpeech = async (
  credential: StepfunCredential,
  text: string,
  deps: StepfunDeps,
  signal?: AbortSignal,
  options: SpeechOptions = {},
): Promise<SpeechResult> => {
  const base = deps.baseUrl.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return { ok: false, status: 503, code: "speech-plan-required", error: "语音不可用：后端 Plan 地址配置无效。" };
  }
  // Prevent an accidental ordinary StepFun base override from billing TTS.
  if ((url.hostname === "api.stepfun.com" || url.hostname === "api.stepfun.ai") &&
      (url.protocol !== "https:" || url.pathname !== "/step_plan/v1" || url.search || url.hash || url.username || url.password)) {
    return {
      ok: false, status: 503, code: "speech-plan-required",
      error: "语音不可用：必须使用 StepFun Plan 地址，不会切换按量计费接口。",
    };
  }
  const requestSignal = AbortSignal.any([
    AbortSignal.timeout(deps.timeoutMs ?? 15000),
    ...(signal ? [signal] : []),
  ]);
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${base}/audio/speech`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.apiKey}`,
        "content-type": "application/json",
        accept: options.timestamps ? "text/event-stream, audio/mpeg" : "audio/mpeg",
      },
      body: JSON.stringify({
        model: SPEECH_MODEL, input: text, voice: options.voice ?? DEFAULT_SPEECH_VOICE,
        response_format: "mp3", speed: options.speed ?? DEFAULT_SPEECH_SPEED,
        ...(options.timestamps ? { timestamp: true, stream_format: "sse" } : {}),
      }),
      redirect: "error",
      signal: requestSignal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return {
        ok: false, status: 503, code: "speech-unavailable",
        error: `语音不可用：Plan 语音请求被拒绝（HTTP ${res.status}），请检查套餐权限或额度；不会切换计费接口。`,
      };
    }
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (options.timestamps && mime === "text/event-stream") {
      try {
        const result = await readSpeechStream(res, text, requestSignal);
        return { ok: true, ...result };
      } catch {
        requestSignal.throwIfAborted();
        return { ok: false, status: 502, code: "speech-invalid-stream", error: "语音服务返回的音频流不完整或格式无效，未播放。" };
      }
    }
    if (!["audio/mpeg", "audio/mp3", "application/octet-stream"].includes(mime ?? "") ||
        Number(res.headers.get("content-length") ?? 0) > MAX_AUDIO_BYTES || !res.body) {
      await res.body?.cancel();
      return { ok: false, status: 502, code: "speech-invalid-audio", error: "语音服务未返回有效的 MP3 音频。" };
    }
    // Bound even responses without Content-Length; keep timeout through body read.
    const reader = res.body.getReader();
    const onAbort = () => { void reader.cancel().catch(() => {}); };
    requestSignal.addEventListener("abort", onAbort, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        requestSignal.throwIfAborted();
        const chunk = await reader.read();
        requestSignal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_AUDIO_BYTES) {
          await reader.cancel();
          return { ok: false, status: 502, code: "speech-audio-too-large", error: "语音服务返回的音频过大。" };
        }
        chunks.push(chunk.value);
      }
    } finally {
      requestSignal.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
    if (!size) {
      return { ok: false, status: 502, code: "speech-empty-audio", error: "语音服务返回了空音频。" };
    }
    const audio = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      audio.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, audio };
  } catch {
    // Neither upstream bodies nor transport error messages are safe to echo.
    const timedOut = requestSignal.aborted && requestSignal.reason?.name === "TimeoutError";
    return {
      ok: false, status: timedOut ? 504 : 503,
      code: timedOut ? "speech-timeout" : "speech-unavailable",
      error: timedOut ? "语音合成超时，请稍后重试。" : "语音不可用：请求已取消或网络连接失败。",
    };
  }
};
