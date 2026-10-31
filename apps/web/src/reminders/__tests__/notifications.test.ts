import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disableNotifications, enableNotifications, notificationsEnabled, notifyReminder } from "../notifications";
const notice = { id: "TEST-id", canvasId: "TEST-canvas", canvasTitle: "TEST", cardId: "TEST-card", text: "TEST 喝水", targetAt: "2026-10-15T08:00:00Z", firedAt: "2026-10-15T08:00:01Z" };
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(() => { disableNotifications(); vi.unstubAllGlobals(); });
describe("explicit silent owner notifications", () => {
  it("requests permission only on opt-in, deduplicates occurrences, closes on reset", async () => {
    const created: { options: NotificationOptions; close: ReturnType<typeof vi.fn> }[] = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      close = vi.fn();
      constructor(_title: string, options: NotificationOptions) { created.push({ options, close: this.close }); }
    }
    vi.stubGlobal("Notification", FakeNotification);
    notifyReminder(notice); expect(created).toHaveLength(0); expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    await enableNotifications(); expect(notificationsEnabled()).toBe(true);
    notifyReminder(notice); notifyReminder(notice); expect(created).toHaveLength(1);
    expect(created[0]!.options).toMatchObject({ silent: true, body: notice.text });
    disableNotifications(); expect(created[0]!.close).toHaveBeenCalledOnce(); expect(notificationsEnabled()).toBe(false);
  });
  it("keeps notification preference off when permission is denied", async () => {
    vi.stubGlobal("Notification", class { static permission = "denied"; static requestPermission = async () => "denied"; });
    await expect(enableNotifications()).rejects.toThrow("未开启"); expect(notificationsEnabled()).toBe(false);
  });
  it("does not restore notification preferences if permission arrives after reset", async () => {
    let allow!: (value: string) => void;
    vi.stubGlobal("Notification", class { static permission = "granted"; static requestPermission = () => new Promise<string>(resolve => { allow = resolve; }); });
    const pending = enableNotifications(); disableNotifications(); allow("granted"); await pending;
    expect(notificationsEnabled()).toBe(false);
  });
});
