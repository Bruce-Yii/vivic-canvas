import { useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { ControlHost } from "@/sync/controlHost";
import { ConfirmDialog } from "./ConfirmDialog";
import { localSpeechModels } from "@/ai/localSpeech/modelManager";
import { resetLocalPreferences } from "@/ai/resetLocalPreferences";
import { OWNER_ONLINE_BUILD } from "@/online/mode";

interface DataActionsProps {
  host: ControlHost;
  readonly: boolean;
  onBeforeClear: () => void;
  compact?: boolean;
}

export const DataActions = ({ host, readonly, onBeforeClear, compact = false }: DataActionsProps) => {
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const [message, setMessage] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false), [deletingSpace, setDeletingSpace] = useState(false);
  const deleteTarget = useRef<{ canvasId: string; ownerId: string | null } | null>(null);
  const disabled = readonly || clearing || deletingSpace;
  const DangerGroup = compact ? "details" : "div";

  const clearLocalData = async () => {
    if (disabled) return;
    setClearing(true); onBeforeClear();
    try {
      const result = await host.clearLocalData(async () => {
        await localSpeechModels.clearModelCache();
        resetLocalPreferences();
      });
      setMessage(result.ok ? OWNER_ONLINE_BUILD ? "已清除当前账号的全部云端画布。" : "已清除全部画布、提醒记录、偏好和语音模型缓存。" : result.error);
    } finally { setClearing(false); }
  };

  const deleteCurrentSpace = async () => {
    const target = deleteTarget.current;
    deleteTarget.current = null;
    const current = host.getSnapshot();
    if (!target || current.activeCanvasId !== target.canvasId || current.ownerId !== target.ownerId || current.ownerMode !== "owner") {
      setMessage("Space 或控制权已变化，未删除。请重新操作。"); return;
    }
    const onlySpace = current.canvases.length === 1;
    setDeletingSpace(true); onBeforeClear(); setMessage(null);
    try {
      const deleted = await host.deleteCanvas(target.canvasId);
      if (!deleted) {
        try { await host.refreshFromStorage(); } catch { /* Restore remains best effort; keep the failure visible. */ }
        setMessage("Space 或控制权已变化，未删除。请重新操作。");
        return;
      }
      setMessage(onlySpace ? "已删除本空间，并创建了空白 Space。" : "已删除本空间。");
    } catch {
      try { await host.refreshFromStorage(); } catch { /* Keep the deletion status visible if recovery also fails. */ }
      setMessage("删除结果未确认，请检查 Space 后重试。");
    } finally { setDeletingSpace(false); }
  };

  return (
    <section className={compact ? "se-data" : "rounded-xl border border-neutral-200 bg-white p-4"}>
      {!compact && <h2 className="text-sm font-semibold">本地数据</h2>}
      {!compact && <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => setMessage(host.undo() ? "已撤销上一次删除" : "没有可撤销的删除")}
          data-vivic-undo
        >
          撤销删除
        </Button>
        <ConfirmDialog
          title="清空此画布？"
          description="当前画布上的全部卡片将被删除。"
          confirmLabel="清空"
          disabled={disabled}
          onConfirm={() => {
            host.clearActiveCanvas();
            setMessage("已清空当前画布");
          }}
          trigger={
            <Button variant="secondary" size="sm" disabled={disabled} data-vivic-clear-canvas>
              清空此画布
            </Button>
          }
        />
      </div>}
      <div className="se-data-space-danger">
        <ConfirmDialog title={`删除「${snapshot.canvases.find(canvas => canvas.id === snapshot.activeCanvasId)?.title ?? "本空间"}」？`}
          description={OWNER_ONLINE_BUILD ? "删除当前云端 Space 及其中卡片内容，此操作无法撤销。其他 Space 和账号连接会保留；若这是最后一个 Space，将自动创建一个空白 Space。" : "删除当前本地 Space 及其中卡片内容，此操作无法撤销。其他本地 Space 会保留；若这是最后一个 Space，将自动创建一个空白 Space。"}
          confirmLabel="删除本空间" disabled={disabled || !snapshot.activeCanvasId}
          onConfirm={() => void deleteCurrentSpace()}
          trigger={<Button variant="destructive" size="sm" className={compact ? "w-full justify-center" : undefined}
            disabled={disabled || !snapshot.activeCanvasId} data-vivic-delete-space
            onClick={() => { if (snapshot.activeCanvasId) deleteTarget.current = { canvasId: snapshot.activeCanvasId, ownerId: snapshot.ownerId }; }}>
            {deletingSpace ? "正在删除…" : "删除本空间"}
          </Button>} />
      </div>
      <DangerGroup className={compact ? "se-details se-data-danger" : "mt-3 border-t border-neutral-100 pt-3"}>
        {compact && <summary>清除数据</summary>}
        <div className={compact ? "se-detail-body" : undefined}>
        <ConfirmDialog title={OWNER_ONLINE_BUILD ? "清除全部云端画布？" : "清除全部本地数据？"}
          description={OWNER_ONLINE_BUILD ? "删除当前账号的全部云端画布和卡片，此操作无法撤销。账号连接保留。" : "删除本浏览器内的全部画布、提醒记录、显示和语音偏好，以及已下载的语音模型。此操作无法撤销。账号连接保留。"}
          confirmLabel="清除全部" disabled={disabled} onConfirm={() => void clearLocalData()}
          trigger={<Button variant="destructive" size="sm" disabled={disabled} data-vivic-clear-local-data>
            {clearing ? "正在清除…" : OWNER_ONLINE_BUILD ? "清除全部云端画布" : "清除全部本地数据"}
          </Button>} />
        </div>
      </DangerGroup>
      <p className="mt-3 min-h-4 text-xs text-neutral-500" aria-live="polite" data-vivic-data-feedback>
        {message ?? (compact ? null : "数据只保存在本机（IndexedDB），不含任何密钥。")}
      </p>
    </section>
  );
};
