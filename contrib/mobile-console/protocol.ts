import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 32 * 1024;
/** Bound queued network data as well as each individual frame. */
export const MAX_BUFFERED_BYTES = 4 * MAX_FRAME_BYTES;
export const PermissionSchema = z.enum(["text.submit", "canvas.switch", "card.pin", "card.surface", "file.read", "image.read"]);
export type Permission = z.infer<typeof PermissionSchema>;
export const PERMISSIONS: Permission[] = ["text.submit", "canvas.switch", "card.pin", "card.surface", "file.read", "image.read"];
const Id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const Token = z.string().min(16).max(256);
const Version = z.number().int().nonnegative();
const scope = { v: z.literal(1), sessionId: Id, deviceId: Id, epoch: Id };

export const OperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text.submit"), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal("canvas.switch"), targetCanvasId: Id }).strict(),
  z.object({ kind: z.literal("card.pin"), cardId: Id, pinned: z.boolean() }).strict(),
  z.object({ kind: z.literal("card.surface"), cardId: Id, surface: z.enum(["display", "user"]) }).strict(),
]);
export type Operation = z.infer<typeof OperationSchema>;
/** Explicit visible-content projection. This never accepts a raw card record. */
export const CardPreviewSchema = z.object({
  kind: z.enum(["text", "checklist", "metric", "table", "timeline", "chart", "collection"]),
  body: z.string().max(6000).optional(),
  items: z.array(z.object({ text: z.string().max(600), meta: z.string().max(240).optional(), checked: z.boolean().optional() }).strict()).max(40).optional(),
  columns: z.array(z.string().max(100)).max(12).optional(),
  rows: z.array(z.array(z.string().max(256)).max(12)).max(40).optional(),
  stat: z.object({ value: z.string().max(240), unit: z.string().max(80).optional() }).strict().optional(),
  series: z.array(z.object({ label: z.string().max(100), value: z.number().finite() }).strict()).max(32).optional(),
  truncated: z.boolean().optional(),
}).strict();
export type CardPreview = z.infer<typeof CardPreviewSchema>;
/** Plain visible notes only. No links, action payloads or arbitrary parent metadata. */
export const SubcardPreviewSchema = z.object({
  id: z.string().min(1).max(128), label: z.string().max(160), text: z.string().min(1).max(2000),
}).strict();
export type SubcardPreview = z.infer<typeof SubcardPreviewSchema>;
export const FILE_CHUNK_BYTES = 16 * 1024;
export const FilePreviewSchema = z.object({ name: z.string().min(1).max(240), mediaType: z.string().min(1).max(100),
  sizeBytes: z.number().int().min(0).max(10_000_000), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  parseStatus: z.enum(["ready", "partial", "empty", "unsupported", "error"]), pageCount: z.number().int().min(1).max(100000).optional(),
}).strict();
export const FileChunkDataSchema = z.object({ data: z.string().max(21848).regex(/^[A-Za-z0-9+/]*={0,2}$/), totalBytes: z.number().int().min(0).max(10_000_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1).max(240), mediaType: z.string().min(1).max(100),
}).strict();
export type FileChunkData = z.infer<typeof FileChunkDataSchema>;
export const ImagePreviewSchema = FilePreviewSchema.extend({ id: Id, alt: z.string().max(120),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]), sizeBytes: z.number().int().min(1).max(262144),
  width: z.number().int().min(1).max(1024), height: z.number().int().min(1).max(1024) }).strict();
export type ImagePreview = z.infer<typeof ImagePreviewSchema>;
export const CanvasSnapshotSchema = z.object({
  computerName: z.string().min(1).max(80), ownerAvailable: z.boolean(), ownerEpoch: Id,
  activeCanvasId: Id.nullable(), version: Version,
  canvases: z.array(z.object({ id: Id, title: z.string().max(160), version: Version }).strict()).max(100),
  cards: z.array(z.object({ id: Id, title: z.string().max(160), type: z.string().min(1).max(80), pinned: z.boolean(),
    preview: CardPreviewSchema.optional(), surface: z.enum(["display", "user"]).optional(),
    subcards: z.array(SubcardPreviewSchema).max(24).optional(),
    file: FilePreviewSchema.optional(),
    images: z.array(ImagePreviewSchema).max(8).optional(), imageNotice: z.string().max(160).optional(),
    section: z.string().min(1).max(60).optional(), priority: z.enum(["high", "normal", "low"]).optional(), dueDate: z.iso.date().optional(),
  }).strict()).max(200),
  cardCount: z.number().int().nonnegative().optional(),
  cardsTruncated: z.boolean().optional(),
}).strict();
export type CanvasSnapshot = z.infer<typeof CanvasSnapshotSchema>;
export type CardSnapshot = CanvasSnapshot["cards"][number];

