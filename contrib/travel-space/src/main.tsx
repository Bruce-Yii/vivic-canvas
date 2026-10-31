import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowDown, ArrowRight, Check, Compass, Download, MapPin, Moon, Palette, RotateCcw, Route, Sparkles, Sun, Wallet, X } from "lucide-react";
import { AtmosphereBackground } from "../../../apps/web/src/components/atmosphere/AtmosphereBackground";
import { ATMOSPHERE_PALETTES, DARK_PALETTE_IDS, LIGHT_PALETTE_IDS, type PaletteId } from "../../../apps/web/src/components/atmosphere/palettes";
import { SceneCardShell } from "../../../apps/web/src/cards/scene/SceneCardShell";
import { CardActionsContext, CardModeContext, useCardEditor } from "../../../apps/web/src/cards/scene/cardContext";
import { TravelOffersCardView } from "../../../apps/web/src/cards/scene/views/TravelOffersCardView";
import { ComparisonCardView } from "../../../apps/web/src/cards/scene/views/ComparisonCardView";
import { DEFAULT_INPUT, TripInputSchema, budgetAllocation, generateTrip, readTrip, updateTripCard, writeTrip, type NoteCard, type Scenario, type Trip, type TripInput } from "./model";
import "../../../apps/web/src/index.css";
import "./space.css";

const browserStorage = {
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
  removeItem: (key: string) => window.localStorage.removeItem(key),
};

function DayCard({ card, number }: { card: NoteCard; number: number }) {
  const editor = useCardEditor(card);
  const [editing, setEditing] = useState(false);
  return <article className="vivic-card travel-day"><SceneCardShell card={card} icon={Route} kicker={`DAY ${String(number).padStart(2, "0")}`} title={card.displayProps.text}
    badge={<button className="travel-edit" type="button" onClick={() => setEditing(!editing)}>{editing ? "完成" : "编辑行程"}</button>}>
    {editing ? <div className="travel-day-editor"><label>当天主题<input aria-label={`第${number}天主题`} value={card.displayProps.text ?? ""} maxLength={120} onChange={event => editor.patch({ text: event.target.value })}/></label>
      {(card.displayProps.bullets ?? []).map((text, index) => <label key={index}>安排 {index + 1}<textarea aria-label={`第${number}天安排${index + 1}`} value={text} maxLength={180} onChange={event => editor.patch({ bullets: card.displayProps.bullets?.map((old, i) => i === index ? event.target.value : old) })}/></label>)}</div>
      : <ol className="travel-stops">{card.displayProps.bullets?.map((text, i) => <li key={i}><span>{["上午", "下午", "晚上"][i]}</span><p>{text || "留白时间"}</p></li>)}</ol>}
  </SceneCardShell></article>;
}

