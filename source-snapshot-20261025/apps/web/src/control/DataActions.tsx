import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ControlHost } from "@/sync/controlHost";
import { ConfirmDialog } from "./ConfirmDialog";
import { localSpeechModels } from "@/ai/localSpeech/modelManager";
import { resetLocalPreferences } from "@/ai/resetLocalPreferences";

interface DataActionsProps {
  host: ControlHost;
  readonly: boolean;
  onBeforeClear: () => void;
  compact?: boolean;
}

export const DataActions = ({ host, readonly, onBeforeClear, compact = false }: DataActionsProps) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const disabled = readonly || clearing;
  const DangerGroup = compact ? "details" : "div";

  const clearLocalData = async () => {
    if (disabled) return;
    setClearing(true); onBeforeClear();
    try {
      const result = await host.clearLocalData(async () => {
        await localSpeechModels.clearModelCache();
        resetLocalPreferences();
      });
      setMessage(result.ok ? "已清除全部画布、提醒记录、偏好和语音模型缓存。" : result.error);
    } finally { setClearing(false); }
  };

  const exportJson = () => {
    const json = host.exportActiveCanvas();
    if (!json) return;
    const snap = host.getSnapshot();
    const title =
      snap.canvases.find((c) => c.id === snap.activeCanvasId)?.title ?? "canvas";
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vivic-${title}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMessage("已导出当前画布的 JSON 文件");
  };

  const importJson = async (file: File) => {
    const text = await file.text();
    const result = host.importCanvas(text);
    if (!result.ok) {
      setMessage(result.error ?? "导入失败");
      return;
    }
    if (result.id) host.switchCanvas(result.id);
    setMessage("已导入并切换到新画布");
  };

  return (
    <section className={compact ? "se-data" : "rounded-xl border border-neutral-200 bg-white p-4"}>
      {!compact && <h2 className="text-sm font-semibold">本地数据</h2>}
      {compact && <p className="se-caption">画布保存在当前浏览器，可导出备份。</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {!compact && <><Button
          variant="secondary"
          size="sm"
          disabled={readonly}
          onClick={() => setMessage(host.undo() ? "已撤销上一次删除" : "没有可撤销的删除")}
          data-vivic-undo
        >
          撤销删除
        </Button>
        <ConfirmDialog
          title="清空此画布？"
          description="当前画布上的全部卡片将被删除（可在导入的 JSON 备份中恢复）。"
          confirmLabel="清空"
          disabled={readonly}
          onConfirm={() => {
            host.clearActiveCanvas();
            setMessage("已清空当前画布");
          }}
          trigger={
            <Button variant="secondary" size="sm" disabled={readonly} data-vivic-clear-canvas>
              清空此画布
            </Button>
          }
        /></>}
        <Button variant="secondary" size="sm" onClick={exportJson} data-vivic-export>
          {compact ? "导出备份" : "导出 JSON"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={readonly}
          onClick={() => fileRef.current?.click()}
          data-vivic-import
        >
          {compact ? "导入备份" : "导入 JSON"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          data-vivic-import-input
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importJson(file);
            e.target.value = "";
          }}
        />
      </div>
      <DangerGroup className={compact ? "se-details se-data-danger" : "mt-3 border-t border-neutral-100 pt-3"}>
        {compact && <summary>清除数据</summary>}
        <div className={compact ? "se-detail-body" : undefined}>
        <ConfirmDialog title="清除全部本地数据？"
          description="删除本浏览器内的全部画布、提醒记录、显示和语音偏好，以及已下载的语音模型。此操作无法撤销，请先导出需要保留的画布。账号连接保留。"
          confirmLabel="清除全部" disabled={disabled} onConfirm={() => void clearLocalData()}
          trigger={<Button variant="destructive" size="sm" disabled={disabled} data-vivic-clear-local-data>
            {clearing ? "正在清除…" : "清除全部本地数据"}
          </Button>} />
        </div>
      </DangerGroup>
      <p className="mt-3 min-h-4 text-xs text-neutral-500" aria-live="polite" data-vivic-data-feedback>
        {message ?? (compact ? null : "数据只保存在本机（IndexedDB），不含任何密钥。")}
      </p>
    </section>
  );
};
