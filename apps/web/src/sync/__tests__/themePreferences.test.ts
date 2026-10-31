import { describe, expect, it } from "vitest";
import { createMemoryDB } from "@/persistence/db";
import { createCanvasStore } from "@/state/canvasStore";
import { createControlHost } from "../controlHost";
import { createDisplayClient } from "../displayClient";
import { createMemoryHub, flushChannel } from "../channel";
import { createMemoryLockProvider } from "../testing";
import { DEFAULT_DISPLAY_PREFERENCES, DisplayPreferencesSchema } from "../protocol";

const legacy = { theme: "auto" as const, reducedMotion: false, subtitles: true };

describe("optional local daylight preferences", () => {
  it("preserves legacy records exactly without injecting schedule defaults", () => {
    expect(DisplayPreferencesSchema.parse(legacy)).toEqual(legacy);
    expect(DEFAULT_DISPLAY_PREFERENCES).toEqual(legacy);
    expect(DisplayPreferencesSchema.parse(legacy)).not.toHaveProperty("darkPalette");
    expect(DisplayPreferencesSchema.parse(legacy)).not.toHaveProperty("lightPalette");
    expect(DisplayPreferencesSchema.parse(legacy)).not.toHaveProperty("dayStart");
    expect(DisplayPreferencesSchema.parse(legacy)).not.toHaveProperty("dayEnd");
  });

  it.each(["00:00", "07:00", "19:45", "23:59"])("accepts exact local HH:mm %s", time => {
    expect(DisplayPreferencesSchema.parse({ ...legacy, dayStart: time, dayEnd: time })).toEqual({ ...legacy, dayStart: time, dayEnd: time });
  });

  it.each(["", "7:00", "24:00", "07:60", "07:00:00", "07:00Z", " 07:00", "19:00\n", null, 700])("rejects malformed schedule value %j", value => {
    expect(DisplayPreferencesSchema.safeParse({ ...legacy, dayStart: value }).success).toBe(false);
    expect(DisplayPreferencesSchema.safeParse({ ...legacy, dayEnd: value }).success).toBe(false);
  });

  it("syncs and restores an overnight schedule through the existing owner/persistence pipeline", async () => {
    const db = createMemoryDB(), hub = createMemoryHub(), locks = createMemoryLockProvider();
    const ownerStore = createCanvasStore(), displayStore = createCanvasStore();
    const host = createControlHost({ db, channel: hub.createChannel(), store: ownerStore, lockProvider: locks, reminderPollMs: 1000000 });
    const client = createDisplayClient({ db, channel: hub.createChannel(), store: displayStore });
    let revived: ReturnType<typeof createControlHost> | undefined;
    try {
      await host.start(); await client.start(); await flushChannel();
      expect(host.setPreferences({ dayStart: "22:15", dayEnd: "06:45" }).ok).toBe(true);
      await flushChannel();
      const expected = { ...DEFAULT_DISPLAY_PREFERENCES, dayStart: "22:15", dayEnd: "06:45" };
      expect(displayStore.getPreferences()).toEqual(expected);
      expect(JSON.parse((await db.getMeta("displayPreferences"))!)).toEqual(expected);
      expect(host.setPreferences({ dayStart: "25:00" }).ok).toBe(false);
      expect(host.getSnapshot().preferences).toEqual(expected);
      host.stop(); await flushChannel();
      revived = createControlHost({ db, channel: hub.createChannel(), store: createCanvasStore(), lockProvider: locks, reminderPollMs: 1000000 });
      await revived.start(); await flushChannel();
      expect(revived.getSnapshot().preferences).toEqual(expected);
      expect(displayStore.getPreferences()).toEqual(expected);
    } finally { client.stop(); host.stop(); revived?.stop(); }
  });

  it.each([["darkPalette", "milk"], ["lightPalette", "midnight"], ["darkPalette", "custom"], ["lightPalette", ""]])("rejects %s %j outside its own six palettes", (key, value) => {
    expect(DisplayPreferencesSchema.safeParse({ ...legacy, [key]: value }).success).toBe(false);
  });

  it("syncs and restores a chosen background palette with its appearance", async () => {
    const db = createMemoryDB(), hub = createMemoryHub(), locks = createMemoryLockProvider();
    const host = createControlHost({ db, channel: hub.createChannel(), store: createCanvasStore(), lockProvider: locks, reminderPollMs: 1000000 });
    const displayStore = createCanvasStore();
    const client = createDisplayClient({ db, channel: hub.createChannel(), store: displayStore });
    let revived: ReturnType<typeof createControlHost> | undefined;
    try {
      await host.start(); await client.start(); await flushChannel();
      expect(host.setPreferences({ theme: "light", lightPalette: "mint" }).ok).toBe(true);
      expect(host.setPreferences({ darkPalette: "ocean", orbPalette: "peach" }).ok).toBe(true);
      expect(host.setPreferences({ darkPalette: "peach" } as never).ok).toBe(false);
      await flushChannel();
      const expected = { ...DEFAULT_DISPLAY_PREFERENCES, theme: "light", lightPalette: "mint", darkPalette: "ocean", orbPalette: "peach" };
      expect(displayStore.getPreferences()).toEqual(expected);
      expect(displayStore.getState().ambient.theme).toBe("light");
      expect(JSON.parse((await db.getMeta("displayPreferences"))!)).toEqual(expected);
      host.stop(); await flushChannel();
      revived = createControlHost({ db, channel: hub.createChannel(), store: createCanvasStore(), lockProvider: locks, reminderPollMs: 1000000 });
      await revived.start(); await flushChannel();
      expect(revived.getSnapshot().preferences).toEqual(expected);
    } finally { client.stop(); host.stop(); revived?.stop(); }
  });
});
