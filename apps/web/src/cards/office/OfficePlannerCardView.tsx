import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";
import { Dialog } from "radix-ui";
import { ControlDialogContent } from "@/control/ControlDialogContent";
import { canonicalJson, isObject, validateInstance, type CardDefinition, type JsonObject } from "@vivic/card-runtime";
import { SceneCardShell, SceneEmpty } from "../scene/SceneCardShell";
import { useCardEditor } from "../scene/cardContext";
import type { CardViewProps } from "../scene/types";
import { officePlannerKind, type OfficePlannerKind } from "./builtinOfficePackages";
import "@/components/hark/hark.css";
import "./officePlanner.css";

const STATUS = ["待办", "进行中", "受阻", "完成"] as const;
const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日", "待安排"] as const;
type Status = typeof STATUS[number];
type OfficeItem = { id: string; title: string; status: Status; owner?: string; due?: string; note?: string; priority?: string; day?: string };
const text = (value: unknown) => typeof value === "string" ? value : "";
function readItems(state: JsonObject): OfficeItem[] {
  if (!Array.isArray(state.items)) throw new Error("行动项需要列表");
  return state.items.map(item => {
    if (!isObject(item) || typeof item.id !== "string" || typeof item.title !== "string" || !STATUS.some(status => status === item.status)) throw new Error("行动项格式不正确");
    const status = STATUS.find(value => value === item.status)!;
    return { id: item.id, title: item.title, status, ...Object.fromEntries(["owner", "due", "note", "priority", "day"].filter(key => typeof item[key] === "string").map(key => [key, item[key]])) };
  });
}
type Mutable = { config: JsonObject; state: JsonObject };
interface UndoEdit { before: Mutable; after: string }

