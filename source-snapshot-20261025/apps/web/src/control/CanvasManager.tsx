import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CanvasMeta, ControlHost } from "@/sync/controlHost";
import { ConfirmDialog } from "./ConfirmDialog";

interface CanvasManagerProps {
  host: ControlHost;
  canvases: CanvasMeta[];
  activeCanvasId: string | null;
  readonly: boolean;
}

export const CanvasManager = ({
  host,
  canvases,
  activeCanvasId,
  readonly,
}: CanvasManagerProps) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const commitRename = (id: string) => {
    const title = editingTitle.trim();
    if (readonly || !title || title.length > 120) return;
    host.renameCanvas(id, title);
    setEditingId(null);
  };

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">画布</h2>
        <Button
          variant="secondary"
          size="sm"
          disabled={readonly}
          onClick={() => host.switchCanvas(host.createCanvas())}
          data-vivic-canvas-create
        >
          新建画布
        </Button>
      </div>
      <ul className="mt-3 flex flex-col gap-1" data-vivic-canvas-list>
        {canvases.map((c) => {
          const active = c.id === activeCanvasId;
          return (
            <li
              key={c.id}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                active
                  ? "border-neutral-800 bg-neutral-900 text-white"
                  : "border-neutral-200 hover:bg-neutral-50"
              }`}
            >
              {editingId === c.id ? (
                <form
                  className="flex flex-1 gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    commitRename(c.id);
                  }}
                >
                  <Input
                    autoFocus
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    className="h-7 text-xs"
                    aria-label="画布名称"
                    maxLength={120}
                    required
                    disabled={readonly}
                    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setEditingId(null); } }}
                  />
                  <Button type="submit" size="sm" variant="secondary" disabled={readonly || !editingTitle.trim()}>
                    保存
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>取消</Button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    className="flex-1 text-left"
                    onClick={() => host.switchCanvas(c.id)}
                    data-vivic-canvas-item={c.id}
                    data-active={active || undefined}
                  >
                    <span className="font-medium">{c.title}</span>
                    <span
                      className={`ml-2 text-xs ${active ? "text-neutral-300" : "text-neutral-400"}`}
                    >
                      v{c.version} · {new Date(c.updatedAt).toLocaleString()}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={readonly}
                    onClick={() => {
                      setEditingId(c.id);
                      setEditingTitle(c.title);
                    }}
                    className={active ? "text-neutral-200 hover:bg-neutral-800" : ""}
                  >
                    重命名
                  </Button>
                  <ConfirmDialog
                    title="删除这个画布？"
                    description={`「${c.title}」及其卡片将从本机删除，不可恢复。`}
                    confirmLabel="删除"
                    disabled={readonly}
                    onConfirm={() => host.deleteCanvas(c.id)}
                    trigger={
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={readonly}
                        className={
                          active
                            ? "text-red-300 hover:bg-neutral-800"
                            : "text-red-600"
                        }
                        data-vivic-canvas-delete={c.id}
                      >
                        删除
                      </Button>
                    }
                  />
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
