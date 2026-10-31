import { useSyncExternalStore } from "react";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getSpeechSnapshot, setSpeechEnabled, setSpeechPreferences, SPEECH_VOICES, subscribeSpeech, type SpeechVoiceId } from "@/ai/speech";
import { getVoiceConfiguration, setVoiceConfiguration, subscribeVoiceConfiguration } from "@/ai/voiceConfig";
import { getMicrophonePermission, requestMicrophonePermission, subscribeMicrophonePermission } from "@/permissions/devicePermissions";
import { Choice } from "./Choice";
import { AudioOutputSettings } from "./AudioOutputSettings";
import { PreferenceToggle } from "./PreferenceToggle";

export function CompactVoiceSettings({ connected, disabled, busy, onPreview }: {
  connected: boolean; disabled: boolean; busy: boolean; onPreview(): void; browserVoices?: Array<{ value: string; label: string }>;
}) {
  const speech = useSyncExternalStore(subscribeSpeech, getSpeechSnapshot);
  const voice = useSyncExternalStore(subscribeVoiceConfiguration, getVoiceConfiguration);
  const microphone = useSyncExternalStore(subscribeMicrophonePermission, getMicrophonePermission);
  const locked = disabled || busy;
  return <section className="se-preference-block" aria-label="语音偏好">
    <PreferenceToggle label="语音输入" checked={voice.stt !== "none"} disabled={locked} onChange={enabled => {
      setVoiceConfiguration({ stt: enabled ? "stepfun" : "none" });
    }} testId="compact-voice-input" />
    <PreferenceToggle label="语音回复" checked={speech.enabled && voice.tts !== "none"} disabled={locked} onChange={enabled => {
      if (enabled && voice.tts === "none") setVoiceConfiguration({ tts: "stepfun" });
      setSpeechEnabled(enabled);
    }} testId="compact-voice-reply" />
    {speech.enabled && voice.tts === "stepfun" && <div className="se-voice-choice se-row">
      <span>音色</span><div><Choice label="音色" value={speech.preferences.voice} disabled={locked}
        options={SPEECH_VOICES.map(item => ({ value: item.id, label: item.name }))}
        onChange={value => setSpeechPreferences({ voice: value as SpeechVoiceId })} />
        <Button variant="ghost" size="icon" aria-label={speech.kind === "preview" && (speech.loading || speech.playing) ? "停止试听" : "试听音色"}
          disabled={locked || !connected} onClick={onPreview} data-vivic-tts-preview><HarkIcon name={speech.kind === "preview" && (speech.loading || speech.playing) ? "stop" : "play"} /></Button>
      </div>
    </div>}
    {speech.enabled && !connected && voice.tts === "stepfun" && <p className="se-caption">连接 StepFun 后可生成语音；温柔女声的内置短句仍可使用。</p>}
    {microphone.phase === "denied" && voice.stt !== "none" && <div className="se-caption" role="status">麦克风权限未开启。<button type="button" className="se-inline-action" disabled={locked} onClick={() => void requestMicrophonePermission()}>重新检查</button></div>}
    <details className="se-details" data-vivic-voice-options>
      <summary>更多语音选项<HarkIcon name="chevron-down" /></summary>
      <div className="se-detail-body">
        <label className="se-range">语速<span>{speech.preferences.speed.toFixed(1)}×</span><Input aria-label="语速" type="range" min="0.5" max="2" step="0.1" disabled={locked}
          value={speech.preferences.speed} onChange={event => setSpeechPreferences({ speed: Number(event.target.value) })} /></label>
        <label className="se-range">音量<span>{Math.round(speech.preferences.volume * 100)}%</span><Input aria-label="音量" type="range" min="0" max="1" step="0.01" disabled={locked}
          value={speech.preferences.volume} onChange={event => setSpeechPreferences({ volume: Number(event.target.value) })} /></label>
        {voice.tts === "stepfun"&&<PreferenceToggle label="逐词字幕" checked={speech.preferences.timestamps === true} disabled={locked} onChange={value => setSpeechPreferences({ timestamps: value })} />}
        <AudioOutputSettings disabled={locked} />
        <p className="se-caption">录音时再请求麦克风权限。试听与云端语音使用当前套餐额度。</p>
      </div>
    </details>
    {speech.error && <p className="se-error" role="status" data-vivic-tts-note>{speech.error}</p>}
  </section>;
}
