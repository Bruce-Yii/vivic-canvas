import type { ActionEnvelope } from "@/contracts";
import type { CardState, VivicState } from "@/state/canvasStore";
import type { Attachment } from "./attachments";
import { completedCountdown } from "@/canvas/reminderPresentation";
import type { DeviceFix } from "@/location/deviceLocation";
import type { CardRecord } from "@/contracts";
import { isReadableFile, TravelOffersCardSchema, type TravelOffersCard, type TravelQuery, type HostOperation, type DecisionTaskRequest, type DecisionTaskStatus } from "@vivic/contracts";
import { readIntentStream, IntentResultSchema, type IntentProgress } from "./intentStream";
import { enabledPlannerDefinitions } from "@/extensions/definitionStore";
export { intentStageLabel } from "./intentStream";

/**
 * Browser-side client for the local decision API. All traffic is same-origin
 * through the Vite dev proxy, which injects the session bearer server-side —
 * this code never sees the token, and StepFun keys only ever travel browser
 * → same-origin proxy → loopback API body (never stored client-side).
 */

export interface ProviderStatus {
  name: "stepfun" | "gpt";
  connected: boolean;
  capabilities: string[];
  models?: string[];
  defaultModel?: string;
  checkedAt?: string;
  lastError?: string;
  source?: "pi" | "vivic";
  route?: "openai" | "openai-codex";
}

export interface ProvidersStatusResponse {
  activeProvider?: "stepfun" | "gpt";
  /** Changes whenever the local backend restarts. */
  instance?: string;
  /** Set while a remembered GPT login is being restored after a restart. */
  restoring?: "gpt";
  providers: ProviderStatus[];
  degradations: Array<{ code: string; message: string }>;
}

export interface IntentResult {
  kind: "envelope" | "clarify" | "unknown" | "error" | "locale" | "host-operation" | "task";
  hostOperation?: HostOperation;
  task?: DecisionTaskStatus;
  /** Answer to "我在哪里"; already phrased for display and speech. */
  locale?: { name: string; admin1?: string; country?: string; basis: "device" | "network"; answer: string };
  envelope?: ActionEnvelope;
  message?: string;
  suggestions?: string[];
  usedProvider?: "rules" | "stepfun" | "gpt" | "rules-offline" | "search" | "decision";
}

export interface CanvasContextPayload {
  version?: number;
  selectedCardIds?: string[];
  timeZone?: string;
  /** Present only when this request carries a selected subset of the canvas. */
  totalCardCount?: number;
  canvasId: string;
  stage: VivicState["stage"];
  viewport: VivicState["viewport"];
  focusHistory: string[];
  cards: Array<{
    id: string;
    type: string;
    aliases?: string[];
    displayProps: Record<string, unknown>;
    sourceDataSummary: Record<string, unknown>;
    contextSummary?: { truncatedFields: string[] };
    surface?: "user" | "display";
    layout: { x: number; y: number; width?: number; height?: number; pinned?: boolean };
  }>;
}

const secretFields = new Set(["apikey", "token", "secret"]);
export const MAX_CONTEXT_CARDS = 64;

/** A card remains addressable without copying its full article/table payload. */
const boundedSummary = (value: object): { value: Record<string, unknown>; truncatedFields: string[] } => {
  const budget = { remaining: 2800 };
  const visit = (item: unknown, depth: number): unknown => {
    if (budget.remaining <= 0) return "[summary limit]";
    if (typeof item === "string") {
      const limit = Math.min(400, budget.remaining);
      budget.remaining -= Math.min(item.length, limit);
      return item.length > limit ? `${item.slice(0, Math.max(0, limit - 1))}…` : item;
    }
    if (item === null || typeof item === "number" || typeof item === "boolean") { budget.remaining -= 16; return item; }
    if (Array.isArray(item)) {
      if (depth >= 4) return `[${item.length} items]`;
      const items = item.slice(0, 12).map(entry => visit(entry, depth + 1));
      if (item.length > 12) items.push(`[${item.length - 12} more items]`);
      return items;
    }
    if (typeof item === "object" && item) {
      if (depth >= 4) return "[object]";
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(item).slice(0, 24)) {
        if (budget.remaining <= 0) break;
        if (key.length > 128 || secretFields.has(key.toLowerCase()) || /api.?key|token|secret|password|credential|authorization|cookie/i.test(key)) continue;
        budget.remaining -= key.length + 4;
        out[key] = visit(entry, depth + 1);
      }
      return out;
    }
    return "[unsupported]";
  };
  const result = visit(value, 0);
  const summary: Record<string, unknown> = typeof result === "object" && result !== null && !Array.isArray(result) ? Object.fromEntries(Object.entries(result)) : {};
  return { value: summary, truncatedFields: Object.keys(value).filter(key => JSON.stringify(Reflect.get(value, key)) !== JSON.stringify(Reflect.get(summary, key))) };
};

/** Whitelist summary so provider keys/real source URLs never leak context. */
const summarizeSourceData = (
  record: CardState["record"],
): Record<string, unknown> => {
  // Rule-based schedule edits validate the entire bounded countdown contract.
  if (record.type === "CountdownCard") return { ...record.sourceData };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record.sourceData)) {
    if (key === "dataProvenanceJson") continue;
    if (key === "articleText" && typeof value === "string") { out[key] = `[${value.length} chars, retained on the source card]`; continue; }
    if (secretFields.has(key.toLowerCase())) continue;
    if (["string", "number", "boolean"].includes(typeof value) || value === null) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = `[${value.length} items]`;
    } else {
      out[key] = "[object]";
    }
  }
  const summary = boundedSummary(out).value;
  const receipt = Reflect.get(record.sourceData, "dataProvenanceJson");
  // A partial JSON receipt cannot prove source identity. Keep this separately
  // from text previews with the same 32 KiB bound as the backend decoder.
  if (typeof receipt === "string" && receipt.length <= 32 * 1024 && new TextEncoder().encode(receipt).length <= 32 * 1024) summary.dataProvenanceJson = receipt;
  else if (receipt !== undefined) summary.dataProvenanceJson = "[provenance unavailable: exceeds context limit]";
  return summary;
};

