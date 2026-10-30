import { useSyncExternalStore } from "react";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { CardPortal } from "@/cards/CardPortal";
import { Button } from "@/components/ui/button";
import { newId } from "@/lib/id";
import type { Action } from "@/contracts";
import type { ControlHost } from "@/sync/controlHost";
import { SpaceTools } from "./SpaceTools";
import { QuickFind } from "./QuickFind";

export function UserCanvasControls({ host, theme, onOpenDisplay, onBeforeClear }: { host: ControlHost; theme: "light" | "dark"; onOpenDisplay: () => void; onBeforeClear(): void }) {
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const disabled = !snapshot.ready || snapshot.ownerMode !== "owner";
  const act = (action: Action) => {
    const current = host.getSnapshot();
    if (!current.ready || current.ownerMode !== "owner" || !current.activeCanvasId || current.activeCanvasId !== snapshot.activeCanvasId) return false;
    return host.dispatch({ schemaVersion: "0.6", requestId: newId("view"), canvasId: current.activeCanvasId, actions: [action] }).ok;
  };
  return <nav className={`vivic-user-canvas-controls${theme === "dark" ? " dark" : ""}`} aria-label="画布操作">
    <SpaceTools host={host} onBeforeClear={onBeforeClear} />
    <CardPortal key={snapshot.activeCanvasId} compact surface="user" canvasId={snapshot.activeCanvasId ?? ""} disabled={disabled} theme={theme}
      onTransfer={(id, surface) => host.getSnapshot().activeCanvasId === snapshot.activeCanvasId && host.setCardSurface(id, surface, undefined, snapshot.activeCanvasId ?? "").ok}
      onFocus={id => act({ type: "card.focus", targetId: id })} onFit={() => act({ type: "canvas.fit" })} onRestore={() => act({ type: "canvas.restore" })} />
    <Button variant="outline" size="icon" className="vivic-display-compact" aria-label="展示窗口" title="打开 Vivic Space 展示窗口" disabled={!snapshot.activeCanvasId} onClick={onOpenDisplay}><HarkIcon name="computer" size={17} aria-hidden /></Button>
    <QuickFind host={host} compact />
  </nav>;
}
