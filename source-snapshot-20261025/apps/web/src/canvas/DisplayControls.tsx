import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { CardPortal } from "@/cards/CardPortal";
import { Button } from "@/components/ui/button";
import { useVivicState } from "@/state/canvasStore";
import {
  getDisplayStatus, subscribeDisplayStatus, requestCardSurface, requestCardFocus, requestCanvasFit, requestFocusRestore,
} from "@/sync/browserRuntime";

const InteractionContext = createContext(false);

/** Owner status is event driven and shared by every card action. */
export function DisplayInteractionProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(() => Boolean(getDisplayStatus()?.canInteract));
  useEffect(() => {
    const update = () => setEnabled(Boolean(getDisplayStatus()?.canInteract));
    update();
    return subscribeDisplayStatus(update);
  }, []);
  return <InteractionContext.Provider value={enabled}>{children}</InteractionContext.Provider>;
}

export function DisplayCardActions({ cardId, title, focused }: { cardId: string; title: string; focused: boolean }) {
  const enabled = useContext(InteractionContext);
  return <div className="vivic-display-card-actions nodrag nopan" role="group" aria-label={`${title}的操作`}>
    <button type="button" disabled={!enabled} aria-label={`${focused ? "取消聚焦" : "聚焦"}：${title}`} title={focused ? "恢复之前视图" : "聚焦这张卡片"}
      onClick={() => focused ? requestFocusRestore() : requestCardFocus(cardId)}><HarkIcon name="point" size={13} aria-hidden />{focused ? "取消聚焦" : "聚焦"}</button>
    <button type="button" disabled={!enabled} aria-label={`传送到用户页：${title}`} title="传送到用户页编辑，无需跨标签页拖拽" onClick={() => requestCardSurface(cardId, "user")}><HarkIcon name="share" size={13} aria-hidden />传送</button>
  </div>;
}

export function DisplayControls({ theme }: { theme: "light" | "dark" }) {
  const enabled = useContext(InteractionContext);
  const focus = useVivicState(state => state.focus);
  const canvasId = getDisplayStatus()?.canvasId ?? "";
  return <nav className={`vivic-canvas-controls${theme === "dark" ? " dark" : ""}`} aria-label="展示画布操作">
    <CardPortal key={canvasId} surface="display" canvasId={canvasId} disabled={!enabled} theme={theme} onTransfer={requestCardSurface}
      onFocus={requestCardFocus} onFit={requestCanvasFit} onRestore={requestFocusRestore} />
    <div>{!enabled && <p className="vivic-canvas-connection" role="status">保持用户页打开，即可操作画布</p>}
      <div className="vivic-view-buttons">
        <Button variant="ghost" size="sm" disabled={!enabled} onClick={requestCanvasFit}><HarkIcon name="expand" size={15} aria-hidden />显示全部</Button>
        <Button variant="ghost" size="sm" disabled={!enabled || !focus} onClick={requestFocusRestore}><HarkIcon name="refresh" size={15} aria-hidden />恢复视图</Button>
      </div>
    </div>
  </nav>;
}
