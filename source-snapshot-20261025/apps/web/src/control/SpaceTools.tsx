import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dialog } from "radix-ui";
import { HarkIcon, HarkTabs } from "@/components/hark/HarkPrimitives";
import { Button } from "@/components/ui/button";
import { ExtensionManager } from "@/extensions/ExtensionManager";
import type { ControlHost } from "@/sync/controlHost";
import { ControlDialogContent } from "./ControlDialogContent";
import { CanvasManager } from "./CanvasManager";
import { CanvasSettings } from "./CanvasSettings";
import { CardSubcardsSection } from "./CardSubcardsSection";
import { RemindersSection } from "./RemindersSection";
import { ConfirmDialog } from "./ConfirmDialog";
import { SpaceOrganizer } from "./SpaceOrganizer";
import { FileManager } from "@/files/FileManager";
import { FileScopeContext } from "@/files/FileScopeContext";
import { readOrganizationDraft } from "./organizationDraft";

const tabs = [{ id: "spaces", label: "空间" }, { id: "cards", label: "卡片" }, { id: "reminders", label: "提醒" }] as const;
export function SpaceTools({ host, onBeforeClear }: { host: ControlHost; onBeforeClear(): void }) {
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<typeof tabs[number]["id"]>("spaces");
  const [organizerRevision, setOrganizerRevision] = useState(0);
  useEffect(() => {
    const openPreview = () => { if (readOrganizationDraft(host.getSnapshot().activeCanvasId)) { setTab("cards"); setOpen(true); setOrganizerRevision(v => v + 1); } };
    window.addEventListener("vivic:organize-preview", openPreview);
    return () => window.removeEventListener("vivic:organize-preview", openPreview);
  }, [host]);
  const [message, setMessage] = useState("");
  const [clearing, setClearing] = useState(false);
  const clearTarget = useRef<{ canvasId: string | null; ownerId: string | null } | null>(null);
  const clearInFlight = useRef(false);
  const readonly = !snapshot.ready || snapshot.ownerMode !== "owner";
  const clearCanvas = async () => {
    if (clearInFlight.current) return;
    const target = clearTarget.current;
    clearTarget.current = null;
    const current = host.getSnapshot();
    if (!target?.canvasId || !current.ready || current.ownerMode !== "owner"
      || current.ownerId !== target.ownerId || current.activeCanvasId !== target.canvasId) {
      setMessage("画布或控制权已变化，未清空。请重新确认。"); return;
    }
    const previous = current.canvases.find(canvas => canvas.id === target.canvasId);
    if (!previous) { setMessage("画布已不可用，未清空。"); return; }
    clearInFlight.current = true; setClearing(true); setMessage("");
    try {
      onBeforeClear(); host.clearActiveCanvas();
      const version = Math.max(previous.version + 1, host.getSnapshot().canvases.find(canvas => canvas.id === target.canvasId)?.version ?? 0);
      await host.flush(target.canvasId, version);
      setMessage("已清空并保存当前画布");
    } catch { setMessage("清空结果待确认，请检查画布后再操作。"); }
    finally { clearInFlight.current = false; setClearing(false); }
  };
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><Button variant="outline" size="sm" aria-label="管理 Vivic Space" data-vivic-space-tools>
      <HarkIcon name="grid" size={15} />Space
    </Button></Dialog.Trigger>
    {open && <ControlDialogContent title="Vivic Space" description="管理空间、卡片和提醒。" className="vivic-space-tools" data-vivic-space-management>
      <HarkTabs<typeof tabs[number]["id"]> label="Space 管理" value={tab} tabs={tabs} onChange={setTab} />
      <div className="vivic-space-tools-scroll">
        <div hidden={tab !== "spaces"}>
          <CanvasManager host={host} canvases={snapshot.canvases} activeCanvasId={snapshot.activeCanvasId} readonly={readonly} />
          <div className="vivic-space-actions">
            <Button variant="ghost" size="sm" disabled={readonly || clearing || snapshot.history?.canUndo === false} onClick={() => setMessage(host.undo() ? "已撤销上一步操作" : "没有可撤销的操作，或目标内容已变化。")} data-vivic-undo>撤销</Button>
            <Button variant="ghost" size="sm" disabled={readonly || clearing || !snapshot.history?.canRedo} onClick={() => setMessage(host.redo() ? "已重做上一步操作" : "没有可重做的操作，或目标内容已变化。")} data-vivic-redo>重做</Button>
            <ConfirmDialog title="清空此画布？" description="当前画布上的全部卡片将被删除，请先保留需要的备份。" confirmLabel="清空" disabled={readonly || clearing}
              trigger={<Button variant="ghost" size="sm" disabled={readonly || clearing} onClick={() => { clearTarget.current = { canvasId: snapshot.activeCanvasId, ownerId: snapshot.ownerId }; }} data-vivic-clear-canvas>{clearing ? "正在清空…" : "清空此画布"}</Button>}
              onConfirm={() => void clearCanvas()} />
          </div>
          {message && <p className="se-caption" role="status">{message}</p>}
        </div>
        <div hidden={tab !== "cards"}>
          <details className="se-details"><summary>文件与容量</summary><FileManager host={host} disabled={readonly} /></details>
          <SpaceOrganizer key={`${snapshot.activeCanvasId}:${organizerRevision}`} host={host} disabled={readonly} />
          <details className="se-details"><summary>添加和管理卡片包<HarkIcon name="chevron-down" /></summary><ExtensionManager host={host} disabled={readonly} /></details>
          <CanvasSettings host={host} disabled={readonly} toolsOnly />
          <FileScopeContext value={snapshot.activeCanvasId}><CardSubcardsSection key={`${snapshot.activeCanvasId}:${snapshot.ownerMode}:${snapshot.ownerId}:${snapshot.ready}`} host={host} /></FileScopeContext>
        </div>
        <div hidden={tab !== "reminders"}><RemindersSection host={host} readonly={readonly} hidePreferences /></div>
      </div>
    </ControlDialogContent>}
  </Dialog.Root>;
}
