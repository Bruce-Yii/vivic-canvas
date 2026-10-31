/**
 * Shared surface normalization for deterministic commands.
 *
 * The rule layer used to grow one regex per command and per word order. That
 * made the same request succeed or fail depending on a polite prefix, a
 * measure word, trailing punctuation or the order of the duration and the
 * noun. This module only removes *request framing* (please/for-me, a creation
 * verb, a measure word) and sentence-final punctuation; it never decides
 * whether a command is supported and never rewrites user content. Every
 * command parser keeps its own content guards and can still defer.
 */

const POLITE = /^(?:请您|请你|麻烦您|麻烦你|请|麻烦|劳驾|帮我|给我|替我|帮忙)\s*/u;

/** Removes stacked politeness ("请帮我", "麻烦给我") without touching content. */
export const stripPoliteness = (text: string): string => {
  let rest = text.trim();
  for (;;) {
    const next = rest.replace(POLITE, "").trimStart();
    if (next === rest) return rest;
    rest = next;
  }
};

/** Sentence-final punctuation belongs to the request frame, not to a duration,
 * measure word or view command. `？` is deliberately kept: a question is not a
 * command and must keep deferring. */
export const trimTerminalPunctuation = (text: string): string =>
  text.trim().replace(/[。！!，,；;、]+$/u, "").trimEnd();

/** Canonical form for commands whose whole body is a fixed phrase. */
export const normalizeSimpleCommand = (text: string): string =>
  trimTerminalPunctuation(stripPoliteness(text)).replace(/\s+/gu, "");

/** One optional measure word. "一个" must not eat the "一" of "一个半小时". */
const QUANTIFIER = /^(?:一个(?!半|钟头)|个(?!半|钟头)|一张|张|一条|条|一份|份|一下|下)\s*/u;

export interface RequestFrame {
  /** Text after the polite prefix, one optional verb and one optional measure word. */
  rest: string;
  verb?: string;
  quantifier?: string;
}

const longestFirst = (verbs: readonly string[]): string[] => [...verbs].sort((a, b) => b.length - a.length);

/**
 * Strips the request frame in front of a noun-first command:
 * "帮我创建一个倒计时 30 分钟" → "倒计时 30 分钟".
 * The caller still owns the noun and the content guards.
 */
export const stripRequestFrame = (text: string, verbs: readonly string[]): RequestFrame => {
  let rest = stripPoliteness(text);
  let verb: string | undefined;
  for (const candidate of longestFirst(verbs)) {
    if (!rest.startsWith(candidate)) continue;
    verb = candidate;
    rest = rest.slice(candidate.length).trimStart();
    break;
  }
  const quantifier = rest.match(QUANTIFIER)?.[0];
  if (quantifier) rest = rest.slice(quantifier.length).trimStart();
  return { rest, verb, quantifier };
};

export const COUNTDOWN_VERBS = ["创建", "新建", "添加", "新增", "设置", "设", "定", "来", "搞", "弄", "建", "加"] as const;
export const TODO_VERBS = ["添加", "新增", "创建", "新建", "记录", "安排", "列", "写", "加", "来", "搞", "弄", "建", "记"] as const;
