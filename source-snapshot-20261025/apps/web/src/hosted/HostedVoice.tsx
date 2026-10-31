import { useEffect, useRef, useState } from "react";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { HostedDialog } from "./HostedDialog";
import { errorMessage, hostedRequest } from "./client";
import { createSpeechUrls, revokeSpeechUrls } from "./voiceAudio";

/** Only an explicit recording action asks for a microphone. Recognition is a draft. */
export function HostedVoice({ onClose, onInsert }: { onClose(): void; onInsert(text: string): void }) {
  const [recording, setRecording] = useState(false), [file, setFile] = useState<Blob | null>(null), [text, setText] = useState(""), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [audio, setAudio] = useState<string[]>([]), [recognized, setRecognized] = useState(""), [rawTranscript, setRawTranscript] = useState("");
  const recorder = useRef<MediaRecorder | null>(null), stream = useRef<MediaStream | null>(null), controller = useRef<AbortController | null>(null), alive = useRef(true), textRevision = useRef(0), starting = useRef(false), stopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const audioUrls = useRef<string[]>([]), working = useRef(false);
  const replaceAudio = (urls: string[]) => { revokeSpeechUrls(audioUrls.current); audioUrls.current = urls; setAudio(urls); };
  const cancel = () => { controller.current?.abort(); replaceAudio([]); setMessage("已取消本次等待。"); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(stopTimer.current); controller.current?.abort(); revokeSpeechUrls(audioUrls.current); audioUrls.current = []; if (recorder.current?.state === "recording") recorder.current.stop(); stream.current?.getTracks().forEach(track => track.stop()); }; }, []);
  const start = async () => {
    if (starting.current) return; starting.current = true; replaceAudio([]); setMessage(""); setFile(null);
    try { const media = await navigator.mediaDevices.getUserMedia({ audio: true }); if (!alive.current) { media.getTracks().forEach(track => track.stop()); return; } stream.current = media;
      const recording = new MediaRecorder(media), chunks: BlobPart[] = []; recorder.current = recording;
      recording.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recording.onstop = () => { clearTimeout(stopTimer.current); media.getTracks().forEach(track => track.stop()); if (alive.current) { setRecording(false); setFile(new Blob(chunks, { type: recording.mimeType })); } };
      recording.start(); setRecording(true); stopTimer.current = setTimeout(() => { if (recording.state === "recording") recording.stop(); }, 59000);
    } catch { stream.current?.getTracks().forEach(track => track.stop()); setMessage("无法开启麦克风。可以选择已有的 WAV 音频。"); }
    finally { starting.current = false; }
  };
  const transcribe = async () => {
    if (!file || working.current) return; working.current = true; const revision = textRevision.current, operation = new AbortController(), deadline = AbortSignal.timeout(185000); controller.current = operation; replaceAudio([]); setBusy(true); setMessage("正在识别，完成后请复核文字。");
    try { const wav = await toWav(file); operation.signal.throwIfAborted(); deadline.throwIfAborted(); const body = new FormData(); body.append("file", wav, "voice.wav");
      const response = await fetch("/api/space/models/transcribe", { method: "POST", body, credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([operation.signal, deadline]) });
      const result = await response.json() as { text?: string; message?: string; ok?: boolean };
      operation.signal.throwIfAborted(); deadline.throwIfAborted();
      if (!response.ok || result.ok === false || typeof result.text !== "string") throw new Error("transcribe_failed");
      if (alive.current) { setRawTranscript(result.text); if (revision === textRevision.current) { setText(result.text); setRecognized(""); setMessage("识别完成，请复核后放入草稿。"); } else { setRecognized(result.text); setMessage("识别完成，已保留你刚修改的文字。"); } }
    } catch { if (alive.current) setMessage(operation.signal.aborted ? "已取消本次识别等待。" : deadline.aborted ? "识别等待已超时，平台可能仍在处理；请稍后重试。" : "识别没有完成，请检查平台连接后重试。"); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  };
  const synthesize = async () => {
    if (!text.trim() || working.current) return; working.current = true; const operation = new AbortController(), deadline = AbortSignal.timeout(185000); controller.current = operation; replaceAudio([]); setBusy(true); setMessage("正在生成试听…");
    try { const result = await hostedRequest<{ segments: unknown }>("/api/space/models/speech", { text: text.trim() }, "POST", AbortSignal.any([operation.signal, deadline]));
      operation.signal.throwIfAborted(); deadline.throwIfAborted(); if (alive.current) { replaceAudio(createSpeechUrls(result.segments)); setMessage("试听已准备，点击播放。"); }
    } catch (error) { if (alive.current) setMessage(operation.signal.aborted ? "已取消本次等待。" : deadline.aborted ? "试听等待已超时，平台可能仍在处理；请稍后重试。" : errorMessage(error)); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  };
  return <HostedDialog title="语音" onClose={onClose}><div className="hosted-form"><div className="hosted-inline-actions"><button className="hosted-quiet" disabled={busy} onClick={() => { if (recording) recorder.current?.stop(); else void start(); }}><HarkIcon name={recording ? "stop" : "mic"} />{recording ? "停止录音" : "开始录音"}</button><label className="hosted-quiet">选择音频<input type="file" accept="audio/wav,audio/x-wav,.wav" hidden disabled={recording || busy} onChange={event => { setFile(event.target.files?.[0] ?? null); event.currentTarget.value = ""; setMessage(""); }} /></label></div>
    {file && <p className="hosted-muted">已准备音频 · {Math.ceil(file.size / 1024)} KB</p>}<p className="hosted-muted">录音最多 59 秒；音频文件需在 60 秒、10 MB 以内。</p>
    <button className="hosted-primary" disabled={!file || recording || busy} onClick={() => void transcribe()}>转成文字</button>
    {busy && <button className="hosted-quiet" onClick={cancel}>取消等待</button>}
    <label>试听或复核文字<textarea aria-label="试听或复核文字" placeholder="输入想试听的文字，也可以先识别音频后复核。" value={text} onChange={event => { textRevision.current++; setText(event.target.value); }} rows={5} maxLength={6000} /></label><button className="hosted-primary" disabled={busy || !text.trim()} onClick={() => { onInsert(text.trim()); onClose(); }}>追加到草稿</button><button className="hosted-quiet" disabled={busy || !text.trim()} onClick={() => void synthesize()}>生成试听</button>
    {rawTranscript && <details><summary>识别原文</summary><p className="hosted-voice-transcript">{rawTranscript}</p></details>}
    {recognized && <div><p className="hosted-muted">本次识别：{recognized}</p><button className="hosted-quiet" onClick={() => { textRevision.current++; setText(current => `${current}\n${recognized}`.trim()); setRecognized(""); }}>追加本次识别</button></div>}
    {audio.map((source, index) => <audio key={source.slice(-40) + index} controls preload="none" src={source} aria-label={`试听第 ${index + 1} 段`} />)}
    {message && <p role="status" className="hosted-muted">{message}</p>}
  </div></HostedDialog>;
}
/** The service accepts WAV; browser MediaRecorder formats are decoded locally,
 * resampled to mono 16 kHz and wrapped as PCM16 without loading a model. */
async function toWav(blob: Blob): Promise<Blob> {
  if (blob.size > 10_000_000) throw new Error("audio_too_large");
  const context = new AudioContext();
  try { const decoded = await context.decodeAudioData(await blob.arrayBuffer()); if (decoded.duration > 60) throw new Error("audio_too_long");
    const sampleRate = 16000, length = Math.ceil(decoded.duration * sampleRate), offline = new OfflineAudioContext(1, length, sampleRate), source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
    const rendered = await offline.startRendering(), samples = rendered.getChannelData(0), buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
    const chars = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
    chars(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); chars(8, "WAVE"); chars(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); chars(36, "data"); view.setUint32(40, samples.length * 2, true);
    for (let index = 0; index < samples.length; index++) { const sample = Math.max(-1, Math.min(1, samples[index])); view.setInt16(44 + index * 2, sample < 0 ? sample * 32768 : sample * 32767, true); }
    return new Blob([buffer], { type: "audio/wav" });
  } finally { await context.close(); }
}
