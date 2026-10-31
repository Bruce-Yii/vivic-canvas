export type ModelApiErrorCode =
  | "invalid-config" | "invalid-input" | "not-configured" | "unauthorized" | "forbidden"
  | "busy" | "timeout" | "cancelled" | "unavailable" | "invalid-response" | "protocol-mismatch" | "too-large";

/** Safe, fixed diagnostics only. No upstream body, token, URL, stack or abort reason. */
export interface ModelApiFailure {
  code: ModelApiErrorCode;
  message: string;
  status?: number;
}
export type ModelApiResult<T> = { ok: true; value: T } | { ok: false; error: ModelApiFailure };

export interface ModelApiClientOptions {
  baseUrl: string;
  token?: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  /** Entire operation, including queueing, all segments, backoff and body reads. Default 180s. */
  timeoutMs?: number;
  /** Explicit test opt-in; never enables HTTP for non-loopback hosts. */
  allowLoopbackHttp?: boolean;
}
export interface ModelApiCallOptions { signal?: AbortSignal }
export interface ModelApiSpeechOptions extends ModelApiCallOptions {
  voice?: string;
  language?: string;
  instruct?: string;
}
export interface ModelApiSpeechSegment {
  audio: Uint8Array<ArrayBuffer>;
  mime: "audio/wav";
  text: string;
  durationSeconds: number;
  /** Signal measurement only; does not establish speech quality or listening acceptance. */
  nonSilent: boolean;
}
export interface ModelApiSpeech { segments: ModelApiSpeechSegment[] }
export interface ModelApiTranscriptionOptions extends ModelApiCallOptions {
  filename?: string;
  /** Compatibility passthrough only when explicitly supplied; default requests omit this undeclared field. */
  language?: string;
}
export interface ModelApiTranscription {
  /** Original provider transcript, without spelling substitutions or trimming. */
  text: string;
  /** Compressed browser recordings require the provider to enforce its 60s limit. */
  durationValidation: "local-wav" | "upstream-required";
}
export type ModelApiDecisionModel = "startlux-decision-2b" | "startlux-decision-4b" | "gliner2.5-multi-decide";
/** 4B speaks the native state/questions protocol; 2B and GLiNER keep the legacy input/labels protocol. */
export type ModelApiDecisionProtocol = "legacy" | "native";
export interface ModelApiClassificationOptions extends ModelApiCallOptions {
  model: ModelApiDecisionModel;
  labels: Readonly<Record<string, string>>;
  /** Optional explicit protocol; must match the model family or the call is rejected. */
  protocol?: ModelApiDecisionProtocol;
}
export interface ModelApiClassification {
  model: ModelApiDecisionModel;
  choice: string | null;
  score: number;
  needs_review: boolean;
  scoreKind: "startlux-choice-score" | "startlux-4b-choice-confidence" | "gliner-winning-label-score";
  /** Legacy models never return native v2; 4B native answers are reduced to this one classification. */
  compatibilityGaps: readonly string[];
}
export interface ModelApiVoice { id: string; name: string; language?: string }
export interface ModelApiStatus {
  reachable: true;
  models: Array<{ id: string }>;
  /** GET /models establishes metadata reachability only. */
  inference: "not-tested";
  quality: "not-tested";
}
export interface ModelApiClient {
  synthesize(text: string, options?: ModelApiSpeechOptions): Promise<ModelApiResult<ModelApiSpeech>>;
  transcribe(audio: Blob, options?: ModelApiTranscriptionOptions): Promise<ModelApiResult<ModelApiTranscription>>;
  classify(input: string, options: ModelApiClassificationOptions): Promise<ModelApiResult<ModelApiClassification>>;
  voices(options?: ModelApiCallOptions): Promise<ModelApiResult<{ voices: ModelApiVoice[] }>>;
  status(options?: ModelApiCallOptions): Promise<ModelApiResult<ModelApiStatus>>;
}

export const MODEL_API_LIMITS = Object.freeze({
  speechCharsPerSegment: 300,
  speechMaxChars: 9_600,
  speechMaxSegments: 32,
  speechSegmentBytes: 12_000_000,
  speechTotalBytes: 64_000_000,
  audioBytes: 20_000_000,
  audioSeconds: 60,
  uploadRequestBytes: 22_000_000,
  jsonResponseBytes: 256_000,
  inferenceQueueSize: 4,
  timeoutMs: 180_000,
  retriesOn429: 2,
  imageBytes: 10_000_000,
  imagePixels: 16_000_000,
});

/** Reserved contract only; OCR product integration is intentionally not implemented here. */
export interface ModelApiOcrRequest extends ModelApiCallOptions { image: Blob; filename?: string }
