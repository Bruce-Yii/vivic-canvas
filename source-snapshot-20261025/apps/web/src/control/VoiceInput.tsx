import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { cancelSpeech } from "@/ai/speech";
import { cancelVoiceInput, finishVoiceInput, getVoiceInputSnapshot, startVoiceInput, subscribeVoiceInput } from "@/ai/voiceInput";
import { getVoiceConfiguration, subscribeVoiceConfiguration } from "@/ai/voiceConfig";

interface VoiceInputProps {
  disabled: boolean;
  onBegin: () => void;
  onTranscript: (text: string) => void;
  autoExecute?: boolean;
}

const voiceCaption = (voice: ReturnType<typeof getVoiceInputSnapshot>, autoExecute: boolean) =>
  voice.status === "requesting" ? "请允许麦克风访问；授权后重新按住说话。"
    : voice.status === "recording" ? `正在录音 ${voice.seconds} / 60 秒，松开后识别。`
    : voice.status === "transcribing" ? "正在识别语音…"
    : voice.status === "review" ? "已转写，请检查输入框中的文字后点发送。"
    : voice.error ?? (autoExecute ? "按住说话，松开识别后自动发送；也可按住空格。" : "按住说话，松开后识别；检查文字后发送。也可聚焦按钮后按住空格。");

/** Local press-to-talk only (the composer's mic); no global shortcuts or automatic command execution. */
export const VoiceInput = ({ disabled, onBegin, onTranscript, autoExecute = false }: VoiceInputProps) => {
  const voice = useSyncExternalStore(subscribeVoiceInput, getVoiceInputSnapshot);
  const config = useSyncExternalStore(subscribeVoiceConfiguration, getVoiceConfiguration);
  const held = useRef(false);
  const handled = useRef<string | null>(null);
  const callback = useRef(onTranscript); callback.current = onTranscript;
  useEffect(() => {
    if (voice.status === "review" && voice.text && voice.text !== handled.current) {
      handled.current = voice.text; callback.current(voice.text);
    }
    if (voice.status === "recording") handled.current = null;
  }, [voice.status, voice.text]);
  useEffect(() => { if (disabled) { held.current = false; cancelVoiceInput(); } }, [disabled]);
  useEffect(() => () => { held.current = false; cancelVoiceInput(); }, []);

  const begin = () => {
    if (disabled || held.current) return;
    held.current = true; handled.current = null; cancelSpeech(); onBegin(); void startVoiceInput();
  };
  const finish = () => { if (held.current) { held.current = false; void finishVoiceInput(); } };
  const cancel = () => { held.current = false; cancelVoiceInput(); };
  const busy = ["requesting", "recording", "transcribing"].includes(voice.status);

  return (
    <div className="vivic-voice" data-vivic-voice-input data-vivic-voice-status={voice.status}>
      {busy && <button type="button" className="vivic-composer-icon" onClick={cancel} aria-label="取消录音" title="取消录音" data-vivic-voice-cancel>
        <HarkIcon name="close" className="h-4 w-4" aria-hidden="true" />
      </button>}
      <button type="button" className="vivic-composer-icon vivic-ptt"
        disabled={disabled || config.stt === "none" || voice.status === "transcribing"}
        aria-label="按住说话" aria-pressed={voice.status === "recording"} title={voiceCaption(voice, autoExecute)}
        data-vivic-ptt
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); begin(); }}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onLostPointerCapture={() => { if (held.current) cancel(); }}
        onKeyDown={event => { if ((event.key === " " || event.key === "Enter") && !event.repeat) { event.preventDefault(); begin(); } if (event.key === "Escape") cancel(); }}
        onKeyUp={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); finish(); } }}
        onBlur={() => { if (held.current) cancel(); }}
      >
        {voice.status === "requesting" || voice.status === "transcribing" ? <HarkIcon name="refresh" className="h-[18px] w-[18px] animate-spin motion-reduce:animate-none" aria-hidden="true" />
          : voice.status === "recording" ? <HarkIcon name="stop" className="h-4 w-4" aria-hidden="true" /> : <HarkIcon name="mic" className="h-[18px] w-[18px]" aria-hidden="true" />}
      </button>
    </div>
  );
};

/** The PTT status line; quiet while idle, shown above the composer once there is something to say. */
export const VoiceNote = ({ autoExecute = false }: { autoExecute?: boolean }) => {
  const voice = useSyncExternalStore(subscribeVoiceInput, getVoiceInputSnapshot);
  return <p className={`vivic-composer-note ${voice.error ? "vivic-composer-note-error" : ""}`} role="status" aria-live="polite"
    hidden={voice.status === "idle" && !voice.error} data-vivic-voice-note>{voiceCaption(voice, autoExecute)}</p>;
};
