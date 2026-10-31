import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Mic, Plus } from "lucide-react";
import SiriOrb from "@/components/smoothui/siri-orb";
import type { AIState } from "@/components/smoothui/ai-core";
import type { CardRecord } from "@/contracts";
import { buildDemoCards, type DemoCardKey } from "./demoCards";
import { CardFrame, ComposerText, EASE, fitScale, Stage, typeInto, useDemoActive, useElementSize, useSequence } from "./shared";

interface HeroScene { key: DemoCardKey; label: string; reply: string; scale: number }

/** What the hero plays: the sentence, the card it becomes, and what Vivic says back. */
const SCENES: HeroScene[] = [
  { key: "timer", label: "纯计时 · 只留数字", reply: "好的，开始 25 分钟倒计时。", scale: 1.7 },
  { key: "todo", label: "待办清单", reply: "已经列成今天的待办。", scale: 1.25 },
  { key: "countdown", label: "重要日期", reply: "记下了，距离生日还有 25 天。", scale: 1.3 },
  { key: "chart", label: "数据趋势", reply: "画成了折线图，周四最专注。", scale: 1.05 },
  { key: "goal", label: "目标进度", reply: "已完成 36%，还差 32 本。", scale: 1.15 },
];

type Phase = "standby" | "typing" | "thinking" | "answer" | "rest";

/**
 * Hero panel: a Display on the 午夜蓝紫 background. A sentence is typed into the
 * user-page input, the orb thinks at the top, the card appears and Vivic's
 * reply shows as a subtitle — then the orb leaves and only the card stays.
 */
export function HeroDisplay() {
  const ref = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const slotSize = useElementSize(slot);
  const { active, reduced } = useDemoActive(ref);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>(reduced ? "rest" : "standby");
  const [typed, setTyped] = useState("");
  const [card, setCard] = useState<CardRecord | null>(null);
  const [round, setRound] = useState(0);

  useSequence(active, async wait => {
    for (let i = 0; i < SCENES.length; i++) {
      const scene = SCENES[i]!;
      const demo = buildDemoCards()[scene.key];
      setIndex(i);
      setPhase(current => current === "standby" ? "standby" : "typing");
      setTyped("");
      await wait(i === 0 ? 900 : 500);
      setPhase("typing");
      await typeInto(demo.prompt, setTyped, wait, 42);
      await wait(380);
      setTyped("");
      setCard(null);
      setPhase("thinking");
      await wait(1300);
      // Fresh dates on every round, so the timer starts at 25:00 again.
      setCard(buildDemoCards()[scene.key].card);
      setRound(value => value + 1);
      setPhase("answer");
      await wait(2300);
      setPhase("rest");
      await wait(2200);
    }
  });

  const scene = SCENES[index]!;
  const shown = reduced ? buildDemoCards().todo.card : card;
  const orb = useMemo((): { top: string; scale: number; opacity: number; state: AIState } => {
    switch (phase) {
      case "standby": case "typing": return card ? { top: "3%", scale: 0.34, opacity: 0, state: "idle" } : { top: "27%", scale: 1, opacity: 1, state: phase === "typing" ? "listening" : "idle" };
      case "thinking": return { top: "3%", scale: 0.44, opacity: 1, state: "thinking" };
      case "answer": return { top: "3%", scale: 0.34, opacity: 1, state: "streaming" };
      case "rest": return { top: "3%", scale: 0.3, opacity: 0, state: "idle" };
    }
  }, [phase, card]);

  return <div ref={ref} className="lp-hero-display">
    <Stage palette="midnight" theme="dark" className="lp-hero-stage">
      <div className="lp-hero-topbar" aria-hidden="true">
        <span className="lp-glass-chip"><span className="lp-dot" />展示窗口</span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={scene.key} className="lp-glass-chip lp-scene-chip"
            initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.35 }}>
            {String(index + 1).padStart(2, "0")} / {String(SCENES.length).padStart(2, "0")} · {scene.label}
          </motion.span>
        </AnimatePresence>
      </div>

      <div className="lp-hero-orb-track" aria-hidden="true">
        <motion.div className="lp-hero-orb" initial={{ x: "-50%", top: orb.top, scale: orb.scale, opacity: orb.opacity }}
          animate={{ x: "-50%", top: orb.top, scale: orb.scale, opacity: orb.opacity }}
          transition={{ duration: 0.75, ease: EASE }}>
          <SiriOrb size="168px" state={orb.state} animationDuration={phase === "thinking" ? 10 : 22} />
        </motion.div>
      </div>

      <div ref={slot} className="lp-hero-card-slot">
        <AnimatePresence mode="wait">
          {shown && <motion.div key={`${shown.id}-${round}`} className="lp-hero-card"
            initial={reduced ? false : { opacity: 0, y: 24, scale: 0.9, filter: "blur(14px)" }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -16, scale: 0.96, filter: "blur(8px)" }}
            transition={{ duration: 0.7, ease: EASE }}>
            <div inert><CardFrame card={shown} scale={fitScale(shown, (reduced ? 1.2 : scene.scale) * Math.min(1.35, Math.max(0.8, slotSize.width / 700 || 1)), slotSize)} theme="dark" /></div>
          </motion.div>}
        </AnimatePresence>
      </div>

      <div className="lp-hero-subtitle" aria-hidden="true">
        <AnimatePresence mode="wait">
          {phase === "thinking" && <motion.p key="thinking" className="vivic-subtitle" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 0.8, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.28 }}>正在理解你的话…</motion.p>}
          {phase === "answer" && <motion.p key={`reply-${index}`} className="vivic-subtitle" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.28 }}>{scene.reply}</motion.p>}
        </AnimatePresence>
      </div>

      <div className="vivic-control-root lp-ui lp-hero-composer" data-appearance="dark" aria-hidden="true">
        <div className="vivic-composer-bar" data-typing={phase === "typing" || undefined}>
          <ComposerText text={typed} caret={phase === "typing"} />
          <span className="vivic-composer-icon"><Plus size={18} /></span>
          <span className="vivic-composer-icon"><Mic size={18} /></span>
          <span className={`vivic-composer-send${typed ? " is-ready" : ""}`}><ArrowUp size={18} /></span>
        </div>
      </div>
    </Stage>
  </div>;
}
