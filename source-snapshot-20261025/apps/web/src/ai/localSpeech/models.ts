import manifestText from "./manifest.json?raw";
import type { ModelId, SpeechModel } from "./types";

const manifest = JSON.parse(manifestText) as { models: SpeechModel[] };
export const SPEECH_MODELS: readonly SpeechModel[] = manifest.models;
export const MODEL_IDS: readonly ModelId[] = ["asr-zh", "kws-zh-en", "vad"];
export const getSpeechModel = (id: ModelId): SpeechModel => {
  const model = SPEECH_MODELS.find(item => item.id === id);
  if (!model) throw new Error("未知语音模型。");
  return model;
};
export const abortError = () => new DOMException("语音操作已取消。", "AbortError");
export const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError(); };
export const validatePcm = (samples: Float32Array, sampleRate: number, maxFrames = 60 * 16000) => {
  if (sampleRate !== 16000 || !(samples instanceof Float32Array) || samples.length < 1 || samples.length > maxFrames) {
    throw new Error("本地语音需要 16kHz 单声道 PCM，最长 60 秒；流式单块最长 1 秒。");
  }
  for (const sample of samples) {
    if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw new Error("PCM 必须为 [-1, 1] 内的有限数值。");
  }
};
