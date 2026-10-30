import type { Action } from "@vivic/contracts";

const SAY_LIMIT = 40;
const TEXT_LIMIT = 120;
const LIST_SYMBOL = /[•‣⁃∙·●○◦▪▫■□☐☑✓✔◆◇①-⑳]/u;
const LIST_PREFIX = /(?:^|\s)(?:[-*+]|\p{Nd}+[.．](?!\p{Nd})|(?:\p{Nd}+|[一二三四五六七八九十百]+)[、)）]|[（(](?:\p{Nd}+|[一二三四五六七八九十百]+)[)）])/u;

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function truncate(value: string, limit: number): string {
  // Zod measures UTF-16 units; a truncated subtitle must still contain whole pairs.
  const shortened = value.slice(0, limit);
  return shortened.replace(/[\uD800-\uDBFF]$/u, "").trimEnd();
}

function safeSay(value: unknown): string | undefined {
  const say = nonemptyString(value);
  if (!say || say.length > SAY_LIMIT || /http/iu.test(say) || /\p{Nd}{6,}/u.test(say)
    || LIST_SYMBOL.test(say) || LIST_PREFIX.test(say)) return undefined;
  return say;
}

function subtitleText(value: unknown): string | undefined {
  const text = nonemptyString(value);
  return text ? truncate(text, TEXT_LIMIT) || undefined : undefined;
}

export function normalizeOutputChannels(
  input: { say?: unknown; text?: unknown },
  fallbackText?: string,
): { say?: string; text?: string } {
  const text = subtitleText(input.text) ?? subtitleText(fallbackText);
  // Keep URLs and long numbers on screen. Never read an unsafe fallback aloud.
  const firstSentence = text?.match(/^[\s\S]*?(?:[。！？!?]|\.(?!\p{Nd})|\r?\n|$)/u)?.[0] ?? "";
  const say = safeSay(input.say) ?? safeSay(truncate(firstSentence, SAY_LIMIT));
  return { ...(say ? { say } : {}), ...(text ? { text } : {}) };
}

export function applyOutputChannels(
  actions: Action[],
  channels: { say?: string; text?: string },
): { actions: Action[]; spokenText?: string } {
  const text = subtitleText(channels.text);
  const say = safeSay(channels.say);
  const nextActions: Action[] = actions.filter(action => action.type !== "subtitle.show");
  if (text) nextActions.push({ type: "subtitle.show", text });
  return { actions: nextActions, ...(say ? { spokenText: say } : {}) };
}
