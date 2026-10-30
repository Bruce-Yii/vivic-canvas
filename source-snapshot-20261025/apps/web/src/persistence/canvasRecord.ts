import { z } from "zod";
import { CardRecordSchema, ViewportSchema, type CardRecord } from "@/contracts";
import type { VivicState } from "@/state/canvasStore";

/**
 * Persisted canvas shape (non-secret data only). A trimmed subset of the live
 * runtime state: subtitle/highlight/pending-deletes/stage are transient and
 * never stored; full snapshots use VivicStateSchema over the wire instead.
 */
export const CANVAS_SCHEMA_VERSION = 1;

const RecoverySchema = z.strictObject({
  /** Complete source document, retained across autosaves and export/restore. */
  rawRecord: z.unknown(),
  quarantinedCards: z.record(z.string(), z.unknown()),
  issues: z.array(z.strictObject({ path: z.string(), message: z.string() })),
});

export const CanvasRecordSchema = z.strictObject({
  schemaVersion: z.literal(CANVAS_SCHEMA_VERSION).optional(),
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(120),
  version: z.number().int().min(0),
  updatedAt: z.iso.datetime(),
  cardsById: z.record(z.string(), CardRecordSchema),
  cardOrder: z.array(z.string().min(1).max(128)),
  viewport: ViewportSchema,
  focusHistory: z.array(z.string().min(1).max(128)).max(20),
  processedRequestIds: z.array(z.string().min(1).max(128)).max(500).optional(),
  recovery: RecoverySchema.optional(),
});

export type CanvasRecord = z.infer<typeof CanvasRecordSchema>;

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Version 0 is the original unversioned canvas. Add steps here on upgrades. */
const migrations = new Map<number, (record: Record<string, unknown>) => Record<string, unknown>>([
  [0, record => ({ ...record, schemaVersion: 1 })],
]);
const migrateCanvasEnvelope = (raw: unknown): unknown => {
  if (!object(raw)) return raw;
  let record = raw;
  let version: unknown = record.schemaVersion ?? 0;
  while (typeof version === "number" && migrations.has(version)) {
    record = migrations.get(version)!(record);
    version = record.schemaVersion;
  }
  return record;
};

/** Recover persisted data only. Incoming actions/imported cards stay strict. */
export const recoverCanvasRecord = (raw: unknown): CanvasRecord | undefined => {
  const strict = CanvasRecordSchema.safeParse(migrateCanvasEnvelope(raw));
  if (strict.success && strict.data.cardOrder.length === Object.keys(strict.data.cardsById).length
    && new Set(strict.data.cardOrder).size === strict.data.cardOrder.length
    && Object.entries(strict.data.cardsById).every(([id, card]) => id === card.id && strict.data.cardOrder.includes(id))) {
    return { ...strict.data, schemaVersion: CANVAS_SCHEMA_VERSION };
  }
  if (!object(raw) || typeof raw.id !== "string" || !raw.id) return undefined;
  const issues: Array<{ path: string; message: string }> = [];
  const previous = RecoverySchema.safeParse(raw.recovery);
  const quarantinedCards: Record<string, unknown> = previous.success ? { ...previous.data.quarantinedCards } : {};
  const field = <T>(name: string, schema: z.ZodType<T>, fallback: T): T => {
    const result = schema.safeParse(raw[name]);
    if (result.success) return result.data;
    issues.push({ path: name, message: result.error.issues[0]?.message ?? "Invalid value" });
    return fallback;
  };
  const cardsById: Record<string, CardRecord> = {};
  if (object(raw.cardsById)) {
    for (const [id, original] of Object.entries(raw.cardsById)) {
      let candidate = structuredClone(original);
      let parsed = CardRecordSchema.safeParse(candidate);
      // Future optional keys must not make otherwise valid known cards vanish.
      // Remove only keys explicitly reported by the contract; retain the raw copy.
      for (let pass = 0; !parsed.success && pass < 12; pass++) {
        if (!parsed.error.issues.every(issue => issue.code === "unrecognized_keys")) break;
        for (const issue of parsed.error.issues) {
          if (issue.code !== "unrecognized_keys") continue;
          let target: unknown = candidate;
          for (const segment of issue.path) target = object(target) || Array.isArray(target) ? Reflect.get(target, segment) : undefined;
          if (object(target)) for (const key of issue.keys) delete target[key];
        }
        parsed = CardRecordSchema.safeParse(candidate);
      }
      if (parsed.success && parsed.data.id === id) {
        cardsById[id] = parsed.data;
        if (JSON.stringify(original) !== JSON.stringify(parsed.data)) issues.push({ path: `cardsById.${id}`, message: "Unsupported fields retained in recovery data" });
      } else {
        quarantinedCards[id] = original;
        issues.push({ path: `cardsById.${id}`, message: parsed.success ? "Card identifier differs from its saved key" : parsed.error.issues[0]?.message ?? "Invalid card" });
      }
    }
  } else issues.push({ path: "cardsById", message: "Invalid card collection retained in recovery data" });
  const savedOrder = Array.isArray(raw.cardOrder) ? raw.cardOrder.filter((id): id is string => typeof id === "string") : [];
  const cardOrder = [...new Set([...savedOrder, ...Object.keys(cardsById)])].filter(id => Object.hasOwn(cardsById, id));
  if (JSON.stringify(raw.cardOrder) !== JSON.stringify(cardOrder)) issues.push({ path: "cardOrder", message: "Card order repaired; original order retained in recovery data" });
  const known = new Set(Object.keys(CanvasRecordSchema.shape));
  for (const key of Object.keys(raw)) if (!known.has(key)) issues.push({ path: key, message: "Unsupported field retained in recovery data" });
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== CANVAS_SCHEMA_VERSION) issues.push({ path: "schemaVersion", message: "Unsupported version retained in recovery data" });
  return {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    id: raw.id,
    title: field("title", CanvasRecordSchema.shape.title, "已恢复的画布"),
    version: field("version", CanvasRecordSchema.shape.version, 0),
    updatedAt: field("updatedAt", CanvasRecordSchema.shape.updatedAt, "1970-01-01T00:00:00.000Z"),
    cardsById,
    cardOrder,
    viewport: field("viewport", ViewportSchema, { x: 0, y: 0, zoom: 1 }),
    focusHistory: field("focusHistory", CanvasRecordSchema.shape.focusHistory, []).filter(id => Object.hasOwn(cardsById, id)),
    processedRequestIds: field("processedRequestIds", CanvasRecordSchema.shape.processedRequestIds, []),
    recovery: {
      rawRecord: previous.success ? previous.data.rawRecord : raw,
      quarantinedCards,
      issues: [...(previous.success ? previous.data.issues : []), ...issues],
    },
  };
};