function App() {
  const [initial] = useState(() => readTrip(browserStorage));
  const [trip, setTrip] = useState<Trip | null>(initial.trip);
  const tripRef = useRef(trip); tripRef.current = trip;
  const [input, setInput] = useState<TripInput>(initial.trip?.input ?? DEFAULT_INPUT);
  const [status, setStatus] = useState(initial.warning ?? "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [scenario, setScenario] = useState<Scenario>("ok");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [palette, setPalette] = useState<PaletteId>("milk");
  const [reducedMotion] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const active = useRef<AbortController | null>(null);
  const request = useRef(0);
  const results = useRef<HTMLElement | null>(null);
  useEffect(() => { document.documentElement.classList.toggle("dark", theme === "dark"); }, [theme]);
  useEffect(() => () => active.current?.abort(), []);

  const save = (next: Trip | null) => {
    tripRef.current = next;
    setTrip(next);
    const stored = writeTrip(browserStorage, next);
    if (!stored) setStatus("本次修改尚未保存到浏览器，请先导出旅行计划。");
    return stored;
  };
  const run = async (refreshOnly = false) => {
    const candidate = refreshOnly ? tripRef.current?.input : input;
    const checked = TripInputSchema.safeParse(candidate);
    if (!checked.success) { setError("请填写出发地、目的地、1–7 天行程与 100–100000 元总预算。"); return false; }
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    const sequence = ++request.current;
    setLoading(true); setError(""); setStatus("正在整理你的 DEMO 旅行卡片…");
    try {
      const next = await generateTrip(checked.data, { signal: controller.signal, previous: tripRef.current, scenario });
      if (sequence !== request.current || controller.signal.aborted) return false;
      let stored;
      if (refreshOnly && tripRef.current) {
        next.offers.displayProps.notes = tripRef.current.offers.displayProps.notes;
        next.offers.displayProps.selectedIds = tripRef.current.offers.displayProps.selectedIds.filter(id => next.offers.displayProps.items.some(item => item.id === id));
        stored = save({ ...tripRef.current, offers: next.offers });
      } else stored = save(next);
      if (stored) setStatus("旅行卡片已更新；仅保存在当前浏览器。");
      if (!refreshOnly) requestAnimationFrame(() => results.current?.scrollIntoView({ behavior: reducedMotion ? "instant" : "smooth", block: "start" }));
      return true;
    } catch {
      if (sequence === request.current && !controller.signal.aborted) { setError("演示查询暂不可用。已有卡片已保留，可切回正常结果后重试。"); setStatus(""); }
      return false;
    } finally { if (sequence === request.current) { setLoading(false); active.current = null; } }
  };
  const cancel = () => { ++request.current; active.current?.abort(); active.current = null; setLoading(false); setStatus("已取消，保留上一次旅行计划。"); };
  const update = (id: string, patch: { displayProps?: Record<string, unknown>; sourceData?: Record<string, unknown> }) => {
    if (!tripRef.current) return false;
    const next = updateTripCard(tripRef.current, id, patch);
    if (!next) { setError("这次修改未通过校验，已保留原卡片。"); return false; }
    save(next); return true;
  };
  const download = () => {
    if (!trip) return;
    const text = [`# ${trip.input.destination} · ${trip.input.days} 天旅行计划`, "", "Travel Vivic Space · DEMO 规划模板。非实时行程、报价或预订结果。", `${trip.input.origin} → ${trip.input.destination} · ${trip.input.dateText} · 用户总预算 ¥${trip.input.budget}`, "",
      ...trip.days.flatMap(day => [`## ${day.displayProps.text}`, ...(day.displayProps.bullets ?? []).map(line => `- ${line}`), ""]), "## 预算分配建议（非实际费用）", ...budgetAllocation(trip.input.budget).map(row => `- ${row.name}：¥${row.amount}`), "", "## 我的备注", trip.offers.displayProps.notes || "暂无备注"].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "travel-vivic-plan.md"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const dirty = trip && JSON.stringify(input) !== JSON.stringify(trip.input);
  return <CardModeContext value="control"><CardActionsContext value={{ editable: true, update, refresh: () => run(true) }}>
    <AtmosphereBackground theme={theme} palette={palette} paused={reducedMotion} className="travel-atmosphere"/>
    <div className="travel-space" data-travel-space>
      <header className="travel-header"><a href="#" className="travel-brand" aria-label="Travel Vivic Space 首页"><Compass size={25}/><span>vivic<span className="travel-brand-divider">/</span><strong>travel space</strong></span></a>
        <div className="travel-tools"><span className="travel-demo-tag">DEMO</span><label className="travel-palette"><Palette size={15}/><select aria-label="背景配色" value={palette} onChange={event => setPalette(event.target.value as PaletteId)}>{(theme === "dark" ? DARK_PALETTE_IDS : LIGHT_PALETTE_IDS).map(id => <option key={id} value={id}>{ATMOSPHERE_PALETTES[id].name}</option>)}</select></label><button className="travel-icon" type="button" aria-label={theme === "light" ? "切换深色" : "切换浅色"} onClick={() => { const next = theme === "light" ? "dark" : "light"; setTheme(next); setPalette(next === "dark" ? "midnight" : "milk"); }}>{theme === "light" ? <Moon size={17}/> : <Sun size={17}/>}</button></div>
      </header>
      <main>
        <section className="travel-intro"><span className="travel-eyebrow"><span/> ONE SPACE. YOUR NEXT JOURNEY.</span><h1>下一站，<span>慢慢想清楚。</span></h1><p>把想去的地方，变成一张张能继续调整的旅行卡片。<br/>计划、比较、收藏，放在同一个空间里。</p></section>
        <section className="vivic-card travel-planner" aria-label="规划旅行"><div className="travel-planner-title"><span><Sparkles size={18}/> 从一个旅行想法开始</span><span className="travel-small">独立旅行空间 · 本机保存</span></div>
          <form onSubmit={event => { event.preventDefault(); void run(); }}><div className="travel-fields">
            <label>从哪里出发<div className="travel-input-icon"><MapPin size={16}/><input aria-label="出发地" value={input.origin} required maxLength={40} onChange={event => setInput({ ...input, origin: event.target.value })}/></div></label>
            <label>想去哪里<div className="travel-input-icon"><MapPin size={16}/><input aria-label="目的地" value={input.destination} required maxLength={40} onChange={event => setInput({ ...input, destination: event.target.value })}/></div></label>
            <label>玩几天<select aria-label="旅行天数" value={input.days} onChange={event => setInput({ ...input, days: Number(event.target.value) })}>{Array.from({ length: 7 }, (_, i) => <option key={i} value={i + 1}>{i + 1} 天</option>)}</select></label>
            <label>总预算（元）<input aria-label="总预算" type="number" min="100" max="100000" step="100" value={input.budget} onChange={event => setInput({ ...input, budget: Number(event.target.value) })}/></label>
            <label>出行时间<input aria-label="出行时间" maxLength={40} required value={input.dateText} onChange={event => setInput({ ...input, dateText: event.target.value })}/></label>
          </div><div className="travel-planner-bottom"><div className="travel-preferences" role="group" aria-label="旅行偏好">{(["慢慢走", "城市人文", "自然放松", "亲子友好"] as const).map(preference => <button className="vivic-scene-chip" type="button" key={preference} aria-pressed={input.preference === preference} onClick={() => setInput({ ...input, preference })}>{input.preference === preference && <Check size={12}/>} {preference}</button>)}</div><div className="travel-submit">{loading && <button className="travel-secondary" type="button" onClick={cancel}><X size={15}/>取消</button>}<button className="travel-primary" type="submit" disabled={loading}><Sparkles size={16}/>{loading ? "正在整理…" : trip ? "重新规划" : "生成旅行卡片"}<ArrowRight size={16}/></button></div></div></form>
          {dirty && <p className="travel-pending">条件已调整。重新规划后更新卡片；现有结果仍对应上一组条件。</p>}
          <p className="travel-disclosure">DEMO 体验：行程是可编辑的规划模板，住宿是虚构偏好样例。未接入实时飞猪查询，不提供报价或预订。</p>
        </section>
        <div className="travel-status" aria-live="polite">{status}</div>{error && <div className="travel-error" role="alert">{error}</div>}
        {trip ? <section ref={results} className="travel-results" aria-label="我的旅行卡片"><div className="travel-section-head"><div><span className="travel-eyebrow">YOUR JOURNEY, IN CARDS</span><h2>{trip.input.destination}，{trip.input.days} 天的可能性</h2><p>{trip.input.origin} <ArrowRight size={13}/> {trip.input.destination} <span>· {trip.input.dateText} · {trip.input.preference}</span></p></div><div className="travel-result-actions"><button type="button" className="travel-secondary" onClick={download}><Download size={15}/>导出计划</button><button type="button" className="travel-icon" aria-label="清空旅行空间" onClick={() => { cancel(); save(null); setStatus("旅行空间已清空，可以开始新的计划。"); }}><RotateCcw size={16}/></button></div></div>
          <div className="travel-board"><div className="travel-main-column"><div className="travel-days">{trip.days.map((day, index) => <DayCard key={day.id} card={day} number={index + 1}/>)}</div><article className="vivic-card"><ComparisonCardView card={trip.comparison}/></article></div>
            <aside className="travel-side-column"><article className="vivic-card travel-budget"><SceneCardShell card={trip.comparison} icon={Wallet} kicker="预算分配" title="把余量，也留进计划里" badge="用户预算" footer="按 40% / 25% / 20% / 15% 分配，仅为规划建议，不是实际费用。"><div className="travel-budget-total"><span>¥{trip.input.budget.toLocaleString("zh-CN")}</span><small>总预算</small></div><div className="travel-budget-bar">{budgetAllocation(trip.input.budget).map((row, i) => <span key={row.name} style={{ flex: row.amount }} data-part={i}/>)}</div><dl>{budgetAllocation(trip.input.budget).map(row => <div key={row.name}><dt>{row.name}</dt><dd>¥{row.amount.toLocaleString("zh-CN")}</dd></div>)}</dl></SceneCardShell></article>
              <article className="vivic-card"><TravelOffersCardView card={trip.offers}/></article></aside></div>
        </section> : <section className="travel-empty"><span className="travel-empty-icon"><Route size={30}/></span><h2>旅行，还可以边走边想。</h2><p>先生成一个计划，再把每一天改成自己的节奏。</p><span className="travel-empty-hint"><ArrowDown size={14}/> 行程 · 方案比较 · 预算 · 住宿收藏</span></section>}
        <details className="travel-demo-controls"><summary>演示状态与数据说明</summary><p>这里可体验空结果、失败与取消。所有卡片保存在当前浏览器的独立旅行空间，链接只分享应用入口，不包含你的计划。</p><label>下一次演示查询<select aria-label="演示查询状态" value={scenario} onChange={event => setScenario(event.target.value as Scenario)}><option value="ok">正常结果</option><option value="empty">空结果</option><option value="error">模拟失败</option></select></label><p>重新规划会重建每日安排；同一目的地的有效收藏与备注会保留。导出可保留手动编辑。</p></details>
      </main><footer className="travel-footer"><span>VIVIC · 从一句想法，到一个空间</span><span>旅行体验 DEMO · 无实时服务连接</span></footer>
    </div>
  </CardActionsContext></CardModeContext>;
}

class SpaceBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <main className="travel-fallback"><h1>旅行空间暂时无法显示</h1><p>刷新后重试。已保存的数据不会被自动清除。</p><button onClick={() => location.reload()}>刷新页面</button></main> : this.props.children; }
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><SpaceBoundary><App/></SpaceBoundary></React.StrictMode>);
