/** Device picker is invoked only by the user's click; never request a microphone. */
type OutputDevices = MediaDevices & { selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo> };
export const canSelectAudioOutput = () => typeof navigator !== "undefined" &&
  typeof (navigator.mediaDevices as OutputDevices | undefined)?.selectAudioOutput === "function" &&
  typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
export async function selectAudioOutput(deviceId?: string): Promise<MediaDeviceInfo> {
  if (!canSelectAudioOutput()) throw new Error("此浏览器不支持选择输出设备，请在系统声音设置中切换。");
  return (navigator.mediaDevices as OutputDevices).selectAudioOutput!({ ...(deviceId ? { deviceId } : {}) });
}
export async function routeAudioOutput(audio: HTMLMediaElement, deviceId?: string) {
  if (!deviceId) return;
  const sink = audio as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (!sink.setSinkId) throw new Error("当前浏览器不支持指定的输出设备，请重新选择或切换系统默认输出。");
  try { await sink.setSinkId(deviceId); }
  catch { throw new Error("所选输出设备不可用或权限已失效，请重新选择；本次没有播放。"); }
}
