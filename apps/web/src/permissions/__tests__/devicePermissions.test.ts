// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resumeLocation: vi.fn(async () => {}), stt: "local" }));
vi.mock("@/location/deviceLocation", () => ({ resumeLocation: mocks.resumeLocation }));
vi.mock("@/ai/voiceConfig", () => ({ getVoiceConfiguration: () => ({ stt: mocks.stt }) }));

let query: ReturnType<typeof vi.fn>, media: ReturnType<typeof vi.fn>, stop: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules(); mocks.resumeLocation.mockClear(); mocks.stt = "local";
  stop = vi.fn(); query = vi.fn(async () => ({ state: "prompt" }));
  media = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
  vi.stubGlobal("navigator", { permissions: { query }, mediaDevices: { getUserMedia: media } });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
afterEach(() => vi.unstubAllGlobals());

describe("startup device permissions without recording or real devices", () => {
  it("requests both once and immediately stops the permission-only microphone stream", async () => {
    const permissions = await import("../devicePermissions");
    permissions.requestStartupPermissions(); permissions.requestStartupPermissions();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(mocks.resumeLocation).toHaveBeenCalledOnce();
    expect(media).toHaveBeenCalledExactlyOnceWith({ audio: true, video: false });
    expect(permissions.getMicrophonePermission().phase).toBe("granted");
  });

  it.each(["granted", "denied"])("only checks a %s microphone permission without reopening the device", async state => {
    query.mockResolvedValue({ state });
    const permissions = await import("../devicePermissions");
    await permissions.requestMicrophonePermission();
    expect(media).not.toHaveBeenCalled(); expect(permissions.getMicrophonePermission().phase).toBe(state);
  });

  it("falls back to the standard permission request when querying microphones is unsupported", async () => {
    query.mockRejectedValue(new TypeError("Unsupported permission name"));
    const permissions = await import("../devicePermissions");
    await permissions.requestMicrophonePermission();
    expect(stop).toHaveBeenCalledOnce(); expect(permissions.getMicrophonePermission().phase).toBe("granted");
  });

  it.each([["NotAllowedError", "denied"], ["NotFoundError", "unavailable"], ["NotReadableError", "unavailable"]])
    ("exposes %s without blocking text input or leaking device errors", async (name, expected) => {
      media.mockRejectedValue(new DOMException("TEST private device error", name));
      const permissions = await import("../devicePermissions");
      await permissions.requestMicrophonePermission();
      expect(permissions.getMicrophonePermission().phase).toBe(expected);
      expect(permissions.getMicrophonePermission().message).not.toContain("TEST private");
    });

  it("does not request until foreground and skips microphones when the user chose text only", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    const permissions = await import("../devicePermissions");
    permissions.requestStartupPermissions(); expect(mocks.resumeLocation).not.toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    mocks.stt = "none"; permissions.requestStartupPermissions();
    expect(mocks.resumeLocation).toHaveBeenCalledOnce(); expect(media).not.toHaveBeenCalled();
  });

  it("keeps ignored permission prompts independent, deduplicates requests, and releases a late stream", async () => {
    let grant!: (stream: { getTracks: () => { stop: typeof stop }[] }) => void;
    media.mockImplementation(() => new Promise(resolve => { grant = resolve; }));
    const permissions = await import("../devicePermissions");
    const first = permissions.requestMicrophonePermission();
    expect(permissions.requestMicrophonePermission()).toBe(first);
    permissions.requestStartupPermissions();
    expect(mocks.resumeLocation).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(media).toHaveBeenCalledOnce());
    grant({ getTracks: () => [{ stop }] }); await first;
    expect(stop).toHaveBeenCalledOnce(); expect(permissions.getMicrophonePermission().phase).toBe("granted");
  });

  it("does not request devices on insecure origins", async () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    const permissions = await import("../devicePermissions");
    await permissions.requestMicrophonePermission();
    expect(media).not.toHaveBeenCalled(); expect(permissions.getMicrophonePermission().phase).toBe("unsupported");
  });
});
