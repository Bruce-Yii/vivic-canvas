import { z } from "zod";
import { CardRecordSchema, ViewportSchema } from "@/contracts";
import { CanvasRecordSchema, CANVAS_SCHEMA_VERSION, type CanvasRecord } from "./canvasRecord";

export const MAX_CANVAS_FILE_BYTES = 20 * 1024 * 1024;

/** JSON export/import file shape — validated with the same strict schemas. */
export const CanvasFileSchema = z.strictObject({
  schemaVersion: z.literal("0.6"),
  app: z.literal("vivic"),
  exportedAt: z.iso.datetime(),
  canvas: z.strictObject({
    title: z.string().min(1).max(120),
    cards: z.array(CardRecordSchema).max(100_000),
    viewport: ViewportSchema,
    focusHistory: z.array(z.string().min(1).max(128)).max(20).default([]),
    recovery: CanvasRecordSchema.shape.recovery,
  }),
});

export type CanvasFile = z.infer<typeof CanvasFileSchema>;

export const toCanvasFile = (record: CanvasRecord): CanvasFile => ({
  schemaVersion: "0.6",
  app: "vivic",
  exportedAt: new Date().toISOString(),
  canvas: {
    title: record.title,
    cards: record.cardOrder
      .map((id) => record.cardsById[id])
      .filter((c): c is NonNullable<typeof c> => Boolean(c)),
    viewport: record.viewport,
    focusHistory: record.focusHistory,
    ...(record.recovery ? { recovery: record.recovery } : {}),
  },
});

export type ParseFileResult =
  | { ok: true; file: CanvasFile }
  | { ok: false; error: string };

export const parseCanvasFile = (text: string): ParseFileResult => {
  if (text.length > MAX_CANVAS_FILE_BYTES || new TextEncoder().encode(text).byteLength > MAX_CANVAS_FILE_BYTES) {
    return { ok: false, error: "画布文件过大，最多支持 20 MiB 的 JSON 文件" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "不是有效的 JSON 文件" };
  }
  const parsed = CanvasFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `文件校验失败：${parsed.error.issues[0]?.message ?? "unknown"}`,
    };
  }
  return { ok: true, file: parsed.data };
};

export const fileToCanvasRecord = (
  file: CanvasFile,
  id: string,
): CanvasRecord => ({
  schemaVersion: CANVAS_SCHEMA_VERSION,
  id,
  title: file.canvas.title,
  version: 0,
  updatedAt: new Date().toISOString(),
  cardsById: Object.fromEntries(file.canvas.cards.map((c) => [c.id, c])),
  cardOrder: file.canvas.cards.map((c) => c.id),
  viewport: file.canvas.viewport,
  focusHistory: file.canvas.focusHistory,
  processedRequestIds: [],
  ...(file.canvas.recovery ? { recovery: file.canvas.recovery } : {}),
});
