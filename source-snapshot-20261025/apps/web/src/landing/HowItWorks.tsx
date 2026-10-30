import { useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { ArrowUp, LoaderCircle, Mic, Plus } from "lucide-react";
import SiriOrb from "@/components/smoothui/siri-orb";
import type { CardRecord } from "@/contracts";
import { buildDemoCards } from "./demoCards";
import { CardFrame, ComposerText, EASE, fitScale, Stage, typeInto, useDemoActive, useDemoCardState, useElementSize, useSequence } from "./shared";

const STEPS = [
  { title: "说出来", text: "在用户页打字或按住说话", ms: 4200 },
  { title: "看得见", text: "卡片出现在展示窗口", ms: 4200 },
  { title: "随手改", text: "拖到用户页操作，再放回去", ms: 5600 },
] as const;

type TodoPlace = "display" | "user";

/**
 * The two surfaces side by side: the user page (input) and the Display
 * (cards only). A sentence becomes a weekly schedule on the Display; the to-do
 * card is dragged to the user page, ticked there, and goes back.
 */
export function HowItWorks() {
  const ref = useRef<HTMLDivElement>(null);
  const displayBody = useRef<HTMLDivElement>(null);
  const userBody = useRef<HTMLDivElement>(null);
  const displaySize = useElementSize(displayBody);
  const userSize = useElementSize(userBody);
  const { active, reduced } = useDemoActive(ref);
  const demo = useMemo(() => buildDemoCards(), []);
  const todoId = demo.todo.card.id;
  const pristineTodo = useMemo(() => {
    const card = demo.todo.card as Extract<CardRecord, { type: "TodoCard" }>;
    return { ...card, displayProps: { ...card.displayProps, items: card.displayProps.items.map(item => ({ ...item, done: item.id === "t1" })) } };
  }, [demo]);
  const { cards, actions, setCards } = useDemoCardState([pristineTodo]);
  const todo = cards[todoId]!;

  const [step, setStep] = useState(reduced ? 2 : 0);
  const [loop, setLoop] = useState(0);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [orb, setOrb] = useState<"off" | "thinking" | "streaming">("off");
  const [subtitle, setSubtitle] = useState<string | null>(null);
  const [week, setWeek] = useState(reduced);
  const [place, setPlace] = useState<TodoPlace>(reduced ? "user" : "display");
  const [synced, setSynced] = useState(false);

  useSequence(active, async wait => {
    // 1 · 说出来
    setCards({ [todoId]: pristineTodo });
    setWeek(false); setPlace("display"); setSynced(false); setSubtitle(null); setOrb("off");
    setStep(0); setLoop(value => value + 1);
    await wait(500);
    const prompt = demo.week.prompt;
    await typeInto(prompt, setTyped, wait, 2400 / prompt.length);
    await wait(300);
    setTyped(""); setBusy(true);
    await wait(1000);
    // 2 · 看得见
    setStep(1);
    setOrb("thinking");
    await wait(1200);
    setBusy(false); setWeek(true); setOrb("streaming"); setSubtitle("已整理成下周安排。");
    await wait(2200);
    setOrb("off"); setSubtitle(null);
    await wait(800);
    // 3 · 随手改
    setStep(2);
    setPlace("user");
    await wait(1200);
    actions.update(todoId, { displayProps: { items: pristineTodo.displayProps.items.map(item => item.id === "t2" ? { ...item, done: true } : item) } });
    setSynced(true);
    await wait(2000);
    setPlace("display"); setSynced(false);
    await wait(2400);
  });

  const weekScale = fitScale(demo.week.card, 0.66, { width: displaySize.width - 28, height: (displaySize.height - 90) * 0.62 });
  const todoFrame = (mode: "display" | "control", scale: number) => <motion.div key={`todo-${mode}`} layoutId={reduced ? undefined : "lp-how-todo"} className="lp-how-card"
    transition={{ duration: 0.8, ease: EASE }}>
    {mode === "display"
      ? <div inert><CardFrame card={todo} scale={scale} theme="dark" /></div>
      : <CardFrame card={todo} mode="control" actions={actions} scale={scale} theme="dark" />}
  </motion.div>;

  return <div ref={ref} className="lp-how">
    <Stage palette="ocean" theme="dark" className="lp-how-stage">
      <div className="lp-how-title">
        <span className="lp-how-title-orb" aria-hidden="true"><SiriOrb size="34px" animationDuration={18} /></span>
        <span><strong>Vivic 是怎么工作的</strong><small>用户页负责说，展示窗口负责看</small></span>
      </div>
      <LayoutGroup>
        <div className="lp-how-windows">
          <section className="lp-window lp-window-user" aria-label="用户页示例">
            <div className="lp-window-bar"><i /><i /><i /><span>用户页</span></div>
            <div ref={userBody} className="lp-window-body">
              <div className="lp-window-cards">
                <AnimatePresence>{place === "user" && todoFrame("control", fitScale(todo, 0.86, { width: userSize.width - 28, height: userSize.height - 110 }))}</AnimatePresence>
              </div>
              <div className="vivic-control-root lp-ui" data-appearance="dark">
                <AnimatePresence>
                  {(busy || synced) && <motion.div className="vivic-composer-progress lp-how-status" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                    {busy ? <><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />正在理解并安排你的指令</> : <>已校验，展示窗口同步更新</>}
                  </motion.div>}
                </AnimatePresence>
                <div className="vivic-composer-bar lp-how-composer" aria-hidden="true">
                  <ComposerText text={typed} caret={step === 0 && !busy} />
                  <span className="vivic-composer-icon"><Plus size={16} /></span>
                  <span className="vivic-composer-icon"><Mic size={16} /></span>
                  <span className={`vivic-composer-send${typed ? " is-ready" : ""}`}><ArrowUp size={16} /></span>
                </div>
              </div>
            </div>
          </section>

          <div className="lp-how-link" aria-hidden="true"><span /></div>

          <section className="lp-window lp-window-display" aria-label="展示窗口示例">
            <div className="lp-window-bar"><i /><i /><i /><span>展示窗口 · 副屏</span></div>
            <div ref={displayBody} className="lp-window-body">
              <AnimatePresence>
                {orb !== "off" && <motion.div className="lp-how-orb" aria-hidden="true" initial={{ opacity: 0, scale: 0.8, x: "-50%" }} animate={{ opacity: 1, scale: 1, x: "-50%" }} exit={{ opacity: 0, scale: 1.3, x: "-50%" }} transition={{ duration: 0.4 }}>
                  <SiriOrb size="54px" state={orb} animationDuration={orb === "thinking" ? 10 : 20} />
                </motion.div>}
              </AnimatePresence>
              <div className="lp-window-cards lp-display-cards">
                <AnimatePresence mode="popLayout">
                  {week && <motion.div key="week" layout className="lp-how-card" initial={{ opacity: 0, scale: 0.92, filter: "blur(12px)" }} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.7, ease: EASE }}>
                    <div inert><CardFrame card={demo.week.card} scale={weekScale} theme="dark" /></div>
                  </motion.div>}
                  {place === "display" && todoFrame("display", Math.min(0.72, weekScale * 1.1))}
                </AnimatePresence>
              </div>
              <AnimatePresence>
                {subtitle && <motion.p className="vivic-subtitle lp-how-subtitle" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>{subtitle}</motion.p>}
              </AnimatePresence>
            </div>
          </section>
        </div>
      </LayoutGroup>
      <ol className="lp-how-steps">
        {STEPS.map((item, i) => <li key={item.title} data-state={i < step ? "done" : i === step ? "current" : "next"}>
          <span className="lp-how-bar"><i key={`${loop}-${step}`} style={{ animationDuration: `${item.ms}ms`, animationPlayState: active ? "running" : "paused" }} /></span>
          <strong>{String(i + 1).padStart(2, "0")} {item.title}</strong>
          <small>{item.text}</small>
        </li>)}
      </ol>
    </Stage>
  </div>;
}
