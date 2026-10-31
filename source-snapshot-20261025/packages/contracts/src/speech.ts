import { z } from "zod";

/** Provider times in milliseconds, mapped only to exactly matching UTF-16 text. */
export const SpeechWordSchema = z.strictObject({
  startMs: z.number().int().min(0).max(120000), endMs: z.number().int().min(0).max(120000),
  charStart: z.number().int().min(0).max(200), charEnd: z.number().int().min(1).max(200),
}).refine(word => word.startMs < word.endMs && word.charStart < word.charEnd);
export type SpeechWord = z.infer<typeof SpeechWordSchema>;
export const SpeechWordsSchema = z.array(SpeechWordSchema).max(400);

/** Unusable/misaligned timestamps degrade to sentence subtitles, never guessed timing. */
export function validSpeechWords(text: string, raw: unknown): SpeechWord[] {
  const parsed = SpeechWordsSchema.safeParse(raw);
  if (!parsed.success) return [];
  let previousEnd = 0, previousChar = 0;
  for (const word of parsed.data) {
    if (word.charEnd > text.length || word.startMs < previousEnd || word.charStart < previousChar
      || /[\uD800-\uDBFF]/u.test(text[word.charEnd - 1]!) || /[\uDC00-\uDFFF]/u.test(text[word.charStart]!)) return [];
    previousEnd = word.endMs; previousChar = word.charEnd;
  }
  return parsed.data;
}

export const TimedSpeechResponseSchema = z.strictObject({
  audioBase64: z.string().min(4).max(5592408).refine(value => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)),
  words: SpeechWordsSchema,
});
