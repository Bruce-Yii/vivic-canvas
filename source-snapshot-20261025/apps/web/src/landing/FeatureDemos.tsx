import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, CircleHelp, MousePointerClick, ShieldCheck, X } from "lucide-react";
import SiriOrb from "@/components/smoothui/siri-orb";
import { ATMOSPHERE_PALETTES, DARK_PALETTE_IDS, LIGHT_PALETTE_IDS, type PaletteId } from "@/components/atmosphere/palettes";
import type { CardRecord } from "@/contracts";
import { buildDemoCards, type DemoCardKey } from "./demoCards";
import { CardFrame, EASE, fitScale, Stage, useDemoActive, useDemoCardState, useElementSize, useSequence } from "./shared";

const pop = { initial: { opacity: 0, y: 14, scale: 0.96 }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, y: -8, scale: 0.98 } };
const popCard = { initial: { opacity: 0, y: 22, scale: 0.92, filter: "blur(12px)" }, animate: { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }, exit: { opacity: 0, scale: 0.97, filter: "blur(6px)" } };

/* ------------------------------------------------------------------------ */
/* 1 · Chat: a sentence, the card it becomes, and a short reply.            */
/* ------------------------------------------------------------------------ */

const CHAT: Array<{ key: DemoCardKey; reply: string; scale: number }> = [
  { key: "compare", reply: "按月租、通勤和面积比好了，方案 B 更均衡。", scale: 0.9 },
  { key: "timeline", reply: "按时间排好了三件事。", scale: 0.86 },
  { key: "weather", reply: "上海 23°，多云。天气来自数据接口，不靠猜。", scale: 1.25 },
];

export function ChatDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  const { active, reduced } = useDemoActive(ref);
  const cards = useMemo(() => buildDemoCards(), []);
  const [index, setIndex] = useState(0);
  const [stage, setStage] = useState(reduced ? 3 : 0);

  useSequence(active, async wait => {
    for (let i = 0; i < CHAT.length; i++) {
      setIndex(i); setStage(0);
      await wait(450); setStage(1);
      await wait(900); setStage(2);
      await wait(1100); setStage(3);
      await wait(3600); setStage(0);
      await wait(500);
    }
  });

  const item = CHAT[index]!;
  const demo = cards[item.key];
  return <div ref={ref} className="lp-demo">
    <Stage palette="milk" theme="light" className="lp-feature-stage">
      <div className="vivic-control-root lp-ui lp-chat" data-appearance="light" aria-hidden="true">
        <AnimatePresence mode="popLayout">
          {stage >= 1 && <motion.div key={`q-${index}`} className="vivic-bubble vivic-bubble-user lp-chat-question" {...pop} transition={{ duration: 0.45, ease: EASE }}>{demo.prompt}</motion.div>}
          {stage === 2 && <motion.div key={`typing-${index}`} className="vivic-bubble vivic-bubble-assistant vivic-typing lp-chat-typing" {...pop} transition={{ duration: 0.3 }}><span /><span /><span /></motion.div>}
          {stage >= 3 && <motion.div key={`card-${index}`} className="lp-chat-card" {...popCard} transition={{ duration: 0.7, ease: EASE }}>
            <div inert><CardFrame card={demo.card} scale={fitScale(demo.card, item.scale, { width: size.width - 64, height: 420 })} /></div>
          </motion.div>}
          {stage >= 3 && <motion.div key={`a-${index}`} className="vivic-bubble vivic-bubble-assistant lp-chat-answer" {...pop} transition={{ duration: 0.45, delay: 0.45, ease: EASE }}>{item.reply}</motion.div>}
        </AnimatePresence>
      </div>
    </Stage>
  </div>;
}

/* ------------------------------------------------------------------------ */
/* 2 · Time: timers, reminders and dates slide past like on the Display.    */
/* ------------------------------------------------------------------------ */

const TIME: DemoCardKey[] = ["timer", "reminder", "countdown", "month", "notice"];
const SLOT = 300;
const SLOT_GAP = 26;

