import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";
import { ConnectionPanel } from "@/connections/ConnectionPanel";
import "./settings-experience.css";

/** Life-service connections, beside settings rather than inside it. */
export function ServicesPage({ hidden, onClose }: { hidden: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const outsidePress = useRef(false);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (!hidden) {
      if (!node.open) node.showModal();
      const frame = requestAnimationFrame(() => node.setAttribute("data-open", ""));
      return () => cancelAnimationFrame(frame);
    }
    node.removeAttribute("data-open");
    if (!node.open) return;
    const timer = window.setTimeout(() => node.close(), 220);
    return () => clearTimeout(timer);
  }, [hidden]);
  const outside = (x: number, y: number) => {
    const box = dialog.current?.getBoundingClientRect();
    return Boolean(box && (x < box.left || x > box.right || y < box.top || y > box.bottom));
  };
  return <dialog ref={dialog} className="vivic-settings vivic-settings-experience vivic-services vh-hark" data-vivic-services-page aria-labelledby="vivic-services-title"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onPointerDown={event => { outsidePress.current = event.target === event.currentTarget && outside(event.clientX, event.clientY); }}
    onPointerUp={event => {
      if (outsidePress.current && event.target === event.currentTarget && outside(event.clientX, event.clientY)) onClose();
      outsidePress.current = false;
    }}>
    <HarkSurface as="div" className="se-shell">
      <header className="se-topbar">
        <h1 id="vivic-services-title">应用与生活服务</h1>
        <Button variant="ghost" size="icon" className="se-close" aria-label="关闭应用与生活服务" onClick={onClose}>
          <HarkIcon name="close" size={18} />
        </Button>
      </header>
      <div className="se-scroll">
        <ConnectionPanel active={!hidden} />
      </div>
    </HarkSurface>
  </dialog>;
}
