import { useEffect, useRef, useState } from "react";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { Button } from "@/components/ui/button";
import { NATIVE_ORIGIN } from "./pairing";

interface NativeScanner { scan(): void }
interface Detector { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> }
type ScannerWindow = Window & { VivicAndroid?: NativeScanner; BarcodeDetector?: new (options: { formats: string[] }) => Detector };
export const hasNativeScanner = () => window.location.origin === NATIVE_ORIGIN && Boolean((window as ScannerWindow).VivicAndroid?.scan);

/** Camera is acquired only after the user opens this dialog, and released on every exit. */
export function PairingScanner({ onResult, onClose }: { onResult(value: string): void; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal?.();
    let stream: MediaStream | undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { stopped = true; stream?.getTracks().forEach(track => track.stop()); if (timer) clearTimeout(timer); };
    const visibility = () => {
      if (document.hidden && stream) { stop(); setStarting(false); setError("扫码已暂停，相机已关闭。请返回后重新打开扫码。"); }
    };
    const receive = (event: Event) => {
      if (stopped) return;
      const detail = (event as CustomEvent<{ value?: string; error?: string }>).detail;
      if (detail?.value) { stop(); onResult(detail.value); }
      else { setStarting(false); setError(detail?.error ?? "已取消扫码，可粘贴配对链接或输入配对码。"); }
    };
    window.addEventListener("vivic:scan-result", receive);
    document.addEventListener("visibilitychange", visibility);
    const start = async () => {
      try {
        if (hasNativeScanner()) { (window as ScannerWindow).VivicAndroid!.scan(); return; }
        const BarcodeDetector = (window as ScannerWindow).BarcodeDetector;
        if (!BarcodeDetector || !navigator.mediaDevices?.getUserMedia) throw new Error("此浏览器不支持内置扫码。可用手机相机扫描电脑二维码，或返回粘贴配对链接。");
        const detector = new BarcodeDetector({ formats: ["qr_code"] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (stopped) { stream.getTracks().forEach(track => track.stop()); return; }
        video.current!.srcObject = stream;
        await video.current!.play(); setStarting(false);
        const scan = async () => {
          if (stopped || !video.current) return;
          try {
            const codes = await detector.detect(video.current);
            if (codes[0]?.rawValue) { stop(); onResult(codes[0].rawValue); return; }
          } catch { /* A not-yet-ready video frame is retried without reopening the camera. */ }
          if (!stopped) timer = setTimeout(() => void scan(), 220);
        };
        void scan();
      } catch (cause) {
        stream?.getTracks().forEach(track => track.stop());
        if (stopped) return;
        setStarting(false);
        setError(cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "相机权限未开启。可返回输入配对码；需要扫码时再到系统设置允许相机。"
          : cause instanceof Error ? cause.message : "相机暂不可用，请返回输入配对码。");
      }
    };
    void start();
    return () => { stop(); window.removeEventListener("vivic:scan-result", receive); document.removeEventListener("visibilitychange", visibility); focus?.focus(); };
  }, [onResult]);
  return <dialog ref={dialog} className="mobile-scanner" aria-labelledby="mobile-scanner-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className="mobile-sheet-handle" />
    <div className="mobile-scanner-heading"><h2 id="mobile-scanner-title">扫描电脑二维码</h2><Button variant="ghost" size="icon" aria-label="关闭扫码" onClick={onClose}><HarkIcon name="x" size={20} /></Button></div>
    <p className="mobile-hint">在电脑 Vivic 设置中开启手机控制，将一次性二维码放入取景框。</p>
    {!error && <div className="mobile-camera-preview"><video ref={video} muted playsInline /><div className="mobile-camera-frame" />{starting && <span><HarkIcon name="loader-circle" className="mobile-spin" size={24} />正在打开相机</span>}</div>}
    {error && <div className="mobile-scan-error" role="alert"><HarkIcon name="camera" size={28} /><p>{error}</p></div>}
    <Button className="mobile-primary" onClick={onClose}>{error ? "返回输入配对码" : "取消扫码"}</Button>
  </dialog>;
}
