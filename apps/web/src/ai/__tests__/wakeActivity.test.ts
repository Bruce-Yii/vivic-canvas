import { afterEach, describe, expect, it, vi } from "vitest";
import { beginWakeActivity, cancelWakeActivity, getWakeActivity, isWakeInputBusy } from "../wakeActivity";
afterEach(cancelWakeActivity);
describe("wake activity follows a live foreground session", () => {
  it("does not listen on import and only detects an actual wake event", () => {
    expect(isWakeInputBusy()).toBe(false);
    const session = beginWakeActivity(() => session.end());
    session.phase("listening"); expect(getWakeActivity()).toEqual({ phase: "listening", detected: false });
    session.detected(); expect(getWakeActivity()).toEqual({ phase: "recording", detected: true });
    session.end(); expect(isWakeInputBusy()).toBe(false);
    session.phase("recording"); expect(isWakeInputBusy()).toBe(false);
  });
  it("cancels the previous session and ignores its late events", () => {
    const stop = vi.fn(), first = beginWakeActivity(stop), second = beginWakeActivity(() => second.end());
    expect(stop).toHaveBeenCalledOnce();
    first.detected(); first.end(); expect(getWakeActivity()).toEqual({ phase: "loading", detected: false });
    cancelWakeActivity(); expect(isWakeInputBusy()).toBe(false);
  });
});
