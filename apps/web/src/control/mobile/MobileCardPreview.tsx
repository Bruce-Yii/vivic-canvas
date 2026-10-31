import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import type { CardSnapshot } from "@vivic/mobile-console-prototype/protocol";
import { useEffect, useState, type ReactNode } from "react";
import { countdownPreviewValue, readCountdownPreview } from "./countdownPreview";
import "./mobile-card-preview.css";
import type { MobileClient } from "@vivic/mobile-console-prototype/client";
import { MobileImages } from "./MobileImages";
import { fileFormatLabel } from "@/files/filePresentation";

const glyphs: Record<string, string> = {
  text: "file", checklist: "list", metric: "point", table: "apps", timeline: "calendar", chart: "research", collection: "card",
};

/** Read-only portable view data from the paired owner, never a canvas or extension host. */
export function MobileCardPreview({ card, action, client, online = false }: { card: CardSnapshot; action?: ReactNode; client?: MobileClient; online?: boolean }) {
  if (card.type === "FileCard") return <div className="mobile-card-preview mobile-file-card-preview" data-mobile-card-preview={card.id}>
    <header className="mobile-card-preview-header"><span className="mobile-card-preview-mark mobile-file-preview-mark" aria-hidden="true"><HarkIcon name="file" size={18} /><small>{fileFormatLabel(card.file?.mediaType ?? "")}</small></span><h2>{card.file?.name ?? (card.title || "文件")}</h2>{action}</header>
  </div>;
  const preview = card.preview;
  const countdown = readCountdownPreview(card);
  if (countdown) return <MobileCountdown key={`${countdown.targetAt}:${countdown.paused}:${countdown.waiting}`} card={card} timer={countdown} action={action} />;
  const empty = preview && !preview.stat && (
    preview.kind === "checklist" || preview.kind === "timeline" ? !preview.items?.length
      : preview.kind === "chart" ? !preview.series?.length : preview.kind === "table" ? !preview.rows?.length
        : !preview.body?.trim() && !preview.items?.length);
  const title = preview?.body?.startsWith(card.title) && ["NoteCard", "QuoteCard"].includes(card.type)
    ? card.type === "NoteCard" ? "便笺" : "金句" : card.title || "未命名卡片";
  return <div className="mobile-card-preview" data-mobile-card-preview={card.id}>
    <header className="mobile-card-preview-header"><span className="mobile-card-preview-mark"><HarkIcon name={glyphs[preview?.kind ?? ""] ?? "card"} size={20} /></span><h2>{title}</h2>{action}</header>
    {client && (card.images?.length || card.imageNotice) ? <MobileImages card={card} client={client} online={online} /> : null}
    {!preview ? <p className="mobile-card-preview-muted">这张卡片的内容请在电脑端查看。</p> : <>
      {empty && <p className="mobile-card-preview-muted" data-mobile-card-empty>{preview.kind === "checklist" ? "暂无待办事项" : preview.kind === "timeline" ? "暂无安排或记录" : preview.kind === "chart" || preview.kind === "table" ? "暂无数据" : "暂无内容"}</p>}
      {preview.stat && <p className="mobile-card-preview-stat"><strong>{preview.stat.value}</strong>{preview.stat.unit && <span>{preview.stat.unit}</span>}</p>}
      {preview.body && <p className="mobile-card-preview-body">{preview.body}</p>}
      {Boolean(preview.items?.length) && <ul className={`mobile-card-preview-items mobile-card-preview-${preview.kind}`} aria-label="卡片内容">
        {preview.items!.map((item, index) => <li key={index} data-completed={item.checked || undefined}>
          {preview.kind === "checklist" && <span className="mobile-card-preview-check" aria-label={item.checked ? "已完成" : "未完成"}>{item.checked && <HarkIcon name="check" size={12} />}</span>}
          <div><p>{item.text}</p>{item.meta && <small>{item.meta}</small>}</div>
        </li>)}
      </ul>}
      {Boolean(preview.columns?.length) && preview.rows && <div className="mobile-card-preview-table" tabIndex={0} role="region" aria-label={`${card.title || "卡片"}的数据表`}>
        <table><caption className="sr-only">{card.title || "卡片"}的数据表</caption><thead><tr>{preview.columns!.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead><tbody>
          {preview.rows.map((row, index) => <tr key={index}>{preview.columns!.map((_, column) => <td key={column}>{row[column] ?? "—"}</td>)}</tr>)}
        </tbody></table>
      </div>}
      {Boolean(preview.series?.length) && <><div className="mobile-card-preview-chart" role="img" aria-label={`${card.title || "图表"}，${preview.series!.length} 个数据点；下方可查看数值`}>
        <ResponsiveContainer width="100%" height={176} minWidth={0}>
          <BarChart data={preview.series} margin={{ top: 12, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--hark-stroke)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--hark-secondary)", fontSize: 11 }} />
            <YAxis width={36} tickLine={false} axisLine={false} tick={{ fill: "var(--hark-secondary)", fontSize: 11 }} />
            <Tooltip cursor={{ fill: "var(--hark-wash)" }} contentStyle={{ background: "var(--hark-solid)", color: "var(--hark-ink)", border: "1px solid var(--hark-stroke)", borderRadius: 12, fontFamily: "var(--hark-font)" }} />
            <Bar dataKey="value" name="数值" fill="var(--hark-primary)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div><details className="mobile-card-preview-data"><summary>查看数值</summary><dl>{preview.series!.map((point, index) => <div key={index}><dt>{point.label}</dt><dd>{point.value}</dd></div>)}</dl></details></>}
      {preview.truncated && <p className="mobile-card-preview-muted mobile-card-preview-more">这里显示部分内容，完整内容可在电脑查看。</p>}
    </>}
  </div>;
}

function MobileCountdown({ card, timer, action }: { card: CardSnapshot; timer: NonNullable<ReturnType<typeof readCountdownPreview>>; action?: ReactNode }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (timer.paused || timer.waiting) return;
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [timer.targetAt, timer.paused, timer.waiting]);
  return <div className="mobile-card-preview mobile-card-countdown" data-mobile-card-preview={card.id} data-mobile-countdown={timer.reminder ? "reminder" : "timer"}>
    {timer.reminder && <h2>{timer.reminder}</h2>}
    <p className="mobile-card-countdown-digits" aria-label={timer.paused ? `已暂停，剩余 ${timer.value}` : timer.waiting ? "等待条件满足" : "剩余时间"}>{countdownPreviewValue(timer, now)}</p>
    {action && <div className="mobile-card-countdown-action">{action}</div>}
  </div>;
}
