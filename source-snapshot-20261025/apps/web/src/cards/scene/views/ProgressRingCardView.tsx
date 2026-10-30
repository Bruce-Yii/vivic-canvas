import { useId, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { SceneCardShell } from "../SceneCardShell";
import { useCardEditor } from "../cardContext";
import { daysBetween, formatMonthDay, todayIn } from "../dates";
import type { CardViewProps } from "../types";

const format = (value: number) => Number.isInteger(value) ? value.toLocaleString("zh-CN") : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });

/** Lightweight SVG ring: one track, one progress arc, CSS-transitioned on change only. */
export function ProgressRing({ ratio, size, label, sublabel }: { ratio: number; size: number; label: string; sublabel?: string }) {
  const gradient = useId();
  const stroke = Math.max(8, Math.round(size * 0.09));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const shown = Math.min(1, Math.max(0, ratio));
  return <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}${sublabel ? `，${sublabel}` : ""}`} data-progress-ring={shown}>
    <defs>
      <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="var(--vivic-accent)" />
        <stop offset="100%" stopColor="var(--vivic-accent-2)" />
      </linearGradient>
    </defs>
    <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--vivic-track)" strokeWidth={stroke} />
    <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={`url(#${gradient})`} strokeWidth={stroke} strokeLinecap="round"
      strokeDasharray={circumference} strokeDashoffset={circumference * (1 - shown)} transform={`rotate(-90 ${size / 2} ${size / 2})`}
      style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(0.25, 0.7, 0.25, 1)" }} />
    <text x="50%" y={sublabel ? "47%" : "52%"} textAnchor="middle" dominantBaseline="middle" fill="currentColor"
      style={{ fontSize: Math.min(size * 0.22, size * 1.1 / Math.max(5, label.length)), fontWeight: 650, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.03em" }}>{label}</text>
    {sublabel && <text x="50%" y="66%" textAnchor="middle" dominantBaseline="middle" fill="var(--vivic-muted-ink)" style={{ fontSize: Math.max(11, size * 0.085) }}>{sublabel}</text>}
  </svg>;
}

export function ProgressRingCardView({ card, height }: CardViewProps<"ProgressRingCard">) {
  const { title, current, target, unit, deadline, note } = card.displayProps;
  const ratio = target > 0 ? current / target : 0;
  const percent = Math.round(ratio * 100);
  const editor = useCardEditor(card);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const step = target >= 100 ? Math.max(1, Math.round(target / 100)) : 1;
  const left = deadline ? daysBetween(todayIn(), deadline) : null;
  const set = (value: number) => {
    if (!Number.isFinite(value)) { setError("请输入有效的完成量。"); return false; }
    const ok = editor.patch({ current: Math.max(0, Math.min(1e12, Math.round(value * 100) / 100)) });
    setError(ok ? null : "没有保存，已保留输入，请重试。");
    return ok;
  };
  const ringSize = height ? Math.max(96, Math.min(150, height - 120)) : 150;
  return <SceneCardShell card={card} height={height} title={title}
    badge={ratio >= 1 ? (ratio > 1 ? "已超额完成" : "已完成") : deadline ? (left !== null && left < 0 ? "已过截止日" : `截止 ${formatMonthDay(deadline)}`) : undefined}
    badgeTone={ratio >= 1 ? "positive" : left !== null && left < 0 ? "caution" : "accent"}>
    <div className="flex items-center justify-center" data-progress-percent={percent}>
      <ProgressRing ratio={ratio} size={ringSize} label={`${percent}%`} sublabel={ratio >= 1 ? "已达成" : "已完成"} />
    </div>
    <div className="vivic-progress-summary flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
      <span className="vivic-scene-muted vivic-scene-clamp-2">{note ?? (left !== null && left >= 0 ? `还剩 ${left} 天` : "当前进度")}</span>
      <strong className="min-w-0 max-w-full font-semibold tabular-nums" data-progress-values>{format(current)} / {format(target)}{unit ? ` ${unit}` : ""}</strong>
    </div>
    {editor.editable && <div className="flex flex-wrap items-center gap-1.5 nodrag nopan" data-progress-editor>
      <button type="button" className="vivic-scene-icon-button" aria-label={`减少 ${step}`} disabled={current <= 0} onClick={() => set(current - step)}><Minus size={15} /></button>
      <input className="vivic-scene-input w-24 text-center tabular-nums" inputMode="decimal" aria-label="当前完成量"
        value={draft ?? String(current)} onChange={event => setDraft(event.target.value)}
        aria-invalid={Boolean(error) || undefined}
        onBlur={() => { if (draft !== null) { if (!draft.trim()) setError("请输入完成量。"); else if (set(Number(draft))) setDraft(null); } }}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } if (event.key === "Escape") { setDraft(null); setError(null); } }} />
      <button type="button" className="vivic-scene-icon-button" aria-label={`增加 ${step}`} onClick={() => set(current + step)}><Plus size={15} /></button>
      <button type="button" className="vivic-scene-action ml-auto" disabled={current >= target} onClick={() => set(target)}>标记完成</button>
      {error && <p role="alert" className="m-0 w-full text-xs text-[var(--vivic-danger)]">{error}</p>}
    </div>}
  </SceneCardShell>;
}
