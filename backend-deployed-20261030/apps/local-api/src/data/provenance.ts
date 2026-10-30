import { z } from "zod";
import { EvidenceRefSchema, type EvidenceRef } from "@vivic/contracts";

// Strings survive the existing context summary; arrays/objects do not.
export const PROVENANCE_FIELD = "dataProvenanceJson";
const Receipt = z.strictObject({ version: z.literal(1), sources: z.array(EvidenceRefSchema).max(15),
  sourceData: z.record(z.string(), z.unknown()) });
export interface DataProvenance { sources: EvidenceRef[]; sourceData: Record<string, unknown> }

function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100 && value.every(item => safeJson(item, depth + 1));
  return typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
    && Object.entries(value).every(([key, item]) => !/^(?:apikey|token|secret|authorization|password|__proto__|constructor|prototype)$/i.test(key)
      && safeJson(item, depth + 1));
}

export function encodeProvenance(value: DataProvenance): string | null {
  const sourceData = { ...value.sourceData }; delete sourceData[PROVENANCE_FIELD];
  if (!safeJson(sourceData) || value.sources.some(source => source.url && source.url.length > 2048)) return null;
  const parsed = Receipt.safeParse({ version: 1, sources: value.sources, sourceData });
  if (!parsed.success) return null;
  const text = JSON.stringify(parsed.data);
  return Buffer.byteLength(text, "utf8") <= 32 * 1024 ? text : null;
}

export function decodeProvenance(raw: unknown): DataProvenance | null {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 32 * 1024) return null;
  try {
    const parsed = Receipt.safeParse(JSON.parse(raw));
    if (!parsed.success || encodeProvenance(parsed.data) === null) return null;
    return { sources: parsed.data.sources, sourceData: parsed.data.sourceData };
  } catch { return null; }
}
