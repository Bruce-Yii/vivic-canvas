import { useEffect, useState } from "react";
import { Check, CircleCheck, Info, Mail, MailOpen, OctagonAlert, Trash2, TriangleAlert, type LucideIcon } from "lucide-react";
import type { NotificationCard } from "@/contracts";
import { SceneCardShell, type BadgeTone } from "../SceneCardShell";
import { useCardActions, useCardEditor } from "../cardContext";
import { relativeTimeLabel } from "../dates";
import { rowsThatFit, useFitHeight } from "../DetailPopover";
import type { CardViewProps } from "../types";
import "./NotificationCardView.css";

type Notice = NotificationCard["displayProps"];
type NoticeStatus = NonNullable<Notice["status"]>;

const LEVELS: Record<Notice["level"], { icon: LucideIcon; label: string }> = {
  info: { icon: Info, label: "提示" },
  success: { icon: CircleCheck, label: "成功" },
  warning: { icon: TriangleAlert, label: "注意" },
  error: { icon: OctagonAlert, label: "错误" },
};
const STATUS: Record<NoticeStatus, { label: string; tone: BadgeTone }> = {
  unread: { label: "未读", tone: "accent" },
  read: { label: "已读", tone: "neutral" },
  done: { label: "已处理", tone: "positive" },
};

// Display line boxes (px), mirrored in NotificationCardView.css.
const TITLE_LINE = 20;
const META_ROW = 17;
const ROW_GAP = 4;
const BODY_LINE = 19;

const fullTime = (iso: string): string | undefined => {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    : undefined;
};

export function NotificationCardView({ card, height }: CardViewProps<"NotificationCard">) {
  const { title, body, level, at, source } = card.displayProps;
  const status: NoticeStatus = card.displayProps.status ?? "unread";
  const editor = useCardEditor(card);
  const [error, setError] = useState<string | null>(null);
  const updateStatus = (next: NoticeStatus) => setError(editor.patch({ status: next }) ? null : "没有保存，请重试。");
  const actions = useCardActions();
  const canRemove = editor.editable && Boolean(actions?.remove);
  const fixed = height !== undefined;
  const [boxRef, boxHeight] = useFitHeight<HTMLDivElement>(fixed);
  const [titleRef, titleHeight] = useFitHeight<HTMLParagraphElement>(fixed);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [at]);

  const kind = LEVELS[level] ?? LEVELS.info;
  const Icon = kind.icon;
  const badge = STATUS[status] ?? STATUS.unread;
  const time = at ? relativeTimeLabel(at, now) : "";
  const hasMeta = Boolean(time || source);
  const titleLines = boxHeight !== null && boxHeight < TITLE_LINE * 2 + (hasMeta ? ROW_GAP + META_ROW : 0) ? 1 : 2;
  const metaSpace = hasMeta ? META_ROW + ROW_GAP : 0;
  const bodyLines = !fixed ? undefined
    : rowsThatFit(boxHeight === null ? null : boxHeight - (titleHeight ?? titleLines * TITLE_LINE) - ROW_GAP - metaSpace, BODY_LINE, 3);

  return <SceneCardShell card={card} height={height} badge={badge.label} badgeTone={badge.tone}>
    <div ref={boxRef} className="vivic-notice" data-level={level} data-status={status}>
      <div className="vivic-notice-row" data-unread={status === "unread" || undefined}>
        <span className="vivic-notice-icon" role="img" aria-label={kind.label}><Icon size={18} strokeWidth={2.1} aria-hidden /></span>
        <div className="vivic-notice-main">
          <p ref={titleRef} className="vivic-notice-title" style={{ WebkitLineClamp: fixed ? titleLines : undefined }} title={fixed ? title : undefined} data-notice-title>{title}</p>
          {body && bodyLines !== 0 && <p className="vivic-notice-body" style={bodyLines ? { WebkitLineClamp: bodyLines } : undefined} title={fixed ? body : undefined} data-notice-body>{body}</p>}
          {hasMeta && <p className="vivic-notice-meta" data-notice-meta>
            {time && <time dateTime={at} title={at ? fullTime(at) : undefined}>{time}</time>}
            {time && source ? " · " : ""}{source}
          </p>}
        </div>
      </div>
    </div>
    {editor.editable && <div className="vivic-notice-tools nodrag nopan" data-notice-tools>
      {status === "unread"
        ? <button type="button" className="vivic-scene-action" onClick={() => updateStatus("read")} data-notice-read><MailOpen size={13} aria-hidden />标为已读</button>
        : <button type="button" className="vivic-scene-action" onClick={() => updateStatus("unread")} data-notice-unread><Mail size={13} aria-hidden />标为未读</button>}
      <button type="button" className="vivic-scene-action" disabled={status === "done"} onClick={() => updateStatus("done")} data-notice-done>
        <Check size={13} aria-hidden />完成
      </button>
      {canRemove && <button type="button" className="vivic-scene-action ml-auto" onClick={() => setError(editor.remove() ? null : "没有移除，请重试。")} data-notice-remove>
        <Trash2 size={13} aria-hidden />移除
      </button>}
      {error && <p role="alert" className="m-0 w-full text-xs text-[var(--vivic-danger)]">{error}</p>}
    </div>}
  </SceneCardShell>;
}
