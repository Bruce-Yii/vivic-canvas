import { useEffect, useRef, type ReactNode } from "react";
import { HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";

export function HostedDialog({ title, children, onClose, className = "" }: { title: string; children: ReactNode; onClose(): void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; const trigger = document.activeElement as HTMLElement | null; dialog?.showModal(); return () => { dialog?.close(); trigger?.focus(); }; }, []);
  return <dialog ref={ref} className={`hosted-dialog ${className}`} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <HarkSurface as="section" className="hosted-dialog-surface"><header className="hosted-dialog-head"><h2>{title}</h2><button className="hark-icon-button" aria-label="关闭" onClick={onClose}><HarkIcon name="close" /></button></header>{children}</HarkSurface>
  </dialog>;
}