export function TimeDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const { active } = useDemoActive(ref);
  const cards = useMemo(() => buildDemoCards(), []);
  const [index, setIndex] = useState(0);
  const [instant, setInstant] = useState(false);
  const list = [...TIME, TIME[0]!];

  useSequence(active, async wait => {
    for (let i = 1; i <= TIME.length; i++) {
      await wait(2600);
      setInstant(false); setIndex(i);
    }
    await wait(900);
    setInstant(true); setIndex(0);
    await wait(60);
  });

  return <div ref={ref} className="lp-demo">
    <Stage palette="ember" theme="dark" className="lp-feature-stage">
      <motion.div className="lp-strip" aria-hidden="true" initial={false}
        animate={{ x: -index * (SLOT + SLOT_GAP) }}
        transition={instant ? { duration: 0 } : { duration: 0.9, ease: EASE }}>
        {list.map((key, i) => {
          const { card, prompt } = cards[key];
          const scale = Math.min(1, (SLOT - 10) / card.layout.width, 260 / card.layout.height) * (card.layout.width < 260 ? 1.12 : 1);
          return <div key={`${key}-${i}`} className="lp-strip-item" data-active={i === index || (index === TIME.length && i === 0) || undefined} style={{ width: SLOT }}>
            <div inert><CardFrame card={card} scale={scale} theme="dark" /></div>
            <p className="lp-strip-caption">“{prompt}”</p>
          </div>;
        })}
      </motion.div>
    </Stage>
  </div>;
}

/* ------------------------------------------------------------------------ */
/* 3 · Trust: what gets checked before a card is created.                   */
/* ------------------------------------------------------------------------ */

type CheckRow = { label: string; note: string; ok: boolean };
const TRUST: Array<{ prompt: string; rows: CheckRow[]; result: "card" | "ask"; ask?: string }> = [
  { prompt: "今年读书目标 50 本，已经读了 18 本", result: "card", rows: [
    { label: "目标 50 本", note: "出自你的原话", ok: true },
    { label: "已读 18 本", note: "出自你的原话", ok: true },
    { label: "截止 12 月 31 日", note: "“今年”按年底计算", ok: true },
    { label: "目标进度卡片", note: "字段与上限校验通过", ok: true },
  ] },
  { prompt: "帮我把体检加到这个月的月历上", result: "ask", ask: "体检是这个月几号？告诉我日期就加上。", rows: [
    { label: "事项「体检」", note: "出自你的原话", ok: true },
    { label: "日期", note: "原话里没有，不会替你猜", ok: false },
  ] },
];

export function TrustDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  const { active, reduced } = useDemoActive(ref);
  const cards = useMemo(() => buildDemoCards(), []);
  const [index, setIndex] = useState(0);
  const [checked, setChecked] = useState(reduced ? TRUST[0]!.rows.length : 0);
  const [done, setDone] = useState(reduced);

  useSequence(active, async wait => {
    for (let i = 0; i < TRUST.length; i++) {
      setIndex(i); setChecked(0); setDone(false);
      await wait(900);
      for (let r = 1; r <= TRUST[i]!.rows.length; r++) { setChecked(r); await wait(650); }
      await wait(300);
      setDone(true);
      await wait(3600);
    }
  });

  const item = TRUST[index]!;
  const passed = item.rows.slice(0, checked).filter(row => row.ok).length;
  return <div ref={ref} className="lp-demo">
    <Stage palette="berry" theme="light" className="lp-feature-stage">
      <div className="vivic-control-root lp-ui lp-trust" data-appearance="light" aria-hidden="true">
        <AnimatePresence mode="wait">
          <motion.div key={index} className="lp-trust-flow" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            <motion.div className="vivic-bubble vivic-bubble-user lp-chat-question" {...pop} transition={{ duration: 0.45, ease: EASE }}>{item.prompt}</motion.div>
            <div className="lp-trust-row">
              <motion.div className="vivic-card lp-check-card" {...pop} transition={{ duration: 0.5, delay: 0.25, ease: EASE }}>
                <section className="vivic-scene">
                  <header className="vivic-scene-head">
                    <span className="vivic-scene-kicker"><ShieldCheck size={13} strokeWidth={2.2} />生成前核对</span>
                    <span className="vivic-scene-badge" data-tone={checked === item.rows.length && passed < item.rows.length ? "caution" : "positive"}>{passed} / {item.rows.length} 通过</span>
                  </header>
                  <ul className="lp-check-list">
                    {item.rows.map((row, r) => <li key={row.label} data-state={r >= checked ? "pending" : row.ok ? "ok" : "miss"}>
                      <span className="lp-check-icon">{r >= checked ? null : row.ok ? <Check size={13} strokeWidth={2.6} /> : <X size={13} strokeWidth={2.6} />}</span>
                      <b>{row.label}</b><span>{row.note}</span>
                    </li>)}
                  </ul>
                </section>
              </motion.div>
              <AnimatePresence>
                {done && item.result === "card" && <motion.div className="lp-trust-result" {...popCard} transition={{ duration: 0.7, ease: EASE }}>
                  <div inert><CardFrame card={cards.goal.card} scale={size.width && size.width < 620 ? 0.62 : 0.78} /></div>
                </motion.div>}
              </AnimatePresence>
            </div>
            <AnimatePresence>
              {done && item.result === "ask" && <motion.div className="vivic-bubble vivic-bubble-assistant lp-chat-answer" {...pop} transition={{ duration: 0.45, ease: EASE }}>
                <CircleHelp size={14} className="lp-inline-icon" />{item.ask}
              </motion.div>}
            </AnimatePresence>
          </motion.div>
        </AnimatePresence>
      </div>
    </Stage>
  </div>;
}

