import type { CaptureMode, ModelId, ModelState, WakeKeyword } from "./types";

export type ModelRequest =
  | { id: number; op: "prepare"; modelId: ModelId }
  | { id: number; op: "inspect" }
  | { id: number; op: "clear"; modelId?: ModelId }
  | { id: number; op: "cancel"; target: number };
export type ModelResponse =
  | { id: number; type: "progress"; state: ModelState }
  | { id: number; type: "done"; cached?: ModelId[] }
  | { id: number; type: "error"; message: string; aborted: boolean };
export interface ListenConfig { mode: CaptureMode; keywords?: WakeKeyword[]; maxSegmentSeconds: number; requireAsr?: boolean }
export type SpeechRequest =
  | { id: number; op: "listen"; config: ListenConfig }
  | { id: number; op: "pcm"; samples: Float32Array }
  | { id: number; op: "finish" }
  | { id: number; op: "transcribe"; samples: Float32Array };
export type SpeechResponse =
  | { id: number; type: "ack" }
  | { id: number; type: "wake"; label: string }
  | { id: number; type: "recording" }
  | { id: number; type: "segment"; samples: Float32Array }
  | { id: number; type: "transcript"; text: string }
  | { id: number; type: "error"; message: string };
