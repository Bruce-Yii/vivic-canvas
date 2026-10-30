import { useContext, useEffect, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import { motion, useReducedMotion } from "motion/react";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { cardTargets, sameCardTarget, type Action, type CardRecord, type CardTarget, type Subcard } from "@/contracts";
import { Button } from "@/components/ui/button";
import { newId } from "@/lib/id";
import { getDisplayStatus } from "@/sync/displayStatus";
import { renderVivicSpec } from "./vivicGUILibrary";
import { SubcardEditorContext, SubcardThemeContext, type SubcardEditor } from "./SubcardEditorContext";
import { ControlOverlayContext } from "@/control/ControlOverlayContext";

interface AnchorProps { card: CardRecord; itemId?: string; children?: ReactNode }

/** A row keeps its real content; only its expansion trigger is interactive. */
export const SubcardAnchor = (props: AnchorProps) => {
  const editor = useContext(SubcardEditorContext);
  const target = cardTargets(props.card).find(item => item.itemId === props.itemId);
  // Reset the entire reading/editing session when its source changes.
  return <SubcardContent key={`${props.card.id}:${props.itemId ?? "card"}:${target?.anchor ?? ""}:${editor?.editable ?? "reader"}`} {...props} target={target} editor={editor} />;
};

const SubcardContent = ({ card, itemId, children, target, editor }: AnchorProps & { target?: CardTarget; editor: SubcardEditor | null }) => {
  const theme = useContext(SubcardThemeContext);
  const overlayHost = useContext(ControlOverlayContext);
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reduced = useReducedMotion();
  const subcards = (card.metadata.subcards ?? []).filter(item => target && sameCardTarget(item, target));
  const identity = `${card.id}:${itemId ?? "card"}:${target?.anchor ?? ""}`;
  useEffect(() => {
    if (!open) return;
    const resize = () => setCompact(window.innerWidth < 600);
    window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize);
  }, [open]);
  useEffect(() => {
    if (!open || editor) return;
    const viewKey = getDisplayStatus()?.viewKey;
    const timer = setInterval(() => {
      const status = getDisplayStatus();
      if (!status?.canInteract || status.viewKey !== viewKey) setOpen(false);
    }, 250);
    return () => clearInterval(timer);
  }, [open, editor]);
  if (!target || (!editor?.editable && !subcards.length)) return <>{children}</>;
  const write = (action: Action) => {
    if (!editor?.editable || !editor.dispatch(action)) { setError("原行或控制权已变更，尚未保存。请重新打开后再试。"); return false; }
    setError(null); return true;
  };
  const startNew = () => { setEditingId(null); setDraft(""); };
  return <div className="vivic-subcard-anchor" data-vivic-subcard-anchor={itemId ?? "card"}>
    {children && <div className="min-w-0 flex-1">{children}</div>}
    <Popover.Root open={open} onOpenChange={value => { setOpen(value); if (value) { setCompact(window.innerWidth < 600); startNew(); setError(null); } }}>
      <Popover.Trigger asChild>
        <button type="button" className="nodrag nopan vivic-subcard-trigger" aria-label={`${subcards.length ? "查看" : "添加"}子卡片：${target.label.slice(0, 70)}`}
          data-vivic-subcard-trigger={itemId ?? "card"} data-has-subcards={subcards.length > 0 || undefined}>
          <HarkIcon name="chat" size={16} aria-hidden />{subcards.length > 0 && <span>{subcards.length}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal container={overlayHost ?? undefined}>
        <Popover.Content side={compact ? "bottom" : "right"} align="center" sideOffset={28} collisionPadding={12} updatePositionStrategy="always" hideWhenDetached
          className={`${theme === "dark" ? "dark " : ""}vh-hark vivic-subcard-popover nodrag nopan nowheel`} data-appearance={theme} aria-label="行扩充子卡片" data-vivic-subcard-popover data-parent-id={card.id} data-item-id={itemId}>
          <motion.div initial={{ opacity: 0, y: reduced ? 0 : 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduced ? 0 : 0.16 }}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><p className="text-sm font-semibold">{itemId ? "这一行的扩充" : "卡片扩充"}</p>
                <p className="mt-1 break-words text-xs text-muted-foreground line-clamp-3">{target.label}</p></div>
              <Popover.Close asChild><button type="button" className="rounded p-1 focus-visible:outline-2" aria-label="关闭子卡片"><HarkIcon name="close" size={16} /></button></Popover.Close>
            </div>
            <div className="vivic-subcard-scroll">
              {subcards.map(item => <article key={item.id} data-vivic-subcard={item.id} className="border-b border-border py-3 last:border-0">
                <div className="break-words text-sm leading-7 select-text">{renderVivicSpec({ _type: "Markdown", value: item.text })}</div>
                {editor?.editable && <div className="mt-2 flex justify-end gap-1">
                  <Button type="button" variant="ghost" size="sm" aria-label="编辑这张子卡片" onClick={() => { setEditingId(item.id); setDraft(item.text); }}><HarkIcon name="edit" size={14} />编辑</Button>
                  <Button type="button" variant="ghost" size="sm" aria-label="删除这张子卡片" onClick={() => {
                    if (write({ type: "card.subcard.delete", targetId: card.id, subcardId: item.id }) && editingId === item.id) startNew();
                  }}><HarkIcon name="trash" size={14} />删除</Button>
                </div>}
              </article>)}
              {editor?.editable && <form className="mt-3 space-y-2" onSubmit={event => {
                event.preventDefault();
                if (!draft.trim()) return;
                const subcard: Subcard = { id: editingId ?? newId("subcard"), itemId: target.itemId, anchor: target.anchor, text: draft.trim() };
                if (write({ type: "card.subcard.set", targetId: card.id, subcard })) startNew();
              }}>
                <label className="text-xs font-medium" htmlFor={`subcard-${identity}`}>{editingId ? "编辑扩充内容" : "添加扩充内容"}</label>
                {!editingId && (card.metadata.subcards?.length ?? 0) >= 24 && <p role="status" className="text-xs text-muted-foreground">这张卡片已满 24 张子卡片，可以编辑已有内容或删除后再添加。</p>}
                <textarea id={`subcard-${identity}`} className="w-full rounded-md border border-input bg-background p-2 text-sm leading-6 focus-visible:outline-2" rows={4}
                  maxLength={2000} value={draft} onChange={event => setDraft(event.target.value)} placeholder="补充说明、细节或下一步…" />
                <div className="flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{draft.length}/2000</span>
                  <div className="flex gap-2">{editingId && <Button type="button" variant="ghost" size="sm" onClick={startNew}>取消编辑</Button>}
                    <Button type="submit" size="sm" disabled={!draft.trim() || (!editingId && (card.metadata.subcards?.length ?? 0) >= 24)}>保存子卡片</Button></div></div>
                {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
              </form>}
            </div>
          </motion.div>
          <Popover.Arrow width={20} height={10} className="fill-card stroke-border [stroke-width:1]" data-vivic-subcard-arrow />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  </div>;
};
