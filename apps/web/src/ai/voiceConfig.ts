import { ONLINE_BUILD } from "../online/mode";
export type SttProvider = "stepfun" | "local" | "none";
export type TtsProvider = "stepfun" | "browser" | "local" | "none";
interface VoiceConfiguration { stt: SttProvider; tts: TtsProvider; browserVoice: string; wakeEnabled: boolean; }
const key = "vivic.voice.providers.v1";
const defaults: VoiceConfiguration = { stt: "stepfun", tts: "stepfun", browserVoice: "", wakeEnabled: true };
let state: VoiceConfiguration = { ...defaults };
try {
  const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
  if (value && typeof value === "object") {
    if ("stt" in value && ["stepfun", "local", "none"].includes(String(value.stt))) state.stt = value.stt as SttProvider;
    if ("tts" in value && ["stepfun", "browser", "local", "none"].includes(String(value.tts))) state.tts = value.tts as TtsProvider;
    if ("browserVoice" in value && typeof value.browserVoice === "string") state.browserVoice = value.browserVoice.slice(0, 300);
    if ("wakeEnabled" in value && typeof value.wakeEnabled === "boolean") state.wakeEnabled = value.wakeEnabled;
  }
} catch { /* Preferences remain available for this tab. */ }
if (ONLINE_BUILD) { if (state.stt === "local") state.stt = "stepfun"; if (state.tts === "browser" || state.tts === "local") state.tts = "stepfun"; }
state.wakeEnabled = true;
const listeners = new Set<() => void>();
export const getVoiceConfiguration = () => state;
export const subscribeVoiceConfiguration = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const resetVoiceConfiguration = () => {
  window.dispatchEvent(new Event("vivic:voice-config-change"));
  localStorage.removeItem(key);
  state = { ...defaults };
  listeners.forEach(listener => listener());
};
export const setVoiceConfiguration = (patch: Partial<VoiceConfiguration>) => {
  if (patch.wakeEnabled !== undefined && typeof patch.wakeEnabled !== "boolean") return;
  if (ONLINE_BUILD && (patch.stt === "local" || patch.tts === "browser" || patch.tts === "local")) return;
  if ((patch.stt !== undefined && !["stepfun", "local", "none"].includes(patch.stt)) ||
    (patch.tts !== undefined && !["stepfun", "browser", "local", "none"].includes(patch.tts))) return;
  window.dispatchEvent(new Event("vivic:voice-config-change"));
  state = { ...state, ...patch, browserVoice: (patch.browserVoice ?? state.browserVoice).slice(0, 300) };
  try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* Nonessential preference storage. */ }
  listeners.forEach(listener => listener());
};
