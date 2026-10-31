import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { disableNotifications, enableNotifications, notificationSupported, notificationsEnabled, subscribeNotifications } from "@/reminders/notifications";
import { armReminderSound, reminderSoundEnabled, setReminderSoundEnabled, subscribeReminderSound } from "@/reminders/sound";
import { PreferenceToggle } from "./PreferenceToggle";
export function NotificationSettings({ disabled, compact = false }: { disabled: boolean; compact?: boolean }) {
  const enabled = useSyncExternalStore(subscribeNotifications, notificationsEnabled);
  const sound = useSyncExternalStore(subscribeReminderSound, reminderSoundEnabled);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  if (compact) return <div className="se-detail-body" data-vivic-notifications>
    <PreferenceToggle label="到时提示音" checked={sound} disabled={disabled} onChange={value => { setReminderSoundEnabled(value); if (value) armReminderSound(); }} />
    <PreferenceToggle label="系统通知" checked={enabled} disabled={disabled || busy || !notificationSupported()} onChange={async value => {
      setError(null); if (!value) { disableNotifications(); return; }
      setBusy(true); try { await enableNotifications(); } catch (cause) { setError(cause instanceof Error ? cause.message : "无法开启通知。"); } finally { setBusy(false); }
    }} />
    <p className="se-caption">关闭浏览器或系统休眠时，无法保证准点提醒。</p>
    {error && <p className="se-error" role="alert">{error}</p>}
  </div>;
  return <div className="mt-3" data-vivic-notifications>
    <Button size="sm" variant="outline" className="mr-2" disabled={disabled} data-vivic-reminder-sound aria-pressed={sound} onClick={() => {
      setReminderSoundEnabled(!sound); if (!sound) armReminderSound();
    }}>{sound ? "关闭到时提示音" : "开启到时提示音"}</Button>
    <Button size="sm" variant="outline" disabled={disabled || busy || !notificationSupported()} data-vivic-notification-toggle onClick={async () => {
      setError(null); if (enabled) { disableNotifications(); return; }
      setBusy(true); try { await enableNotifications(); } catch (error) { setError(error instanceof Error ? error.message : "无法开启通知。"); } finally { setBusy(false); }
    }}>{enabled ? "关闭系统通知" : "开启静音系统通知"}</Button>
    <p className="mt-1 text-xs text-neutral-500">首次点击控制页后可播放到时提示音；系统通知另需授权。关闭浏览器或系统休眠时不能保证准点提醒。</p>
    {error && <p className="mt-1 text-xs text-amber-700" role="alert">{error}</p>}
  </div>;
}
