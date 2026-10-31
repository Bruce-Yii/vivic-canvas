import { SPEECH_MODEL, type SpeechBackend } from "../speech.js";
import { authHeaders } from "./client.js";
import type { ProviderStore } from "./store.js";
import type { ProviderConfig } from "./types.js";

/** An explicit TTS assignment wins. Otherwise the selected StepFun API may
 * provide speech using its own endpoint/key; a chat-only custom API cannot. */
export function resolveSavedSpeech(store: ProviderStore): { saved: ProviderConfig; backend: SpeechBackend } | { error: string } | undefined {
  const dedicated = store.findForRole("tts");
  if (!dedicated && store.list().some(entry => entry.roles.includes("tts"))) {
    return { error: "语音回复的 TTS 连接已关闭，请在模型设置中启用。" };
  }
  const main = store.findForRole("main");
  const saved = dedicated ?? (main?.protocol.startsWith("stepfun") ? main : undefined);
  if (!saved) return;
  if (!["stepfun-v1", "stepfun-plan", "openai-compatible"].includes(saved.protocol)) {
    return { error: "所选 TTS 连接使用了非语音协议，请选择语音 API。" };
  }
  const stepfun = saved.protocol.startsWith("stepfun");
  const model = stepfun ? dedicated?.model ?? SPEECH_MODEL : saved.model;
  if (!model) return { error: "请为 TTS 连接选择一个语音模型。" };
  if (stepfun && !store.getApiKey(saved.id)?.trim()) return { error: "所选语音 API 未保存 Key，请在模型设置中重新连接。" };
  const qwen = /^qwen.*tts/i.test(model);
  return { saved, backend: {
    baseUrl: saved.baseUrl.replace(/\/+$/, ""), model,
    headers: authHeaders({ ...saved, apiKey: store.getApiKey(saved.id) }),
    format: qwen ? "wav" : "mp3", supportsTimestamps: stepfun,
    ...(qwen ? { voice: "Vivian", clientSpeed: true } : stepfun ? {} : { voice: "alloy" }),
  } };
}