export const HelloSchema = z.object({
  v: z.literal(1), type: z.literal("hello"), role: z.enum(["computer", "mobile"]),
  deviceId: Id, deviceName: z.string().trim().min(1).max(80),
  accessKey: z.string().min(16).max(256).optional(), token: Token.optional(),
  pairCode: z.string().regex(/^[A-Z0-9-]{6,32}$/).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.role === "computer" && ((!v.token && !v.accessKey) || v.pairCode)) ctx.addIssue({ code: "custom", message: "Computer authentication required" });
  if (v.role === "mobile" && ((!v.token && !v.pairCode) || v.accessKey || (v.token && v.pairCode))) ctx.addIssue({ code: "custom", message: "Mobile authentication required" });
});
export type Hello = z.infer<typeof HelloSchema>;
const ControllerSchema = z.object({ deviceId: Id, permissions: z.array(PermissionSchema).max(6) }).strict();
export const WelcomeSchema = z.object({
  v: z.literal(1), type: z.literal("welcome"), sessionId: Id, deviceId: Id, computerId: Id, epoch: Id,
  expiresAt: z.number().int().positive(), permissions: z.array(PermissionSchema).max(6), token: Token,
  pairCode: z.string().regex(/^[A-Z0-9-]{6,32}$/).optional(), pairExpiresAt: z.number().int().positive().optional(),
  controllers: z.array(ControllerSchema).max(20).optional(),
}).strict();
export type Welcome = z.infer<typeof WelcomeSchema>;
export const CommandSchema = z.object({
  ...scope, type: z.literal("command"), requestId: Id, canvasId: Id,
  ownerEpoch: Id, expectedVersion: Version, operation: OperationSchema,
}).strict();
export type Command = z.infer<typeof CommandSchema>;
export const ResultSchema = z.object({
  ...scope, type: z.literal("result"), forDeviceId: Id, requestId: Id,
  status: z.enum(["succeeded", "rejected", "cancelled", "unknown"]),
  message: z.string().max(500), version: Version.optional(),
}).strict();
export type Result = z.infer<typeof ResultSchema>;
export const FrameSchema = z.discriminatedUnion("type", [
  HelloSchema, WelcomeSchema, CommandSchema, ResultSchema,
  z.object({ ...scope, type: z.literal("snapshot"), sequence: Version, state: CanvasSnapshotSchema }).strict(),
  z.object({ ...scope, type: z.literal("snapshot.request") }).strict(),
  z.object({ ...scope, type: z.literal("file.request"), requestId: Id, canvasId: Id, ownerEpoch: Id, expectedVersion: Version, cardId: Id,
    imageId: Id.optional(), offset: z.number().int().min(0).max(10_000_000) }).strict(),
  z.object({ ...scope, type: z.literal("file.chunk"), forDeviceId: Id, requestId: Id, cardId: Id, offset: z.number().int().min(0).max(10_000_000), chunk: FileChunkDataSchema }).strict(),
  z.object({ ...scope, type: z.literal("file.error"), forDeviceId: Id, requestId: Id, message: z.string().max(200) }).strict(),
  z.object({ ...scope, type: z.literal("accepted"), requestId: Id }).strict(),
  z.object({ ...scope, type: z.literal("executing"), requestId: Id, forDeviceId: Id }).strict(),
  z.object({ ...scope, type: z.literal("cancel"), requestId: Id, canvasId: Id }).strict(),
  z.object({ ...scope, type: z.literal("query"), requestId: Id, canvasId: Id }).strict(),
  z.object({ ...scope, type: z.literal("heartbeat"), at: z.number().int().nonnegative() }).strict(),
  z.object({ ...scope, type: z.literal("pong"), at: z.number().int().nonnegative() }).strict(),
  z.object({ ...scope, type: z.literal("owner.status"), available: z.boolean() }).strict(),
  z.object({ ...scope, type: z.literal("status"), ownerAvailable: z.boolean(), reason: z.string().max(200).optional() }).strict(),
  z.object({ ...scope, type: z.literal("controller"), state: z.enum(["joined", "left"]), permissions: z.array(PermissionSchema).max(6) }).strict(),
  z.object({ ...scope, type: z.literal("revoke"), targetDeviceId: Id.optional() }).strict(),
  z.object({ ...scope, type: z.literal("revoked"), reason: z.string().max(200) }).strict(),
  z.object({ ...scope, type: z.literal("pair.rotate") }).strict(),
  z.object({ ...scope, type: z.literal("pairing"), pairCode: z.string().regex(/^[A-Z0-9-]{6,32}$/), pairExpiresAt: z.number().int().positive() }).strict(),
  z.object({ v: z.literal(1), type: z.literal("error"), code: z.string().max(80), message: z.string().max(300), requestId: Id.optional() }).strict(),
]);
export type Frame = z.infer<typeof FrameSchema>;
/** Use the same UTF-8 wire limit for object and serialized inputs. */
export function serializeFrame(frame: Frame): string | null {
  try {
    const serialized = JSON.stringify(frame);
    return new TextEncoder().encode(serialized).byteLength <= MAX_FRAME_BYTES ? serialized : null;
  } catch { return null; }
}
export function parseFrame(raw: unknown): Frame | null {
  try {
    if (typeof raw === "string") {
      if (new TextEncoder().encode(raw).byteLength > MAX_FRAME_BYTES) return null;
      raw = JSON.parse(raw);
    }
    const parsed = FrameSchema.safeParse(raw);
    return parsed.success && serializeFrame(parsed.data) !== null ? parsed.data : null;
  } catch { return null; }
}