/** Host-written UI over the same inert config/data/state package protocol. */
export function OfficePlannerCardView({ card, height, definition, kind, preview = false }: CardViewProps<"ExtensionCard"> & { definition: CardDefinition; kind: OfficePlannerKind; preview?: boolean }) {
  const editor = useCardEditor(card);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [parameters, setParameters] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoEdit | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const props = card.displayProps;
  let items: OfficeItem[] = [];
  let problem: string | undefined;
  try {
    if (officePlannerKind(definition) !== kind || definition.hash !== props.def.hash || definition.manifest.id !== props.def.id || definition.manifest.version !== props.def.version) throw new Error("卡片定义与办公视图不匹配");
    validateInstance(definition, props);
    items = readItems(props.state);
  } catch (cause) { problem = cause instanceof Error ? cause.message : "卡片数据不可用"; }
  const mutable: Mutable = { config: props.config, state: props.state };
  const canUndo = undo !== null && undo.after === canonicalJson(mutable);
  const commit = (next: Mutable, remember = true): boolean => {
    if (!editor.editable) return false;
    try { validateInstance(definition, { ...props, ...next }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "内容未通过校验"); return false; }
    if (!editor.patch(next)) { setError("没有保存。请确认主窗口仍可编辑，然后重试。"); return false; }
    setError(null);
    setUndo(remember ? { before: structuredClone(mutable), after: canonicalJson(next) } : null);
    return true;
  };
  const saveItems = (next: OfficeItem[]) => commit({ config: props.config, state: { ...props.state, items: next } });
  const completed = items.filter(item => item.status === "完成").length;
  const blocked = items.filter(item => item.status === "受阻").length;
  const percent = items.length ? Math.round(completed / items.length * 100) : 0;
  const demo = preview || props.data.origin === "demo";
  const icon = kind === "meeting" ? "file" : kind === "week" ? "calendar" : "list";
  const groups = kind === "week" ? DAYS.map(day => ({ label: day, entries: items.map((item, index) => ({ item, index })).filter(({ item }) => (item.day || "待安排") === day) })).filter(group => group.entries.length)
    : [{ label: "", entries: items.map((item, index) => ({ item, index })) }];
  const title = text(props.config.title) || definition.manifest.name;
  return <SceneCardShell card={card} height={height} title={title} kicker={definition.manifest.name} harkIcon={icon}
    badge={demo ? "DEMO · 虚构样例" : "用户输入"} badgeTone={demo ? "caution" : "neutral"}
    meta={kind === "week" ? text(props.config.period) : undefined}
    footer={<><span>Space 内整理，未同步外部日历</span>{editor.editable && canUndo && <button type="button" className="vivic-scene-action nodrag nopan" onClick={() => { if (undo) commit(undo.before, false); }}><HarkIcon name="refresh" size={13} aria-hidden />撤销上次编辑</button>}</>}
    className="vivic-office vh-hark">
    {problem ? <SceneEmpty>{problem}</SceneEmpty> : <div className="vivic-office-content" data-office-planner={kind} data-extension-rendered={definition.manifest.id} data-hark-card="action-list">
      {text(props.config.context) && <p className="vivic-office-context">{text(props.config.context)}</p>}
      <div className="vivic-office-progress"><span><strong>{completed}</strong> / {items.length} 已完成</span>{blocked > 0 && <span className="vivic-office-blocked">{blocked} 项受阻</span>}<progress max={100} value={percent} aria-label="行动完成比例" /></div>
      <div className={`vivic-office-list${height !== undefined ? " vivic-scene-scroll nowheel" : ""}`}>
        {!items.length && <SceneEmpty>{kind === "meeting" ? "还没有行动项。先补充会议笔记中的下一步。" : "还没有行动项。先添加一件要推进的事。"}</SceneEmpty>}
        {groups.map(group => <section key={group.label || "all"} className="vivic-office-group">
          {group.label && <h4 className="vivic-office-day">{group.label}<span>{group.entries.length}</span></h4>}
          {group.entries.map(({ item, index }) => <HarkSurface as="article" key={`${index}:${item.id}`} className="vivic-office-row" data-office-item={item.id} data-status={item.status}>
            {editor.editable ? <button type="button" className="vivic-office-check nodrag nopan" role="checkbox" aria-checked={item.status === "完成"} aria-label={`${item.title}：标记${item.status === "完成" ? "未完成" : "完成"}`}
              onClick={() => saveItems(items.map((row, rowIndex) => rowIndex === index ? { ...row, status: row.status === "完成" ? "待办" : "完成" } : row))}><HarkIcon name="check" size={13} aria-hidden /></button>
              : <span className="vivic-office-check" aria-label={item.status === "完成" ? "已完成" : item.status}><HarkIcon name="check" size={13} aria-hidden /></span>}
            <div className="vivic-office-row-body"><h3 className="vivic-office-item-title">{item.title}</h3>
              <div className="vivic-office-row-meta">{item.owner && <span>{item.owner}</span>}{item.due && <span>截止：{item.due}</span>}{item.priority === "重点" && <span className="vivic-office-priority">重点</span>}<span className="vivic-office-status">{item.status}</span></div>
              {item.note && <p className="vivic-office-note">{item.note}</p>}
            </div>
            {editor.editable && <button type="button" className="vivic-scene-icon-button nodrag nopan" aria-label={`编辑：${item.title}`} onClick={event => { opener.current = event.currentTarget; setEditing(index); setParameters(false); setError(null); }}><HarkIcon name="edit" size={14} aria-hidden /></button>}
          </HarkSurface>)}
        </section>)}
      </div>
      {text(props.state.note) && <p className="vivic-office-note">备注：{text(props.state.note)}</p>}
      {editor.editable && <div className="vivic-office-toolbar nodrag nopan">
        <button type="button" className="vivic-scene-action" disabled={items.length >= 40} onClick={event => { opener.current = event.currentTarget; setEditing("new"); setParameters(false); setError(null); }}><HarkIcon name="add" size={14} aria-hidden />添加行动</button>
        <button type="button" className="vivic-scene-action" onClick={event => { opener.current = event.currentTarget; setParameters(value => !value); setEditing(null); setError(null); }}><HarkIcon name="edit" size={13} aria-hidden />编辑参数</button>
      </div>}
      <Dialog.Root open={editor.editable && (editing !== null || parameters)} onOpenChange={open => { if (!open) { setEditing(null); setParameters(false); setError(null); } }}>
      {(editing !== null || parameters) && <ControlDialogContent title={parameters ? "编辑卡片参数" : editing === "new" ? "添加行动" : "编辑行动"} description="保存后更新当前卡片；取消会保留原有内容。" className="vivic-office-editor" onCloseAutoFocus={event => { event.preventDefault(); if (opener.current?.isConnected) opener.current.focus(); }}>
      <div className="vivic-office-editor-body">
      {editor.editable && editing !== null && <ItemForm key={`${editing}:${editing === "new" ? "new" : canonicalJson(items[editing] ?? {})}`} kind={kind} item={editing === "new" ? undefined : items[editing]}
        onCancel={() => setEditing(null)} onRemove={editing === "new" ? undefined : () => { if (saveItems(items.filter((_, index) => index !== editing))) setEditing(null); }}
        onSave={item => {
          const used = new Set(items.map(row => row.id)); let number = items.length + 1; while (used.has(`action-${number}`)) number += 1;
          const next = editing === "new" ? [...items, { ...item, id: `action-${number}` }] : items.map((row, index) => index === editing ? { ...row, ...item, id: row.id } : row);
          if (saveItems(next)) setEditing(null);
        }} />}
      {editor.editable && parameters && <ParameterForm key={canonicalJson(mutable)} kind={kind} value={mutable} onCancel={() => setParameters(false)} onSave={next => { if (commit(next)) setParameters(false); }} />}
      {error && <p role="alert" className="vivic-office-error">{error}</p>}
      </div></ControlDialogContent>}
      </Dialog.Root>
      {error && editing === null && !parameters && <p role="alert" className="vivic-office-error">{error}</p>}
    </div>}
  </SceneCardShell>;
}

