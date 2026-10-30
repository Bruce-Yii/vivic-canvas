import { useEffect, useState, useSyncExternalStore } from "react";
import type { ControlHost } from "@/sync/controlHost";
import { canvasStore, useVivicState } from "@/state/canvasStore";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/control/ConfirmDialog";
import { FileUploadButton } from "./FileUploadButton";
import { fileSizeLabel, listFileAssets, removeFileAssets, subscribeFileAssets, type FileAsset } from "./assetStore";

export function FileManager({ host, disabled = false }: { host: ControlHost; disabled?: boolean }) {
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const cards = useVivicState(state => state.cards);
  const [assets, setAssets] = useState<FileAsset[]>([]), [message, setMessage] = useState(""), [refresh, setRefresh] = useState(0);
  useEffect(() => subscribeFileAssets(() => setRefresh(value => value + 1)), []);
  useEffect(() => {
    let current = true;
    setAssets([]);
    if (snapshot.activeCanvasId) void listFileAssets(snapshot.activeCanvasId).then(result => { if (current) setAssets(result); }).catch(() => { if (current) setMessage("文件存储不可用"); });
    return () => { current = false; };
  }, [snapshot.activeCanvasId, refresh]);
  const used = new Set(cards.filter(card => !card.exitingRequestId && card.record.type === "FileCard").flatMap(card => card.record.type === "FileCard" ? [card.record.displayProps.fileId] : []));
  const unused = assets.filter(asset => !used.has(asset.fileId));
  const bytes = assets.reduce((sum, asset) => sum + asset.sizeBytes, 0);
  return <section className="vivic-file-manager" aria-label="空间文件容量">
    <p className="vivic-file-capacity">{fileSizeLabel(bytes)} / 100 MB</p>
    <progress max={100_000_000} value={bytes} aria-label="空间文件已用容量" />
    <FileUploadButton host={host} disabled={disabled} />
    <p className="vivic-file-hint">原件只读。同一文件重复引用只占一次容量；删除卡片后保留原件，方便撤销。</p>
    {unused.length > 0 && <ConfirmDialog title="永久清理未使用的文件原件？" description="清理后，即使撤销卡片删除，也无法恢复对应的原文件。仍在使用的文件会保留。" confirmLabel="清理原件" disabled={disabled}
      trigger={<Button variant="ghost" size="sm" disabled={disabled}>清理 {unused.length} 个未使用原件</Button>}
      onConfirm={() => { void (async () => {
        const current = host.getSnapshot(), canvasId = snapshot.activeCanvasId;
        if (!canvasId || current.activeCanvasId !== canvasId || current.ownerMode !== "owner" || current.ownerId !== snapshot.ownerId) { setMessage("空间已变化，请重新确认"); return; }
        const live = new Set(canvasStore.getState().cards.flatMap(card => card.record.type === "FileCard" ? [card.record.displayProps.fileId] : []));
        try { await removeFileAssets(canvasId, unused.filter(asset => !live.has(asset.fileId)).map(asset => asset.fileId)); setMessage("已清理未使用原件"); }
        catch { setMessage("清理失败，请重试"); }
      })(); }} />}
    {message && <p role="status" className="vivic-file-message">{message}</p>}
  </section>;
}