/* ------------------------------------------------------------------------ */
/* 4 · Hands-on: real user-page cards, editable here, saved nowhere.        */
/* ------------------------------------------------------------------------ */

export function HandsOnDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  const cards = useMemo(() => buildDemoCards(), []);
  const [toast, setToast] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { cards: state, actions } = useDemoCardState([cards.todo.card, cards.goal.card], () => {
    setToast(value => value + 1);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(0), 2200);
  });
  const todo = state[cards.todo.card.id] as CardRecord;
  // A little wider than its Display size so the user-page controls sit on one line.
  const goal = { ...state[cards.goal.card.id], layout: { ...cards.goal.card.layout, width: 312 } } as CardRecord;
  // Side by side when the panel is wide enough (shrunk a little if needed), stacked on phones.
  const pair = todo.layout.width + goal.layout.width + 22;
  const scale = size.width >= 560 ? Math.min(1, (size.width - 64) / pair) : Math.min(1, (size.width - 40) / goal.layout.width || 1);
  return <div ref={ref} className="lp-demo">
    <Stage palette="peach" theme="light" className="lp-feature-stage lp-hands">
      <div className="lp-hands-cards" data-stacked={size.width < 560 || undefined}>
        <div className="lp-hands-todo"><CardFrame card={todo} mode="control" actions={actions} scale={scale} /></div>
        <div className="lp-hands-goal"><CardFrame card={goal} mode="control" actions={actions} scale={scale} /></div>
      </div>
      <div className="lp-hands-hint"><MousePointerClick size={14} aria-hidden />试试勾选、调整进度 · 本页修改不会保存</div>
      <div className="vivic-control-root lp-ui lp-hands-toast-wrap" data-appearance="light" aria-live="polite">
        <AnimatePresence>
          {toast > 0 && <motion.div key="toast" className="vivic-composer-progress" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}>
            <Check size={14} aria-hidden />已重新校验，会同步到展示窗口
          </motion.div>}
        </AnimatePresence>
      </div>
    </Stage>
  </div>;
}

/* ------------------------------------------------------------------------ */
/* 5 · Ambience: the twelve real palettes of the 流光以太 background.        */
/* ------------------------------------------------------------------------ */

const AUTO_PALETTES: PaletteId[] = ["midnight", "milk", "ember", "peach", "ocean", "lilac"];

export function AmbienceDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const { active } = useDemoActive(ref);
  const cards = useMemo(() => buildDemoCards(), []);
  const [palette, setPalette] = useState<PaletteId>("midnight");
  const [manual, setManual] = useState(false);
  const theme = (DARK_PALETTE_IDS as readonly string[]).includes(palette) ? "dark" : "light";

  useSequence(active && !manual, async wait => {
    for (const id of AUTO_PALETTES) { setPalette(id); await wait(3400); }
  });

  const swatches = (ids: readonly PaletteId[], label: string) => <div className="lp-swatch-group" role="radiogroup" aria-label={label}>
    <span className="lp-swatch-label">{label}</span>
    {ids.map(id => {
      const [a, b, c] = ATMOSPHERE_PALETTES[id].swatch;
      return <button key={id} type="button" role="radio" aria-checked={palette === id} aria-label={ATMOSPHERE_PALETTES[id].name} title={ATMOSPHERE_PALETTES[id].name}
        className="lp-swatch" style={{ background: `conic-gradient(from 200deg, ${a}, ${b}, ${c}, ${a})` }}
        onClick={() => { setManual(true); setPalette(id); }} />;
    })}
  </div>;

  return <div ref={ref} className="lp-demo">
    <Stage palette={palette} theme={theme} className="lp-feature-stage lp-ambience">
      <div className="lp-ambience-center" aria-hidden="true">
        <SiriOrb size="128px" animationDuration={22} />
        <div inert><CardFrame card={cards.timer.card} scale={1.3} theme={theme} /></div>
      </div>
      <div className="lp-ambience-picker" data-theme={theme}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={palette} className="lp-ambience-name" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.25 }}>
            {ATMOSPHERE_PALETTES[palette].name}
          </motion.span>
        </AnimatePresence>
        <div className="lp-swatch-rows">
          {swatches(DARK_PALETTE_IDS, "深色")}
          {swatches(LIGHT_PALETTE_IDS, "浅色")}
        </div>
      </div>
    </Stage>
  </div>;
}
