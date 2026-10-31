import { useRef, useSyncExternalStore } from "react";
import type { ControlHost } from "@/sync/controlHost";
import { newId } from "@/lib/id";
import { ConnectionQueryPanel } from "./ConnectionQueryPanel";
import type { ConnectionResult } from "./api";
import { connectionResultCard } from "./resultCard";

export function ConnectedSources({ host, disabled, onConfigure }: { host: ControlHost; disabled?: boolean; onConfigure(): void }) {
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const pendingSaves = useRef(new WeakMap<ConnectionResult, { requestId: string; card: ReturnType<typeof connectionResultCard> }>());
  const blocked = disabled || !snapshot.ready || snapshot.ownerMode !== "owner" || !snapshot.activeCanvasId;
  const save = async (result: ConnectionResult) => {
    const current = host.getSnapshot();
    if (blocked || current.ownerMode !== "owner" || current.activeCanvasId !== snapshot.activeCanvasId || current.ownerId !== snapshot.ownerId) throw new Error("空间或控制窗口已改变，请重新查询。");
    let pending = pendingSaves.current.get(result);
    if (!pending) { pending = { requestId: newId("connection-save"), card: connectionResultCard(result) }; pendingSaves.current.set(result, pending); }
    const applied = host.dispatch({ schemaVersion: "0.6", requestId: pending.requestId, canvasId: current.activeCanvasId,
      actions: [{ type: "stage.awaken" }, { type: "card.create", card: pending.card }] });
    if (!applied.ok) throw new Error("卡片未创建。");
    const version = host.getSnapshot().canvases.find(canvas => canvas.id === current.activeCanvasId)?.version;
    if (version === undefined) throw new Error("无法确认保存版本。");
    await host.flush(current.activeCanvasId!, version);
  };
  return <div className="vc-connected-sources">
    {blocked ? <button className="vc-query-toggle" type="button" disabled>选择已连接</button>
      : <ConnectionQueryPanel key={`${snapshot.activeCanvasId}:${snapshot.ownerId}`} onConfigure={onConfigure} onSave={save} />}
  </div>;
}
