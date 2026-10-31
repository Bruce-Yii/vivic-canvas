import { afterEach, beforeEach, expect, it, vi } from "vitest";
const notes: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
beforeEach(() => {
  vi.resetModules(); notes.length = 0;
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("AudioContext", class {
    state = "running"; currentTime = 100; destination = {};
    resume = vi.fn(async () => undefined);
    createOscillator() { const tone = { frequency: { value: 0 }, type: "sine", connect: vi.fn(), disconnect: vi.fn(), onended: null, start: vi.fn(), stop: vi.fn() }; notes.push(tone); return tone; }
    createGain() { return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }; }
  });
});
afterEach(() => vi.unstubAllGlobals());
it("does not synthesize before a user gesture, then schedules one short two-tone chime without TTS", async () => {
  const sound = await import("../sound");
  sound.playReminderSound(); expect(notes).toHaveLength(0);
  sound.armReminderSound(); expect(notes).toHaveLength(0);
  sound.playReminderSound(); expect(notes).toHaveLength(2);
  expect(notes[0]!.start).toHaveBeenCalledWith(100); expect(notes[1]!.start).toHaveBeenCalledWith(100.25);
  expect(notes[1]!.stop).toHaveBeenCalledWith(100.65);
  sound.setReminderSoundEnabled(false); sound.playReminderSound(); expect(notes).toHaveLength(2);
});
it("keeps visual reminders possible when audio devices fail", async () => {
  vi.stubGlobal("AudioContext", class { constructor() { throw new Error("device unavailable"); } });
  const sound = await import("../sound");
  expect(() => sound.armReminderSound()).not.toThrow(); expect(() => sound.playReminderSound()).not.toThrow();
});
it("honours a sound preference changed in another Control before takeover", async () => {
  let value: string | null = null;
  let changed!: (event: Pick<StorageEvent, "key">) => void;
  vi.stubGlobal("window", { localStorage: { getItem: () => value }, addEventListener: (_event: string, listener: typeof changed) => { changed = listener; } });
  const sound = await import("../sound");
  expect(sound.reminderSoundEnabled()).toBe(true);
  value = "0"; changed({ key: sound.REMINDER_SOUND_KEY });
  expect(sound.reminderSoundEnabled()).toBe(false);
  sound.armReminderSound(); sound.playReminderSound(); expect(notes).toHaveLength(0);
});
