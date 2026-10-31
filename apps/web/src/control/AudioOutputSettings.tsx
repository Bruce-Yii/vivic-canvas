import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { getSpeechSnapshot, setSpeechPreferences, subscribeSpeech } from "@/ai/speech";
import { canSelectAudioOutput, selectAudioOutput } from "@/ai/audioOutput";
export function AudioOutputSettings({ disabled }: { disabled: boolean }) {
  const generation = useRef(0);
  useEffect(() => {
    const cancel = () => { generation.current++; };
    window.addEventListener("vivic:voice-config-change", cancel);
    return () => { cancel(); window.removeEventListener("vivic:voice-config-change", cancel); };
  }, []);
  useEffect(() => { if (disabled) generation.current++; }, [disabled]);
  const speech = useSyncExternalStore(subscribeSpeech, getSpeechSnapshot);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const choose = async () => {
    const acceptedGeneration = ++generation.current;
    setBusy(true); setError(null);
    try { const device = await selectAudioOutput(speech.preferences.outputDeviceId); if (acceptedGeneration === generation.current) setSpeechPreferences({ outputDeviceId: device.deviceId }); }
    catch (error) { if (acceptedGeneration === generation.current) setError(error instanceof Error ? error.message : "没有选择输出设备。"); }
    finally { setBusy(false); }
  };
  return <div className="mt-3 border-t border-neutral-100 pt-3" data-vivic-audio-output>
    <p className="text-xs text-neutral-700">音频输出 · {speech.preferences.outputDeviceId ? "已指定设备" : "系统默认"}</p>
    <p className="mt-1 text-xs text-neutral-500">内置反馈和云语音可指定输出设备；系统本地音色跟随操作系统声音输出。{!canSelectAudioOutput() && "此浏览器不支持设备选择，请在系统设置中切换。"}</p>
    <div className="mt-2 flex gap-2">
      <Button variant="outline" size="sm" disabled={disabled || busy || !canSelectAudioOutput()} onClick={() => void choose()} data-vivic-output-choose>选择输出设备</Button>
      <Button variant="ghost" size="sm" disabled={disabled || busy || !speech.preferences.outputDeviceId} onClick={() => { setSpeechPreferences({ outputDeviceId: "" }); setError(null); }} data-vivic-output-default>使用系统默认</Button>
    </div>
    {error && <p className="mt-1 text-xs text-amber-700" role="alert">{error}</p>}
  </div>;
}
