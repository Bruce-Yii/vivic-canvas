import { z } from "zod";
import type { CardSnapshot } from "@vivic/mobile-console-prototype/protocol";

const iso = z.iso.datetime({ offset: true });
const digits = /^(?:\d+:)?[0-5]?\d:[0-5]\d$/;
export interface CountdownPreview { targetAt: string; paused: boolean; waiting: boolean; value: string; reminder?: string }

/** Decode only the existing owner's exact visible-summary format. No new wire fields. */
export function readCountdownPreview(card: CardSnapshot): CountdownPreview | null {
  const preview = card.preview;
  if (card.type !== "CountdownCard" || preview?.kind !== "metric" || !preview.body || preview.truncated || !preview.stat || preview.stat.unit) return null;
  const value = preview.stat.value;
  if (!digits.test(value) && value !== "等待") return null;
  const match = /^(?:(.*) · )?到期：([^\s]+)$/s.exec(preview.body);
  if (!match || !iso.safeParse(match[2]).success) return null;
  const prefix = match[1] ?? "", targetAt = match[2]!;
  if (card.title === "倒计时" && (prefix === "" || prefix === "已暂停")) {
    return { targetAt, paused: prefix === "已暂停", waiting: value === "等待", value };
  }
  // A reminder may itself contain separators; match its complete projected headline.
  if (prefix.endsWith(" · 已暂停")) {
    const reminder = prefix.slice(0, -" · 已暂停".length);
    if (reminder && card.title === reminder.slice(0, 160)) return { targetAt, paused: true, waiting: value === "等待", value, reminder };
  }
  if (prefix && card.title === prefix.slice(0, 160)) return { targetAt, paused: false, waiting: value === "等待", value, reminder: prefix };
  return null;
}

export function countdownPreviewValue(timer: CountdownPreview, now: number): string {
  if (timer.waiting || timer.paused) return timer.value;
  const total = Math.max(0, Math.ceil((Date.parse(timer.targetAt) - now) / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return total >= 3600 ? `${Math.floor(total / 3600)}:${two(Math.floor(total / 60) % 60)}:${two(total % 60)}` : `${two(Math.floor(total / 60))}:${two(total % 60)}`;
}
