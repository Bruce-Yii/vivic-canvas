/** Verified 2026-10-15: a curated subset explicitly supporting stepaudio-2.5-tts. */
export const SPEECH_VOICES_SOURCE = "https://platform.stepfun.com/docs/zh/guides/developer/tts#官方音色清单";
export const SPEECH_VOICES = [
  { id: "cixingnansheng", name: "磁性男声" },
  { id: "wenrounansheng", name: "温柔男声" },
  { id: "ruyananshi", name: "儒雅男士" },
  { id: "jingdiannvsheng", name: "经典女声" },
  { id: "wenrounvsheng", name: "温柔女声" },
  { id: "yuanqishaonv", name: "元气少女" },
  { id: "linjiajiejie", name: "邻家姐姐" },
  { id: "zhixingjiejie", name: "知性姐姐" },
] as const;
export type SpeechVoiceId = (typeof SPEECH_VOICES)[number]["id"];
export const SPEECH_VOICE_IDS = SPEECH_VOICES.map((voice) => voice.id);
export const DEFAULT_SPEECH_VOICE: SpeechVoiceId = "wenrounvsheng";
export const DEFAULT_SPEECH_SPEED = 1.3;

export interface SpeechOptions {
  /** Caller validates official voice IDs. */
  voice?: SpeechVoiceId;
  speed?: number;
  timestamps?: boolean;
}
