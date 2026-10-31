import { useRef, useState, useSyncExternalStore } from "react";
import { Popover } from "radix-ui";
import { HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";
import { Button } from "@/components/ui/button";
import type { ControlHost } from "@/sync/controlHost";

export function SpaceTools({ host, onOpenDisplay }: { host: ControlHost; onOpenDisplay: (canvasId?: string) => void }) {
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const [menuOpen, setMenuOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const readonly = !snapshot.ready || snapshot.ownerMode !== "owner";
  const closeMenu = () => { setMenuOpen(false); trigger.current?.focus({ preventScroll: true }); };
  const openSpace = (canvasId: string) => {
    if (canvasId !== snapshot.activeCanvasId) host.switchCanvas(canvasId);
    onOpenDisplay(canvasId);
    closeMenu();
  };
  const createSpace = () => {
    if (readonly) return;
    openSpace(host.createCanvas());
  };

  return <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
    <Popover.Trigger asChild>
      <Button ref={trigger} variant="outline" size="sm" aria-label="选择 Vivic Space" data-vivic-space-tools aria-haspopup="dialog" aria-expanded={menuOpen}>
        <HarkIcon name="grid" size={15} />Space
      </Button>
    </Popover.Trigger>
    <Popover.Content forceMount asChild side="bottom" align="end" sideOffset={10}
      onEscapeKeyDown={event => { event.preventDefault(); closeMenu(); }}>
      <HarkSurface as="div" className="vivic-space-menu" aria-label="Vivic Space" inert={menuOpen ? undefined : true} data-vivic-space-menu>
        <div className="vivic-space-menu-header">
          <span>空间</span>
          <button type="button" className="vivic-space-menu-add" disabled={readonly} aria-label="添加新空间" title="添加新空间" data-vivic-canvas-create onClick={createSpace}>
            <HarkIcon name="add" size={16} />
          </button>
        </div>
        <ul className="vivic-space-menu-list" data-vivic-canvas-list>
          {snapshot.canvases.length === 0 && <li className="vivic-space-menu-empty">还没有空间</li>}
          {snapshot.canvases.map(canvas => {
            const active = canvas.id === snapshot.activeCanvasId;
            return <li key={canvas.id}>
              <button type="button" className="vivic-space-menu-item" data-vivic-canvas-item={canvas.id} data-active={active || undefined}
                aria-current={active ? "true" : undefined} title="打开 Vivic Space 展示窗口"
                onClick={() => openSpace(canvas.id)}>
                <span>{canvas.title}</span>
                {active && <HarkIcon name="check" size={14} />}
              </button>
            </li>;
          })}
        </ul>
      </HarkSurface>
    </Popover.Content>
  </Popover.Root>;
}
