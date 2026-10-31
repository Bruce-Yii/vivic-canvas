import { useState, useSyncExternalStore } from "react";
import { Switch, ToggleGroup } from "radix-ui";
import { Pin, PinOff } from "lucide-react";
import { CARD_TYPE_LABELS } from "@/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DEFAULT_DAY_START, DEFAULT_DAY_END } from "@/motion/motionDirector";
import { useVivicState, type DispatchResult } from "@/state/canvasStore";
import type { ControlHost } from "@/sync/controlHost";
import type { DisplayPreferences } from "@/sync/protocol";

export interface CanvasSettingsProps {
  host: ControlHost;
  disabled?: boolean;
  selectedCardId?: string | null;
  compact?: boolean;
  toolsOnly?: boolean;
}

/** Control-only: the parent owns placement; never mount this in Display. */
export const CanvasSettings = ({ host, disabled = false, selectedCardId, compact = false, toolsOnly = false }: CanvasSettingsProps) => {
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const cards = useVivicState(s => s.cards);
  const [error, setError] = useState<string | null>(null);
  const readonly = disabled || !snapshot.ready || snapshot.ownerMode !== "owner";
  const report = (result: DispatchResult) => setError(result.ok ? null : "设置尚未保存，请重试。");
  const update = (patch: Partial<DisplayPreferences>) => report(host.setPreferences(patch));
  const visible = cards.filter(c => !c.exitingRequestId && (!selectedCardId || c.record.id === selectedCardId));
  if (compact) return <section className="se-appearance" data-vivic-canvas-settings>
    <div className="se-row"><span id="compact-theme-label">主题</span>
      <ToggleGroup.Root type="single" value={snapshot.preferences.theme} disabled={readonly} aria-labelledby="compact-theme-label" className="se-theme"
        onValueChange={value => { if (value === "light" || value === "dark" || value === "auto") update({ theme: value }); }}>
        {([["light", "浅色"], ["dark", "深色"], ["auto", "自动"]] as const).map(([value, label]) => <ToggleGroup.Item key={value} value={value} asChild>
          <Button type="button" variant="ghost" size="sm" disabled={readonly}>{label}</Button>
        </ToggleGroup.Item>)}
      </ToggleGroup.Root>
    </div>
    <details className="se-details se-display-options"><summary>更多显示选项</summary>
      <div className="se-detail-body">
        {snapshot.preferences.theme === "auto" && <div className="se-schedule">
          {([["dayStart", "白天开始时间", DEFAULT_DAY_START], ["dayEnd", "白天结束时间", DEFAULT_DAY_END]] as const).map(([key, label, fallback]) => <label key={key}>
            <span>{label}</span><Input type="time" step={60} required disabled={readonly} aria-label={label} value={snapshot.preferences[key] ?? fallback}
              onChange={event => { if (event.target.value) update({ [key]: event.target.value }); }} />
          </label>)}
        </div>}
        {([["reducedMotion", "减少动效"], ["subtitles", "字幕"]] as const).map(([key, label]) => <div key={key} className="se-row">
          <label htmlFor={`compact-pref-${key}`}>{label}</label><Switch.Root id={`compact-pref-${key}`} className="se-switch" disabled={readonly} checked={snapshot.preferences[key]}
            onCheckedChange={checked => update({ [key]: checked })}><Switch.Thumb /></Switch.Root>
        </div>)}
      </div>
    </details>
    {snapshot.recovery && <p className="se-caption" role="status">已恢复兼容内容，不兼容卡片仍保留在导出备份中。</p>}
    {error && <p className="se-error" role="status">{error}</p>}
  </section>;
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4" data-vivic-canvas-settings>
      <h2 className="text-sm font-semibold">{toolsOnly ? "卡片布局" : "画布设置"}</h2>
      {snapshot.recovery && <p role="status" className="mt-2 text-xs text-amber-700" data-vivic-recovery-notice>
        已恢复兼容内容，{snapshot.recovery.quarantinedCardCount} 张不兼容卡片已单独保留。原始数据仍在，导出画布可一并备份。
      </p>}
      <fieldset disabled={readonly} className="mt-3 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-neutral-500">按卡片尺寸整理位置，固定卡片保留原位。</p>
          <Button type="button" variant="outline" size="sm" disabled={readonly} onClick={() => report(host.arrangeCanvas())} data-vivic-arrange>重新排布</Button>
        </div>
        {!toolsOnly && <><div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span id="canvas-theme-label">主题</span>
          <ToggleGroup.Root type="single" value={snapshot.preferences.theme} disabled={readonly}
            aria-labelledby="canvas-theme-label" className="flex gap-1" onValueChange={value => {
              if (value === "light" || value === "dark" || value === "auto") update({ theme: value });
            }}>
            {([["light", "浅色"], ["dark", "深色"], ["auto", "自动"]] as const).map(([value, label]) => (
              <ToggleGroup.Item key={value} value={value} asChild>
                <Button type="button" variant={snapshot.preferences.theme === value ? "secondary" : "ghost"} size="sm" disabled={readonly}>{label}</Button>
              </ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>
        </div>
        {snapshot.preferences.theme === "auto" && <div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            {([["dayStart", "白天开始时间", DEFAULT_DAY_START], ["dayEnd", "白天结束时间", DEFAULT_DAY_END]] as const).map(([key, label, fallback]) => (
              <label key={key} className="space-y-1">
                <span>{label}</span>
                <Input type="time" step={60} required disabled={readonly} aria-label={label}
                  aria-describedby="canvas-day-schedule-help" value={snapshot.preferences[key] ?? fallback}
                  onChange={event => { if (event.target.value) update({ [key]: event.target.value }); }} />
              </label>
            ))}
          </div>
          <p id="canvas-day-schedule-help" className="mt-2 text-xs text-neutral-500">按本机时间切换；结束早于开始时跨夜，相同时间为全天深色。</p>
        </div>}
        {([["reducedMotion", "减少动效"], ["subtitles", "字幕"]] as const).map(([key, label]) => (
          <div key={key} className="flex items-center justify-between gap-3 text-sm">
            <label htmlFor={`canvas-pref-${key}`}>{label}</label>
            <Switch.Root id={`canvas-pref-${key}`} checked={snapshot.preferences[key]} disabled={readonly}
              onCheckedChange={checked => update({ [key]: checked })}
              className="inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-neutral-200 p-0.5 data-[state=checked]:bg-neutral-900 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500">
              <Switch.Thumb className="block h-4 w-4 rounded-full bg-white data-[state=checked]:translate-x-4" />
            </Switch.Root>
          </div>
        ))}
        </>}
        <div className="border-t border-neutral-100 pt-3">
          <p className="text-xs font-medium text-neutral-600">固定卡片</p>
          {visible.length === 0 && <p className="mt-2 text-xs text-neutral-500">暂无卡片</p>}
          <ul className="mt-2 space-y-1">
            {visible.map(({ record }) => (
              <li key={`${snapshot.activeCanvasId}:${record.id}`} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 break-words">{record.metadata.aliases?.[0]
                  || (record.type === "CountdownCard" ? record.sourceData.event?.title ?? record.sourceData.reminderText : undefined)
                  || CARD_TYPE_LABELS[record.type]}</span>
                <Button type="button" variant="ghost" size="sm" disabled={readonly} aria-pressed={record.layout.pinned}
                  aria-label={`${record.layout.pinned ? "取消固定" : "固定"} ${record.id}`} data-vivic-pin={record.id}
                  onClick={() => report(host.setCardPinned(record.id, !record.layout.pinned, snapshot.activeCanvasId ?? undefined))}>
                  {record.layout.pinned ? <PinOff className="mr-1 h-3 w-3" /> : <Pin className="mr-1 h-3 w-3" />}
                  {record.layout.pinned ? "取消固定" : "固定"}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </fieldset>
      {error && <p role="status" className="mt-2 text-xs text-red-700">{error}</p>}
    </section>
  );
};
