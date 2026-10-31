import { useRef, useState, useSyncExternalStore } from "react";
import { cardTitle } from "@/contracts";
import { useVivicState } from "@/state/canvasStore";
import { organizationPreview, type OrganizeOptions, type CardOrganization } from "@/state/organizeCards";
import type { ControlHost } from "@/sync/controlHost";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";
import "./space-organizer.css";
import { readOrganizationDraft, clearOrganizationDraft } from "./organizationDraft";

const sorts = [["manual", "手动顺序"], ["due", "截止日期"], ["created", "创建时间"], ["updated", "更新时间"], ["priority", "优先级"], ["type", "卡片类型"], ["size", "卡片面积"]] as const;
const groups = [["keep", "保留分区"], ["none", "取消分区"], ["type", "按类型分区"], ["priority", "按优先级分区"], ["date", "按日期分区"]] as const;
export function SpaceOrganizer({ host, disabled = false }: { host: ControlHost; disabled?: boolean }) {
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot), cards = useVivicState(s => s.cards);
  const [initialDraft] = useState(() => readOrganizationDraft(snapshot.activeCanvasId));
  const [options, setOptions] = useState<OrganizeOptions>(initialDraft ?? { sort: "due", direction: "asc", group: "keep" });
  const [preview, setPreview] = useState<ReturnType<typeof organizationPreview> | null>(() => initialDraft ? organizationPreview(cards, initialDraft) : null);
  const accepted = useRef<{ canvasId: string; version: number; ownerId: string | null } | null>(initialDraft && snapshot.activeCanvasId ? { canvasId: snapshot.activeCanvasId, version: snapshot.canvases.find(c => c.id === snapshot.activeCanvasId)?.version ?? 0, ownerId: snapshot.ownerId } : null);
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]), [section, setSection] = useState("");
  const [priority, setPriority] = useState<"" | "high" | "normal" | "low">("");
  const [due, setDue] = useState("");
  const readonly = disabled || busy || !snapshot.ready || snapshot.ownerMode !== "owner";
  const currentVersion = snapshot.canvases.find(c => c.id === snapshot.activeCanvasId)?.version ?? 0;
  const change = (patch: Partial<OrganizeOptions>) => { setOptions({ ...options, ...patch }); setPreview(null); accepted.current = null; };
  const complete = async (run: () => { ok: boolean; error?: string }, text: string) => {
    const current = host.getSnapshot(); if (!current.activeCanvasId || readonly) return;
    setBusy(true); setMessage("");
    try {
      const result = run(); if (!result.ok) { setMessage(result.error ?? "操作未完成。"); return; }
      const revision = host.getSnapshot().canvases.find(c => c.id === current.activeCanvasId)?.version ?? 0;
      await host.flush(current.activeCanvasId, revision); setMessage(text);
    } catch { setMessage("保存结果尚未确认，请检查连接后重试。"); }
    finally { setBusy(false); }
  };
  return <details className="se-details" data-space-organizer open={initialDraft ? true : undefined}>
    <summary>整理与分区</summary>
    <div className="se-detail-body space-organizer-body">
      {preview ? <div className="space-arrange-review-heading"><span>{sorts.find(([id]) => id === options.sort)?.[1]} · {groups.find(([id]) => id === options.group)?.[1]}</span><Button size="sm" variant="ghost" onClick={() => { setPreview(null); accepted.current = null; }}>调整规则</Button></div> : <><div className="space-arrange-controls">
        <label>排序 <select aria-label="卡片排序" value={options.sort} disabled={readonly} onChange={e => change({ sort: e.target.value as OrganizeOptions["sort"] })} className="rounded-lg border border-border bg-background p-2">{sorts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>顺序 <select aria-label="排序方向" value={options.direction} disabled={readonly} onChange={e => change({ direction: e.target.value as OrganizeOptions["direction"] })} className="rounded-lg border border-border bg-background p-2"><option value="asc">从小到大 / 最早优先</option><option value="desc">从大到小 / 最新优先</option></select></label>
        <label>分区 <select aria-label="分区方式" value={options.group} disabled={readonly} onChange={e => change({ group: e.target.value as OrganizeOptions["group"] })} className="rounded-lg border border-border bg-background p-2">{groups.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <p className="se-caption">固定卡片保留原位。没有截止日期的放最后；一次整理可以整体撤销。</p>
      <Button size="sm" variant="outline" disabled={readonly || !cards.length} onClick={() => {
        if (!snapshot.activeCanvasId) return;
        accepted.current = { canvasId: snapshot.activeCanvasId, version: currentVersion, ownerId: snapshot.ownerId };
        setPreview(organizationPreview(cards, options)); setMessage("");
      }}>预览整理</Button></>}
      {preview && <HarkSurface as="div" className="space-arrange-preview" aria-label="整理预览">
        <header><HarkIcon name="apps" size={18} /><div><h3>整理后的 Space</h3><p>{preview.length} 张卡片 · {sorts.find(([id]) => id === options.sort)?.[1]}</p></div></header>
        <div className="space-arrange-list">{[...new Set(preview.map(card => card.section))].map(section => <div className="space-arrange-group" key={section}>
          <h4>{section}<span>{preview.filter(card => card.section === section).length}</span></h4>
          <ol>{preview.filter(card => card.section === section).map(card => <li key={card.id}><span className="space-arrange-card-icon"><HarkIcon name="card" size={15} /></span><span>{card.title.slice(0, 80)}</span>{card.pinned && <HarkIcon name="pin" size={13} aria-label="位置固定" />}</li>)}</ol>
        </div>)}</div>
        <footer><span>应用后仍可撤销</span><Button size="sm" disabled={readonly} onClick={() => {
          const baseline = accepted.current, current = host.getSnapshot();
          if (!baseline || baseline.canvasId !== current.activeCanvasId || baseline.ownerId !== current.ownerId) { setPreview(null); setMessage("空间或控制权已变化，请重新预览。"); return; }
          void complete(() => host.organizeCanvas(options, baseline.version), "已整理并保存，可以撤销。");
          setPreview(null); accepted.current = null; clearOrganizationDraft();
        }}>应用整理<HarkIcon name="check" size={14} /></Button></footer>
      </HarkSurface>}
      <details hidden={Boolean(preview)}><summary className="cursor-pointer text-sm">自定义分区与优先级</summary><div className="space-y-3 pt-3">
        <div className="max-h-48 overflow-auto space-y-2">{cards.filter(c => !c.exitingRequestId).map(({ record }) => <label key={record.id} className="flex gap-2 text-xs items-center"><input type="checkbox" disabled={readonly} checked={selected.includes(record.id)} onChange={e => setSelected(e.target.checked ? [...selected, record.id] : selected.filter(id => id !== record.id))} />{cardTitle(record).slice(0, 64)}<span className="opacity-50">{record.metadata.section ?? "未分区"}</span></label>)}</div>
        <div className="flex flex-wrap gap-2"><Input aria-label="分区名称" placeholder="分区名称，例如旅行" maxLength={60} value={section} disabled={readonly} onChange={e => setSection(e.target.value)} className="max-w-48" /><select aria-label="设置优先级" disabled={readonly} value={priority} onChange={e => setPriority(e.target.value as typeof priority)} className="rounded-lg border border-border bg-background p-2 text-xs"><option value="">保留优先级</option><option value="high">重要</option><option value="normal">常规</option><option value="low">稍后</option></select><Input type="date" aria-label="卡片截止日期" value={due} disabled={readonly} onChange={e => setDue(e.target.value)} className="max-w-44" /></div>
        <div className="flex gap-2"><Button size="sm" disabled={readonly || !selected.length || (!section.trim() && !priority && !due)} onClick={() => {
          const patch: CardOrganization = { ...(section.trim() ? { section: section.trim() } : {}), ...(priority ? { priority } : {}), ...(due ? { dueDate: due } : {}) };
          void complete(() => host.setCardOrganization(selected, patch, snapshot.activeCanvasId ?? ""), "已保存分类。预览整理可按分区排布。");
        }}>保存分类</Button><Button size="sm" variant="ghost" disabled={readonly || !selected.length} onClick={() => void complete(() => host.setCardOrganization(selected, { section: "", dueDate: "", priority: "normal" }, snapshot.activeCanvasId ?? ""), "已清除所选卡片的分类。")}>清除分类</Button></div>
      </div></details>
      {message && <p role="status" className="se-caption">{message}</p>}
    </div>
  </details>;
}
