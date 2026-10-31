import { ExternalLink, Star } from "lucide-react";
import { useState } from "react";
import { SceneCardShell, SceneEmpty } from "../SceneCardShell";
import { useCardEditor } from "../cardContext";
import { MediaImage } from "../MediaImage";
import type { CardViewProps } from "../types";
import "./TravelOffersCardView.css";

/** Minimal reference renderer. Service fields remain read-only in UI and owner validation. */
export function TravelOffersCardView({ card, height }: CardViewProps<"TravelOffersCard">) {
  const { query, items, fetchedAt, mode, selectedIds, notes } = card.displayProps;
  const editor = useCardEditor(card);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const save = (patch: { notes?: string; selectedIds?: string[] }) => {
    const ok = editor.patch(patch);
    setEditError(ok ? null : "没有保存，已保留输入，请重试。");
    return ok;
  };
  const refresh = async () => {
    if (!editor.refresh || refreshing) return;
    setRefreshing(true); setRefreshFailed(false);
    try { setRefreshFailed(!await editor.refresh()); } catch { setRefreshFailed(true); }
    finally { setRefreshing(false); }
  };
  const selected = new Set(selectedIds);
  const expired = card.sourceData.expiresAt && Date.parse(card.sourceData.expiresAt) <= Date.now();
  return <SceneCardShell card={card} height={height} title={`${query.destination} · ${query.kind === "hotel" ? "住宿" : query.kind === "flight" ? "航班" : "景点"}`}
    badge={mode === "demo" ? "DEMO · 模拟数据" : expired ? "已过期" : "服务数据"} badgeTone={mode === "demo" || expired ? "caution" : "neutral"}
    meta={[query.startDate ?? query.dateText, query.nights ? `${query.nights}晚` : null, query.budget ? `预算 ${query.budget}` : null].filter(Boolean).join(" · ")}
    footer={<span>{card.sourceData.provider} · <time dateTime={fetchedAt}>{new Date(fetchedAt).toLocaleString("zh-CN", { hour12: false })}</time>{expired ? " · 结果已过期，请重新查询" : ""}</span>}>
    <div className={`vivic-travel${height === undefined ? "" : " vivic-scene-scroll nowheel"}`}>
      {editor.refresh && <div className="vivic-travel-actions"><button type="button" className="nodrag nopan" disabled={refreshing} onClick={() => { void refresh(); }}>{refreshing ? "正在查询…" : "刷新结果"}</button>{refreshFailed && <span role="status">刷新失败，保留原结果。</span>}</div>}
      {mode === "demo" && <p className="vivic-scene-muted text-xs">演示内容为虚构样例，不代表真实价格、库存或预订结果。</p>}
      {!items.length && <SceneEmpty>没有符合条件的结果，可调整条件重新查询。</SceneEmpty>}
      <ul className="vivic-travel-list">{items.map(item => <li key={item.id} className="vivic-travel-item" data-selected={selected.has(item.id) || undefined}>
        {item.imageUrl && <MediaImage className="vivic-travel-image" src={item.imageUrl} alt={item.title} />}
        <div className="vivic-travel-detail">
          <strong>{item.title}</strong>
          {item.subtitle && <p className="vivic-scene-muted">{item.subtitle}</p>}
          <div className="vivic-travel-facts">
            {item.price && <span>{new Intl.NumberFormat("zh-CN", { style: "currency", currency: item.price.currency }).format(item.price.amount)}</span>}
            {item.rating !== undefined && <span><Star size={12} aria-hidden />{item.rating}/5</span>}
            {item.tags.map(tag => <span key={tag} className="vivic-travel-tag">{tag}</span>)}
          </div>
          <div className="vivic-travel-actions">
            {editor.editable && <button type="button" className="vivic-scene-action nodrag nopan" aria-pressed={selected.has(item.id)} onClick={() => save({ selectedIds: selected.has(item.id) ? selectedIds.filter(id => id !== item.id) : [...selectedIds, item.id] })}>{selected.has(item.id) ? "已选择" : "选择"}</button>}
            {item.detailUrl && <a className="nodrag nopan" href={item.detailUrl} target="_blank" rel="noopener noreferrer">查看来源 <ExternalLink size={12} aria-hidden /></a>}
          </div>
        </div>
      </li>)}</ul>
      {editor.editable ? <label className="vivic-travel-notes">我的备注<textarea aria-label="旅游备注" className="nodrag nopan" value={noteDraft ?? notes} maxLength={2000}
        onChange={event => setNoteDraft(event.target.value)} onBlur={() => { if (noteDraft !== null && save({ notes: noteDraft })) setNoteDraft(null); }}
        onKeyDown={event => { if (event.key === "Escape") { setNoteDraft(null); setEditError(null); } }} /></label>
        : notes && <p className="vivic-scene-muted">{notes}</p>}
      {editError && <p role="alert" className="text-xs text-[var(--vivic-danger)]">{editError}</p>}
    </div>
  </SceneCardShell>;
}
