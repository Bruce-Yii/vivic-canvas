import { z } from "zod";
import { CommonShape } from "./cardCommon";

/** Decimal MB, matching the upload and Space capacity labels. */
export const FILE_LIMITS = Object.freeze({ count: 5, batchBytes: 10_000_000, spaceBytes: 100_000_000, textChars: 80_000 });
/** Legacy types stay valid for saved cards/downloads; only these two may be read. */
export const isReadableFile = (mediaType: string) => mediaType === "application/pdf" || mediaType === "text/markdown";
export const FileCardSchema = z.strictObject({
  ...CommonShape,
  type: z.literal("FileCard"),
  displayProps: z.strictObject({
    fileId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    name: z.string().trim().min(1).max(240).regex(/^[^\p{Cc}]+$/u),
    mediaType: z.enum(["text/plain", "text/markdown", "text/csv", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/json"]),
    sizeBytes: z.number().int().min(0).max(FILE_LIMITS.batchBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    previewText: z.string().max(1600).optional(),
    pageCount: z.number().int().min(1).max(100000).optional(),
    parseStatus: z.enum(["ready", "partial", "empty", "unsupported", "error"]),
  }),
  sourceData: z.strictObject({}),
});
export type FileCard = z.infer<typeof FileCardSchema>;
