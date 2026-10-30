import { useEffect, useRef } from "react";
import type { CardSnapshot } from "@vivic/mobile-console-prototype/protocol";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { Button } from "@/components/ui/button";

/** A plain-text view of owner-approved notes. Editing stays with the desktop owner. */
export function MobileSubcards({ card, onClose }: { card: CardSnapshot; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    dialog.current?.showModal?.();
    return () => focused?.focus();
  }, []);
  return <dialog ref={dialog} className="mobile-settings-sheet mobile-subcards-sheet" aria-labelledby="mobile-subcards-title"
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className="mobile-sheet-handle" />
    <header className="mobile-sheet-heading"><h2 id="mobile-subcards-title">子卡片</h2><Button variant="ghost" size="icon" className="mobile-icon-button" aria-label="关闭子卡片" onClick={onClose}><HarkIcon name="close" size={20} /></Button></header>
    <p className="mobile-subcards-parent">{card.title || "未命名卡片"}</p>
    <div className="mobile-subcards-list">{card.subcards?.map(note => <article key={note.id} data-mobile-subcard-id={note.id}>
      <h3>{note.label}</h3><p>{note.text}</p>
    </article>)}</div>
  </dialog>;
}
