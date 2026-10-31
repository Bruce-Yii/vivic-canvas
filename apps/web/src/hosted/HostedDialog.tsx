import { useEffect, useRef, type ReactNode } from "react";
import { HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";

export function HostedDialog({ title, children, onClose, className = "" }: { title: string; children: ReactNode; onClose(): void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closing = useRef(false);
  const close = () => {
    const dialog = ref.current;
    if (!dialog || closing.current) return;
    closing.current = true;
    dialog.removeAttribute("data-open");
    window.setTimeout(onClose, 220);
  };
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    const frame = requestAnimationFrame(() => dialog?.setAttribute("data-open", ""));
    return () => { cancelAnimationFrame(frame); dialog?.close(); trigger?.focus(); };
  }, []);
  return <dialog ref={ref} className={`hosted-dialog ${className}`} aria-label={title} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <HarkSurface as="section" className="hosted-dialog-surface"><header className="hosted-dialog-head"><h2>{title}</h2><button className="hark-icon-button" aria-label="关闭" onClick={close}><HarkIcon name="close" /></button></header>{children}</HarkSurface>
  </dialog>;
}
