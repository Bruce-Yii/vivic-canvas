import { z } from "zod";
import { createBudget } from "../intent/budget.js";
import { decisionEndpoint } from "./provider.js";

export interface NativeQuestion { type: "choice"; instructions: string; criteria: Record<string, string> }
export interface NativeScore { choice: string | null; probabilities: Record<string, number>; none_probability: number }
export type NativeResult = { ok: true; answers: Record<string, NativeScore> } | { ok: false; reason: string };
export interface NativeV2Provider {
  decide(state: unknown, questions: Record<string, NativeQuestion>, signal?: AbortSignal): Promise<NativeResult>;
}
export interface NativeGate { executionEnabled: boolean; minProbability: number; minMargin: number; maxNoneProbability: number }
/** Conservative engineering defaults, NOT a calibrated model quality claim. Execution is opt-in. */
export const DEFAULT_NATIVE_GATE: NativeGate = { executionEnabled: false, minProbability: .9, minMargin: .25, maxNoneProbability: .1 };
const AnswerSchema = z.object({ type: z.literal("choice"), choice: z.string().nullable(),
  probabilities: z.record(z.string(), z.number().finite().min(0).max(1)), none_probability: z.number().finite().min(0).max(1) });
export function parseNativeAnswers(raw: unknown, questions: Record<string, NativeQuestion>): NativeResult {
  const parsed = z.object({ answers: z.record(z.string(), AnswerSchema) }).safeParse(raw);
  if (!parsed.success || Object.keys(parsed.data.answers).length !== Object.keys(questions).length) return { ok: false, reason: "invalid_native_response" };
  for (const [key, question] of Object.entries(questions)) {
    const answer = parsed.data.answers[key], ids = Object.keys(question.criteria);
    if (!answer || Object.keys(answer.probabilities).length !== ids.length || ids.some(id => answer.probabilities[id] === undefined)
      || Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) > .0001
      || answer.choice !== null && (!ids.includes(answer.choice) || answer.probabilities[answer.choice]! < Math.max(...Object.values(answer.probabilities))))
      return { ok: false, reason: "invalid_native_scores" };
  }
  return { ok: true, answers: parsed.data.answers };
}
export function acceptedNativeChoice(answer: NativeScore, gate: NativeGate): string | null {
  const ranked = Object.values(answer.probabilities).sort((a, b) => b - a);
  return answer.choice !== null && answer.none_probability < gate.maxNoneProbability
    && answer.probabilities[answer.choice]! >= gate.minProbability && ranked[0]! - (ranked[1] ?? 0) >= gate.minMargin ? answer.choice : null;
}

/** Native StartLux questions/answers only. Never asks a choice model to generate JSON actions. */
export class HttpNativeV2Provider implements NativeV2Provider {
  private readonly endpoint: string;
  private readonly options: { fetchImpl?: typeof fetch; timeoutMs?: number; getToken?: () => string | undefined };
  constructor(endpoint: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number; getToken?: () => string | undefined } = {}) {
    this.endpoint = decisionEndpoint(endpoint, "api", "startlux");
    this.options = options;
  }
  async decide(state: unknown, questions: Record<string, NativeQuestion>, signal?: AbortSignal): Promise<NativeResult> {
    if (signal?.aborted) return { ok: false, reason: "cancelled" };
    if (!Object.keys(questions).length || Object.values(questions).some(question => Object.keys(question.criteria).length > 32)) return { ok: false, reason: "candidate_limit" };
    const budget = createBudget(Math.min(30_000, Math.max(1, this.options.timeoutMs ?? 10_000)), [signal]);
    let response: Response | undefined;
    try {
      const token = this.options.getToken?.();
      response = await budget.run(() => (this.options.fetchImpl ?? fetch)(this.endpoint, {
        method: "POST", redirect: "error", credentials: "omit", signal: budget.signal,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ state, questions, think_mode: "never", allow_none: true, none_check: true, return_details: false, return_thought: false }),
      }));
      if (!response.ok || response.redirected || response.url && response.url !== this.endpoint) return { ok: false, reason: "native_http_error" };
      if (!response.body || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return { ok: false, reason: "invalid_native_response" };
      const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
      let content = "", bytes = 0;
      try {
        while (true) {
          const chunk = await budget.run(() => reader.read());
          bytes += chunk.value?.byteLength ?? 0;
          if (bytes > 128 * 1024) return { ok: false, reason: "native_response_limit" };
          content += decoder.decode(chunk.value, { stream: !chunk.done });
          if (chunk.done) break;
        }
      } finally { void reader.cancel().catch(() => {}); }
      budget.signal.throwIfAborted();
      return parseNativeAnswers(JSON.parse(content), questions);
    } catch { return { ok: false, reason: signal?.aborted ? "cancelled" : budget.signal.aborted ? "native_timeout" : "native_unavailable" }; }
    finally { budget.dispose(); if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
  }
}