function ItemForm({ kind, item, onSave, onCancel, onRemove }: { kind: OfficePlannerKind; item?: OfficeItem; onSave: (value: OfficeItem) => void; onCancel: () => void; onRemove?: () => void }) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const get = (key: string) => text(data.get(key)).trim();
    const title = get("title"); if (!title) return;
    const status = STATUS.find(value => value === get("status")) ?? "待办";
    onSave({ id: item?.id ?? "new", title, owner: get("owner"), due: get("due"), note: get("note"), status,
      ...(kind === "tasks" ? { priority: get("priority") } : {}), ...(kind === "week" ? { day: get("day") } : {}) });
  };
  return <form onSubmit={submit} className="vivic-office-form nodrag nopan" aria-label={item ? "编辑行动" : "添加行动"}>
    <FormField label="行动内容"><input name="title" aria-label="行动内容" defaultValue={item?.title ?? ""} maxLength={160} required className="vivic-scene-input" /></FormField>
    <div className="vivic-office-fields"><FormField label="负责人"><input name="owner" aria-label="负责人" defaultValue={item?.owner ?? ""} maxLength={80} placeholder="未指定" className="vivic-scene-input" /></FormField>
      <FormField label="截止说明"><input name="due" aria-label="截止说明" defaultValue={item?.due ?? ""} maxLength={100} placeholder="保留原文，如周五下午" className="vivic-scene-input" /></FormField></div>
    <div className="vivic-office-fields"><FormField label="状态"><select name="status" aria-label="状态" defaultValue={item?.status ?? "待办"} className="vivic-scene-input">{STATUS.map(value => <option key={value}>{value}</option>)}</select></FormField>
      {kind === "tasks" && <FormField label="优先级"><select name="priority" aria-label="优先级" defaultValue={item?.priority ?? "常规"} className="vivic-scene-input">{["重点", "常规", "稍后"].map(value => <option key={value}>{value}</option>)}</select></FormField>}
      {kind === "week" && <FormField label="星期"><select name="day" aria-label="星期" defaultValue={item?.day ?? "待安排"} className="vivic-scene-input">{DAYS.map(value => <option key={value}>{value}</option>)}</select></FormField>}</div>
    <FormField label="行动备注"><textarea name="note" aria-label="行动备注" defaultValue={item?.note ?? ""} maxLength={500} className="vivic-scene-input" rows={2} /></FormField>
    <div className="vivic-office-form-actions"><button type="submit" className="vivic-scene-action"><HarkIcon name="check" size={14} aria-hidden />保存行动</button><button type="button" className="vivic-scene-action" onClick={onCancel}><HarkIcon name="close" size={14} aria-hidden />取消</button>{onRemove && <button type="button" className="vivic-scene-action vivic-office-remove" onClick={onRemove}>删除行动</button>}</div>
  </form>;
}
function FormField({ label, children }: { label: string; children: ReactNode }) { return <label className="vivic-office-field"><span>{label}</span>{children}</label>; }
function ParameterForm({ kind, value, onSave, onCancel }: { kind: OfficePlannerKind; value: Mutable; onSave: (value: Mutable) => void; onCancel: () => void }) {
  return <form className="vivic-office-form nodrag nopan" aria-label="编辑卡片参数" onSubmit={event => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const get = (key: string) => text(data.get(key)).trim(); if (!get("title")) return;
    onSave({ config: { ...value.config, title: get("title"), context: get("context"), ...(kind === "week" ? { period: get("period") } : {}) }, state: { ...value.state, note: get("note") } });
  }}>
    <FormField label="卡片标题"><input name="title" aria-label="卡片标题" className="vivic-scene-input" defaultValue={text(value.config.title)} required maxLength={80} /></FormField>
    {kind === "week" && <FormField label="计划周期"><input name="period" aria-label="计划周期" className="vivic-scene-input" defaultValue={text(value.config.period)} maxLength={80} /></FormField>}
    <FormField label={kind === "meeting" ? "会议结论" : "计划说明"}><textarea name="context" aria-label={kind === "meeting" ? "会议结论" : "计划说明"} className="vivic-scene-input" defaultValue={text(value.config.context)} rows={3} maxLength={1200} /></FormField>
    <FormField label="整体备注"><textarea name="note" aria-label="整体备注" className="vivic-scene-input" defaultValue={text(value.state.note)} rows={2} maxLength={1000} /></FormField>
    <div className="vivic-office-form-actions"><button type="submit" className="vivic-scene-action">保存参数</button><button type="button" className="vivic-scene-action" onClick={onCancel}>取消</button></div>
  </form>;
}
