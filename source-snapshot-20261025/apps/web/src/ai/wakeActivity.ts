export type WakePhase = "idle" | "loading" | "listening" | "recording" | "transcribing" | "delivering" | "done" | "error";
let snapshot: { phase: WakePhase; detected: boolean } = { phase: "idle", detected: false };
let active: symbol | null = null;
let cancel: (() => void) | null = null;
const listeners = new Set<() => void>();
export const getWakeActivity = () => snapshot;
export const subscribeWakeActivity = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const isWakeInputBusy = () => ["loading", "listening", "recording", "transcribing", "delivering"].includes(snapshot.phase);
const publish = (phase: WakePhase, detected = snapshot.detected) => { snapshot = { phase, detected }; listeners.forEach(listener => listener()); };
export function beginWakeActivity(stop: () => void) {
  cancelWakeActivity();
  const token = Symbol("wake"); active = token; cancel = stop; publish("loading", false);
  return {
    phase: (phase: WakePhase) => { if (active === token) publish(phase); },
    detected: () => { if (active === token) publish("recording", true); },
    end: () => { if (active === token) { active = null; cancel = null; publish("idle", false); } },
  };
}
export function cancelWakeActivity() { const stop = cancel; cancel = null; stop?.(); if (active) { active = null; publish("idle", false); } }