export const buildCanvasContext = (
  state: VivicState,
  canvasId: string,
  version?: number,
): CanvasContextPayload => {
  const eligible = state.cards.filter(c => !c.exitingRequestId && !completedCountdown(c));
  const ranked = eligible
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => Number(b.entry.record.id === state.focus?.cardId) - Number(a.entry.record.id === state.focus?.cardId)
      || Number(b.entry.record.layout.pinned) - Number(a.entry.record.layout.pinned)
      || b.entry.record.metadata.updatedAt.localeCompare(a.entry.record.metadata.updatedAt)
      || b.index - a.index)
    .slice(0, MAX_CONTEXT_CARDS).map(({ entry }) => entry);
  const selectedIds = new Set(ranked.map(entry => entry.record.id));
  // Selection priority must not reorder positional references on small canvases.
  const selected = eligible.filter(entry => selectedIds.has(entry.record.id));
  return {
  canvasId,
  ...(version === undefined ? {} : { version }),
  ...(eligible.length > selected.length ? { totalCardCount: eligible.length } : {}),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  stage: state.stage,
  viewport: state.viewport,
  focusHistory: state.focusHistory.filter(id => selectedIds.has(id)).slice(-20),
  cards: selected
    .map((entry) => {
      // Todo is already contract-bounded and edits replace the whole items list.
      const display = entry.record.type === "TodoCard" ? { value: entry.record.displayProps, truncatedFields: [] }
        : entry.record.type === "FileCard" && !isReadableFile(entry.record.displayProps.mediaType)
          ? boundedSummary({ ...entry.record.displayProps, previewText: undefined, parseStatus: "unsupported" })
        : boundedSummary(entry.record.displayProps);
      return {
      id: entry.record.id,
      type: entry.record.type,
      aliases: entry.record.metadata.aliases?.slice(0, 12).map(alias => alias.slice(0, 80)),
      displayProps: display.value,
      ...(display.truncatedFields.length ? { contextSummary: { truncatedFields: display.truncatedFields } } : {}),
      sourceDataSummary: summarizeSourceData(entry.record),
      surface: entry.record.layout.surface ?? "display",
      layout: { x: entry.record.layout.x, y: entry.record.layout.y, width: entry.record.layout.width, height: entry.record.layout.height, pinned: entry.record.layout.pinned },
    }; }),
  };
};

const post = async <T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`api ${res.status}`);
  return (await res.json()) as T;
};

export const getProvidersStatus = async (): Promise<ProvidersStatusResponse> => {
  const res = await fetch("/api/providers/status");
  if (!res.ok) throw new Error(`api ${res.status}`);
  return (await res.json()) as ProvidersStatusResponse;
};

export const validateStepfunKey = (
  apiKey: string,
): Promise<{ ok: boolean; connected: boolean; error?: string; models?: string[]; defaultModel?: string }> =>
  post("/api/credentials/stepfun/validate", { apiKey });

export const disconnectStepfun = (): Promise<{ ok: boolean; connected: boolean }> =>
  post("/api/credentials/stepfun/disconnect", {});

export const postIntent = async (
  text: string,
  canvasContext: CanvasContextPayload,
  signal?: AbortSignal,
  attachments?: Attachment[],
  continuation?: { utterance: string; question: string },
  deviceLocation?: DeviceFix | null,
  onProgress?: (event: IntentProgress) => void,
  task?: DecisionTaskRequest,
): Promise<IntentResult> => {
  const extensionDefinitions = enabledPlannerDefinitions();
  const body = { text, canvasContext, ...(attachments?.length ? { attachments } : {}), ...(continuation ? { continuation } : {}),
    ...(deviceLocation ? { deviceLocation } : {}), ...(extensionDefinitions.length ? { extensionDefinitions } : {}), ...(task ? { task } : {}) };
  if (!onProgress) return IntentResultSchema.parse(await post("/api/intent", body, signal));
  const response = await fetch("/api/intent", { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body), signal });
  return readIntentStream(response, onProgress, signal);
};

/** Verified fields for a "where I am" WeatherCard; Control swaps them into the existing card. */
export type WeatherHereFields = Pick<CardRecord, "displayProps" | "sourceData" | "sources"> & { aliases: string[] };
export type WeatherHereResult = ({ kind: "weather" } & WeatherHereFields) | { kind: "clarify" | "error"; message: string };
export const fetchWeatherHere = (deviceLocation: DeviceFix | null, signal?: AbortSignal): Promise<WeatherHereResult> =>
  post("/api/weather/here", deviceLocation ? { deviceLocation } : {}, signal);

export async function fetchTravelOffers(query: TravelQuery, signal?: AbortSignal): Promise<{ ok: true; card: TravelOffersCard } | { ok: false; error: string }> {
  const raw = await post<{ kind?: string; card?: unknown; message?: string }>("/api/travel/refresh", { query }, signal);
  const card = raw.kind === "travel" ? TravelOffersCardSchema.safeParse(raw.card) : undefined;
  return card?.success ? { ok: true, card: card.data } : { ok: false, error: raw.message?.slice(0, 400) ?? "旅游结果未通过校验。" };
}