export const getCanvasRecovery = (record: CanvasRecord) => record.recovery ? {
  quarantinedCardCount: Object.keys(record.recovery.quarantinedCards).length,
  issues: record.recovery.issues,
  rawRecord: record.recovery.rawRecord,
} : undefined;

/** Autosave must never erase unsupported content that the live store cannot hold. */
export const preserveCanvasRecovery = (record: CanvasRecord, previous: unknown): CanvasRecord => {
  const recovered = recoverCanvasRecord(previous);
  return { ...record, schemaVersion: CANVAS_SCHEMA_VERSION,
    ...(record.recovery || recovered?.recovery ? { recovery: record.recovery ?? recovered?.recovery } : {}) };
};

const baseVivicState = (): Omit<VivicState, "cards" | "viewport" | "focusHistory" | "processedRequestIds"> => ({
  stage: "STANDBY",
  awakenedAt: null,
  undoStack: [],
  pendingDeletes: {},
  focus: null,
  viewportSize: null,
  highlight: null,
  subtitle: null,
  activity: null,
  targetChoice: null,
  ambient: { preset: "grainient", theme: "auto" },
  lastFitRequestId: null,
});

export const toCanvasRecord = (
  id: string,
  title: string,
  version: number,
  state: VivicState,
): CanvasRecord => {
  const live = state.cards
    .filter((c) => !c.exitingRequestId)
    .map((c) => c.record);
  return {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    id,
    title,
    version,
    updatedAt: new Date().toISOString(),
    cardsById: Object.fromEntries(live.map((c: CardRecord) => [c.id, c])),
    cardOrder: live.map((c) => c.id),
    viewport: state.viewport,
    focusHistory: state.focusHistory,
    processedRequestIds: state.processedRequestIds,
  };
};

export const fromCanvasRecord = (record: CanvasRecord): VivicState => {
  const cards = record.cardOrder
    .map((id) => record.cardsById[id])
    .filter((c): c is CardRecord => Boolean(c))
    .map((record) => ({ record }));
  return {
    ...baseVivicState(),
    // A canvas that already has cards restores straight into the workspace.
    stage: cards.length > 0 ? "WORKSPACE" : "STANDBY",
    cards,
    viewport: record.viewport,
    focusHistory: record.focusHistory,
    processedRequestIds: record.processedRequestIds ?? [],
  };
};

export const emptyVivicState = (): VivicState => ({
  ...baseVivicState(),
  cards: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory: [],
  processedRequestIds: [],
});
