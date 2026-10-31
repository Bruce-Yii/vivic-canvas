/** A short local chime, independent of paid speech synthesis. Only the elected
 * Control owner plays it. Audio is unlocked by an explicit browser gesture. */
export const REMINDER_SOUND_KEY = "vivic.reminders.sound.v1";
let audio: AudioContext | undefined;
let enabled = true;
const listeners = new Set<() => void>();
export const subscribeReminderSound = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const reminderSoundEnabled = () => enabled;
try { if (typeof window !== "undefined") enabled = window.localStorage.getItem(REMINDER_SOUND_KEY) !== "0"; } catch { /* server/test */ }
export function setReminderSoundEnabled(value: boolean) {
  enabled = value;
  try { localStorage.setItem(REMINDER_SOUND_KEY, value ? "1" : "0"); } catch { /* optional preference */ }
  listeners.forEach(fn => fn());
}
export function armReminderSound() {
  if (!enabled || typeof AudioContext === "undefined") return;
  try {
    if (audio?.state === "closed") audio = undefined;
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume().catch(() => undefined);
  } catch { /* visual delivery remains available */ }
}
export function playReminderSound() {
  if (!enabled || !audio || audio.state !== "running") return;
  try {
    const began = audio.currentTime;
    for (const [offset, frequency] of [[0, 660], [0.25, 880]] as const) {
      const tone = audio.createOscillator(), gain = audio.createGain();
      tone.type = "sine"; tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0, began + offset);
      gain.gain.linearRampToValueAtTime(0.18, began + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, began + offset + 0.35);
      tone.connect(gain); gain.connect(audio.destination);
      tone.onended = () => { tone.disconnect(); gain.disconnect(); };
      tone.start(began + offset); tone.stop(began + offset + 0.4);
    }
  } catch { /* A device failure must never suppress the visual delivery. */ }
}
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key !== REMINDER_SOUND_KEY && event.key !== null) return;
  try { enabled = window.localStorage.getItem(REMINDER_SOUND_KEY) !== "0"; } catch { return; }
  listeners.forEach(fn => fn());
});
