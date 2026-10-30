export type ModelId = "asr-zh" | "kws-zh-en" | "vad";
export interface ModelMetadata {
  files: { filename: string; start: number; end: number }[];
  remote_package_size: number;
}
export interface SpeechModel {
  id: ModelId;
  kind: "asr" | "kws" | "vad";
  label: string;
  license: string;
  repository: string;
  revision: string;
  url: string;
  bytes: number;
  sha256: string;
  licenseUrl: string;
  sourceUrl?: string;
  metadata?: ModelMetadata;
}
export type ModelPhase = "absent" | "cached" | "downloading" | "verifying" | "ready" | "error";
export interface ModelState {
  phase: ModelPhase;
  loaded: number;
  total: number;
  error: string | null;
}
export interface ModelsSnapshot { models: Record<ModelId, ModelState>; busy: boolean }
/** Encoded phonemes/pinyin tokens for the pinned KWS vocabulary; not arbitrary text. */
export interface WakeKeyword {
  label: string;
  matches: { tokens: string[]; score?: number; threshold?: number }[];
  score?: number;
  threshold?: number;
}
export type CaptureMode = "ptt" | "vad" | "wake";
export interface LocalSpeechOptions {
  mode: CaptureMode;
  recognition: "local" | "segment";
  keywords?: WakeKeyword[];
  /** 0.5–60 seconds; default 15. */
  maxSegmentSeconds?: number;
  /** 1–300 seconds of wall time, includes initialization; default 60. */
  maxListenSeconds?: number;
  signal?: AbortSignal;
  onEvent: (event: LocalSpeechEvent) => void;
}
export type LocalSpeechEvent =
  | { type: "status"; status: "loading" | "listening" | "recording" | "transcribing" | "stopped" }
  | { type: "wake"; label: string }
  | { type: "segment"; samples: Float32Array; sampleRate: 16000; wav: Blob; signal: AbortSignal }
  | { type: "transcript"; text: string }
  | { type: "fallback"; message: string };
export interface PcmTranscriptionOptions { sampleRate: number; signal?: AbortSignal; timeoutMs?: number }
