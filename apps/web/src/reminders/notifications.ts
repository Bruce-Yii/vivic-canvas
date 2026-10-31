import type { ReminderNotice } from "./reminders";
export const NOTIFICATION_PREFERENCE = "vivic.reminders.notifications.v1";
const listeners = new Set<() => void>();
const live = new Map<string, Notification>();
const seen = new Set<string>();
let generation = 0;
export const notificationSupported = () => typeof Notification !== "undefined";
export function notificationsEnabled() {
  try { return notificationSupported() && Notification.permission === "granted" && localStorage.getItem(NOTIFICATION_PREFERENCE) === "1"; }
  catch { return false; }
}
export const subscribeNotifications = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function disableNotifications() {
  generation++;
  localStorage.removeItem(NOTIFICATION_PREFERENCE);
  live.forEach(value => value.close()); live.clear(); seen.clear(); listeners.forEach(fn => fn());
}
export async function enableNotifications() {
  if (!notificationSupported()) throw new Error("此浏览器不支持系统通知。");
  const acceptedGeneration = ++generation;
  const permission = await Notification.requestPermission();
  if (acceptedGeneration !== generation) return;
  if (permission !== "granted") throw new Error("系统通知权限未开启，画布内提醒照常显示。");
  localStorage.setItem(NOTIFICATION_PREFERENCE, "1"); listeners.forEach(fn => fn());
}
/** Called only for newly persisted deliveries by the current Control owner. */
export function notifyReminder(notice: ReminderNotice) {
  if (!notificationsEnabled() || seen.has(notice.id)) return;
  try {
    const notification = new Notification("Vivic 提醒", { body: notice.text.slice(0, 160), silent: true,
      tag: `vivic:${notice.canvasId}:${notice.cardId}:${notice.targetAt}` });
    seen.add(notice.id); if (seen.size > 100) seen.delete(seen.values().next().value!);
    live.set(notice.id, notification);
    notification.onclose = () => live.delete(notice.id);
    while (live.size > 20) { const key = live.keys().next().value!; live.get(key)?.close(); live.delete(key); }
  } catch { /* OS restrictions must not block persisted in-canvas delivery. */ }
}
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key === NOTIFICATION_PREFERENCE || event.key === null) {
    if (!notificationsEnabled()) { live.forEach(value => value.close()); live.clear(); }
    listeners.forEach(fn => fn());
  }
});
