import { useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import { MicCapture } from "@/ai/localSpeech/micCapture";
import { encodeVoiceWav } from "@/ai/pcm";
import type { LocalWakeInputProps } from "./LocalWakeInput";

/** Lightweight audio energy segmentation; recognition runs on the configured API. */
export function OnlineWakeInput(props: LocalWakeInputProps) {
  const latest = useRef(props); latest.current = props;
  const [enabled, setEnabled] = useState(true), [active, setActive] = useState(false), [error, setError] = useState("");
  const [foreground, setForeground] = useState(() => !document.hidden && document.hasFocus());
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const update = () => setForeground(!document.hidden && document.hasFocus());
    window.addEventListener("focus", update); window.addEventListener("blur", update); document.addEventListener("visibilitychange", update);
    return () => { window.removeEventListener("focus", update); window.removeEventListener("blur", update); document.removeEventListener("visibilitychange", update); };
  }, []);
  useEffect(() => {
    if (!enabled || !foreground || props.disabled || props.speaking) { setActive(false); return; }
    const controller = new AbortController(), mic = new MicCapture();
    let chunks: Float32Array[] = [], frames = 0, silence = 0, delivering = false, spoken = false;
    const fail = (cause: unknown) => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "麦克风暂不可用，请点击重试。"); setActive(false); } };
    setError("");
    void mic.start({ signal: controller.signal, maxSeconds: 300, onError: fail, onPcm: samples => {
      if (delivering || controller.signal.aborted) return;
      let energy = 0; for (const sample of samples) energy += sample * sample;
      const audible = Math.sqrt(energy / samples.length) > 0.016;
      if (!spoken && !audible) return;
      if (audible) spoken = true;
      chunks.push(samples.slice()); frames += samples.length; silence = audible ? 0 : silence + samples.length;
      if (frames >= 16000 * 55 || spoken && silence >= 16000 * 0.85 && frames >= 16000 * 0.4) {
        delivering = true; mic.stop(); setActive(false);
        const segment = chunks; chunks = [];
        Promise.resolve().then(async () => {
          latest.current.onBegin?.();
          const wav = encodeVoiceWav(segment, 16000), merged = new Float32Array(frames);
          let offset = 0; for (const chunk of segment) { merged.set(chunk, offset); offset += chunk.length; }
          await latest.current.onSegment?.({ type: "segment", samples: merged, sampleRate: 16000, wav, signal: controller.signal });
          if (!controller.signal.aborted) setTimeout(() => setRetry(value => value + 1), 500);
        }).catch(fail);
      }
    } }).then(() => { if (!controller.signal.aborted) setActive(true); }).catch(fail);
    return () => { controller.abort(); mic.dispose(); };
  }, [enabled, foreground, props.disabled, props.speaking, props.ownerKey, props.cancelKey, retry]);
  return <div className="vivic-wake" data-vivic-local-wake data-cloud-listener data-listening={active || undefined} data-has-error={error || undefined}>
    <button type="button" className="vivic-wake-mic" data-on={active} aria-pressed={active} aria-label={active ? "关闭监听" : "开启监听"} title={active ? "监听已开启" : error || "监听已关闭"} onClick={() => { if (!active) { setError(""); setRetry(value => value + 1); setEnabled(true); } else setEnabled(false); }}><Mic aria-hidden="true" /></button>
  </div>;
}
