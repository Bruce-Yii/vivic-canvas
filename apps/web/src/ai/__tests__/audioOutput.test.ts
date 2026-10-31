import { afterEach, describe, expect, it, vi } from "vitest";
import { canSelectAudioOutput, routeAudioOutput, selectAudioOutput } from "../audioOutput";
afterEach(() => vi.unstubAllGlobals());
describe("explicit output routing without microphone or sound", () => {
  it("does not enumerate devices or request permission until the picker is invoked", async () => {
    const select = vi.fn(async () => ({ deviceId: "TEST-headset" })), mic = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { selectAudioOutput: select, getUserMedia: mic } });
    vi.stubGlobal("HTMLMediaElement", class { setSinkId() {} });
    expect(canSelectAudioOutput()).toBe(true); expect(select).not.toHaveBeenCalled();
    expect((await selectAudioOutput()).deviceId).toBe("TEST-headset"); expect(mic).not.toHaveBeenCalled();
  });
  it("leaves system default alone and fails closed for a selected unavailable sink", async () => {
    const setSinkId = vi.fn().mockRejectedValue(new Error("offline"));
    const audio = { setSinkId } as unknown as HTMLMediaElement;
    await routeAudioOutput(audio); expect(setSinkId).not.toHaveBeenCalled();
    await expect(routeAudioOutput(audio, "TEST-missing")).rejects.toThrow("本次没有播放");
    expect(setSinkId).toHaveBeenCalledWith("TEST-missing");
    await expect(routeAudioOutput({} as HTMLMediaElement, "TEST")).rejects.toThrow("不支持");
  });
});
