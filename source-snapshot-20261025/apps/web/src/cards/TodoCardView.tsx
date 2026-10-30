import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { TodoCard } from "@/contracts";
import { renderVivicSpec } from "./vivicGUILibrary";
import { SubcardAnchor } from "./SubcardAnchor";
import { useCardEditor } from "./scene/cardContext";
import { TODO_VISIBLE_ITEMS } from "./sizing";
import "./scene/sceneCards.css";

export const TODO_MAX_ITEMS = 30;

/**
 * Todo list. A titled list (todo_list scene) also shows its progress; an
 * untitled quick list keeps the original minimal checkbox rows. Display shows
 * the first rows read-only; the user page shows every row and toggles state.
 */
export const TodoCardView = ({
  card,
  highlightedItemId,
}: {
  card: TodoCard;
  highlightedItemId?: string;
}) => {
  const editor = useCardEditor(card);
  const [draft, setDraft] = useState("");
  const all = card.displayProps.items;
  const items = editor.mode === "control" ? all : all.slice(0, TODO_VISIBLE_ITEMS);
  const done = all.filter(item => item.done).length;
  const title = card.displayProps.title;
  const setItems = (next: TodoCard["displayProps"]["items"]) => editor.patch({ items: next });
  return <div className="flex flex-col gap-2" data-vivic-todo-card>
    {title && <div className="flex flex-col gap-1.5 pr-6" data-vivic-todo-header>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="vivic-scene-title m-0">{title}</h3>
        <span className="shrink-0 text-xs tabular-nums text-[var(--vivic-muted-ink)]" data-vivic-todo-progress>{done}/{all.length}</span>
      </div>
      <div className="vivic-scene-bar" role="progressbar" aria-label="完成进度" aria-valuemin={0} aria-valuemax={all.length} aria-valuenow={done}>
        <i style={{ width: `${all.length ? (done / all.length) * 100 : 0}%` }} />
      </div>
    </div>}
    {items.map(item => <div key={item.id} data-vivic-todo-row={item.id} className={editor.editable ? "group flex items-start gap-1" : undefined}>
      {editor.editable
        ? <>
          <button type="button" role="checkbox" aria-checked={item.done} className="nodrag flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-md text-left focus-visible:outline-2"
            data-vivic-todo-toggle={item.id} data-aui="checkbox" data-vivic-highlighted={item.id === highlightedItemId || undefined}
            onClick={() => setItems(all.map(row => row.id === item.id ? { ...row, done: !row.done } : row))}>
            <input className="pointer-events-none mt-1.5 shrink-0" type="checkbox" checked={item.done} readOnly tabIndex={-1} aria-hidden />
            <span data-aui="option-content" className={`min-w-0 [overflow-wrap:anywhere] ${item.done ? "line-through opacity-55" : ""}`}>{item.text}</span>
          </button>
          {all.length > 1 && <button type="button" className="vivic-scene-icon-button nodrag opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={`删除：${item.text.slice(0, 40)}`} onClick={() => setItems(all.filter(row => row.id !== item.id))}><X size={14} /></button>}
        </>
        : <SubcardAnchor card={card} itemId={item.id}>{renderVivicSpec({ _type: "TodoItem", text: item.text, done: item.done, highlighted: item.id === highlightedItemId })}</SubcardAnchor>}
    </div>)}
    {all.length > items.length && <span className="text-xs text-[var(--vivic-muted-ink)]" data-vivic-todo-more>还有 {all.length - items.length} 项 · 在用户页查看全部</span>}
    {editor.editable && all.length < TODO_MAX_ITEMS && <form className="nodrag flex items-center gap-1.5" onSubmit={event => {
      event.preventDefault();
      const text = draft.trim().slice(0, 160);
      if (!text) return;
      const used = new Set(all.map(item => item.id));
      let index = all.length + 1;
      while (used.has(`item-${index}`)) index += 1;
      if (editor.patch({ items: [...all, { id: `item-${index}`, text, done: false }] })) setDraft("");
    }}>
      <input className="vivic-scene-input flex-1" value={draft} maxLength={160} placeholder="添加一项待办" aria-label="添加待办" onChange={event => setDraft(event.target.value)} />
      <button type="submit" className="vivic-scene-icon-button" aria-label="添加" disabled={!draft.trim()}><Plus size={15} /></button>
    </form>}
  </div>;
};
