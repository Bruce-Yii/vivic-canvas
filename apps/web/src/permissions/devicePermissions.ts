import { resumeLocation } from "@/location/deviceLocation";
import { getVoiceConfiguration } from "@/ai/voiceConfig";

export type MicrophonePermissionPhase = "idle" | "requesting" | "granted" | "denied" | "unavailable" | "unsupported";
export interface MicrophonePermissionSnapshot { phase: MicrophonePermissionPhase; message: string }

let snapshot: MicrophonePermissionSnapshot = { phase: "idle", message: "打开 Vivic 时会请求麦克风权限，授权后不会自动录音。" };
const listeners = new Set<() => void>();
let pending: Promise<void> | null = null;
let startupRequested = false;

export const getMicrophonePermission = () => snapshot;
export const subscribeMicrophonePermission = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const update = (phase: MicrophonePermissionPhase, message: string) => {
  snapshot = { phase, message }; listeners.forEach(listener => listener());
};

/** Request permission only: never creates an audio context, recorder, or upload. */
export function requestMicrophonePermission(): Promise<void> {
  if (pending) return pending;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    update("unsupported", "此浏览器不支持麦克风授权，请使用 localhost 或 HTTPS；仍可输入文字。");
    return Promise.resolve();
  }
  update("requesting", "正在请求麦克风权限，请在浏览器提示中选择。");
  pending = (async () => {
    try {
      // Some browsers cannot query microphone permissions. Fall back to the
      // standard permission request, then immediately release every track.
      let permission: PermissionStatus | undefined;
      try { permission = await navigator.permissions?.query({ name: "microphone" as PermissionName }); }
      catch { /* Query support is optional. */ }
      if (permission?.state === "denied") {
        update("denied", "麦克风权限未开启。请在地址栏的站点权限中允许麦克风，再点击重新检查。");
        return;
      }
      if (permission?.state !== "granted") {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        stream.getTracks().forEach(track => track.stop());
      }
      update("granted", "麦克风已授权；按住说话或开启单次监听时才会录音。");
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        update("denied", "麦克风未获授权。可在站点权限中允许后重试；文字输入仍可使用。");
      } else if (name === "NotFoundError") {
        update("unavailable", "未找到麦克风，请连接设备后重试；文字输入仍可使用。");
      } else {
        update("unavailable", "麦克风暂不可用，请检查设备后重试；文字输入仍可使用。");
      }
    }
  })().finally(() => { pending = null; });
  return pending;
}

/** Called by the ready, foreground owner only; neither request blocks the other. */
export function requestStartupPermissions() {
  if (startupRequested || document.hidden) return;
  startupRequested = true;
  void resumeLocation().catch(() => {});
  if (getVoiceConfiguration().stt !== "none") void requestMicrophonePermission();
}
