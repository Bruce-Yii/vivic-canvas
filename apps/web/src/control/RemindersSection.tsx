import { NotificationSettings } from "./NotificationSettings";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Bell, Check, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { newId } from "@/lib/id";
import { remainingSeconds, resumeReminderSource, scheduleLabel, type ReminderSummary } from "@/reminders/reminders";
import type { ControlHost } from "@/sync/controlHost";

export const RemindersSection = ({ host, readonly, hidePreferences = false, external = false }: { host: ControlHost; readonly: boolean; hidePreferences?: boolean; external?: boolean }) => {
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const reminders = snapshot.reminders.filter(item => !item.card.sourceData.notifiedAt);
  const [now, setNow] = useState(Date.now);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [minutes, setMinutes] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const dispatch = (item: ReminderSummary, action: object) => {
    if (readonly) return false;
    if (host.getSnapshot().activeCanvasId !== item.canvasId) host.switchCanvas(item.canvasId);
    const result = host.dispatch({ schemaVersion: "0.6", requestId: newId("timer"), canvasId: item.canvasId, actions: [action] });
    setError(result.ok ? null : "提醒尚未修改，请重试。");
    return result.ok;
  };
  const pauseOrResume = (item: ReminderSummary) => {
    const source = item.card.sourceData;
    dispatch(item, { type: "card.update", targetId: item.card.id, sourceData: source.pausedAt
      ? resumeReminderSource(item.card, Date.now())
      : { pausedAt: new Date().toISOString() },
    });
  };

  return (
    <section className={external ? "vivic-reminders-panel" : "rounded-xl border border-neutral-200 bg-white p-4"} data-vivic-reminders data-vivic-reminders-external={external || undefined}>
      <div className="flex items-center gap-2 text-sm font-semibold"><Bell className="h-4 w-4" />提醒</div>
      <p className="mt-2 text-xs text-neutral-500">临近的提醒显示在 Space；到时提醒后会自动消失。使用提醒时请保持控制页打开。</p>
      {!hidePreferences && <NotificationSettings disabled={readonly} />}
      {reminders.length === 0 && <p className="mt-3 text-sm text-neutral-500">暂无提醒，可在聊天中创建。</p>}
      <ul className="mt-3 space-y-2">
        {reminders.map(item => {
          const card = item.card;
          const paused = Boolean(card.sourceData.pausedAt);
          const seconds = remainingSeconds(card, now);
          const label = scheduleLabel(card);
          const rowId = `${item.canvasId}:${card.id}`;
          return (
            <li key={rowId} className="rounded-lg border border-neutral-200 p-3" data-vivic-reminder={card.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium" data-vivic-reminder-text>{card.sourceData.reminderText ?? "倒计时"}</p>
                  <p className="mt-1 text-xs text-neutral-500" data-vivic-reminder-status>
                    {item.canvasTitle} · {paused ? "已暂停" : card.sourceData.condition && !card.sourceData.conditionMetAt ? "等待条件" : seconds === 0 ? "即将提示" : `剩余 ${Math.floor(seconds / 60)}分${seconds % 60}秒`}
                  </p>
                  {label && <p className="mt-1 text-xs text-neutral-500" data-vivic-reminder-schedule>{label}</p>}
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" disabled={readonly} onClick={() => pauseOrResume(item)} aria-label={`${paused ? "继续" : "暂停"}${card.sourceData.reminderText ?? "倒计时"}`}>
                    {paused ? <Play className="mr-1 h-3 w-3" /> : <Pause className="mr-1 h-3 w-3" />}{paused ? "继续" : "暂停"}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={readonly} onClick={() => {
                    setEditing(rowId); setText(card.sourceData.reminderText ?? "倒计时"); setMinutes(""); setError(null);
                  }}>修改</Button>
                  <Button variant="ghost" size="sm" disabled={readonly} onClick={() => dispatch(item, { type: "card.delete", targetId: card.id })}>取消提醒</Button>
                </div>
              </div>
              {editing === rowId && <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={event => {
                event.preventDefault();
                const delay = Number(minutes);
                if (!text.trim() || text.trim().length > 160 || !Number.isFinite(delay) || delay < 0.1 || delay > 1440) { setError("请输入提醒内容和 0.1–1440 分钟。" ); return; }
                const saved = dispatch(item, { type: "card.update", targetId: card.id, sourceData: {
                  reminderText: text.trim(), targetAt: new Date(Date.now() + delay * 60000).toISOString(),
                  startedAt: new Date().toISOString(), pausedAt: null, notifiedAt: null,
                  schedule: null, condition: null, conditionMetAt: null, lastDeliveredTargetAt: null, lastFiredAt: null,
                } });
                if (saved) setEditing(null);
              }}>
                <label className="min-w-40 flex-1 text-xs text-neutral-600">提醒内容<Input aria-label="提醒内容" maxLength={160} value={text} disabled={readonly} onChange={e => setText(e.target.value)} /></label>
                <label className="text-xs text-neutral-600">从现在起（分钟）<Input className="w-28" aria-label="提醒延后分钟" type="number" min="0.1" max="1440" step="0.1" required value={minutes} disabled={readonly} onChange={e => setMinutes(e.target.value)} /></label>
                <Button type="submit" size="sm" disabled={readonly}><Check className="mr-1 h-3 w-3" />保存</Button>
                {(card.sourceData.schedule || card.sourceData.condition) && <span className="text-xs text-neutral-500">保存后改为一次性倒计时。</span>}
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>取消</Button>
              </form>}
            </li>
          );
        })}
      </ul>
      {(error || snapshot.reminderError) && <p className="mt-2 text-xs text-red-700" role="alert">{error ?? snapshot.reminderError}</p>}
    </section>
  );
};
