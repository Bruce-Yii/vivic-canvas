import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { motion, useReducedMotion, useScroll, useTransform, type MotionValue } from "motion/react";
import { CardRecordSchema, type CardRecord } from "@/contracts";
import { VivicCard } from "@/cards/VivicCard";
import { fixedContentHeight } from "@/cards/sizing";
import { CardActionsContext, CardModeContext, type CardActions, type CardMode } from "@/cards/scene/cardContext";
import { SubcardThemeContext } from "@/cards/SubcardEditorContext";
import { AtmosphereBackground } from "@/components/atmosphere/AtmosphereBackground";
import type { PaletteId } from "@/components/atmosphere/palettes";

export const EASE = [0.2, 0.8, 0.2, 1] as const;

/** True while the element is on (or near) the screen. */
export function useInViewport<T extends Element>(ref: RefObject<T | null>, rootMargin = "160px"): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { rootMargin });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, rootMargin]);
  return visible;
}

/** Live content-box size of an element (0×0 until measured). */
export function useElementSize<T extends HTMLElement>(ref: RefObject<T | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize(prev => prev.width === el.clientWidth && prev.height === el.clientHeight ? prev : { width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** Largest scale ≤ `preferred` at which a card still fits the given box. */
export const fitScale = (card: CardRecord, preferred: number, box: { width: number; height: number }) =>
  box.width <= 0 || box.height <= 0 ? preferred
    : Math.max(0.4, Math.min(preferred, box.width / card.layout.width, box.height / card.layout.height));

/** The single-line text of the composer; long input scrolls so the caret stays in view, like the real input. */
export function ComposerText({ text, placeholder = "给 Vivic 发消息", caret }: { text: string; placeholder?: string; caret?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => { if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth; }, [text]);
  return <span ref={ref} className={`lp-composer-text${text ? "" : " is-placeholder"}`}>{text || placeholder}{caret && <i className="lp-caret" />}</span>;
}

/** False while the tab is in the background, so demos and shaders rest. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/** A demo plays only when it is on screen, the tab is visible and motion is allowed. */
export function useDemoActive<T extends Element>(ref: RefObject<T | null>): { active: boolean; reduced: boolean } {
  const reduced = Boolean(useReducedMotion());
  const inView = useInViewport(ref, "0px");
  const pageVisible = usePageVisible();
  return { active: inView && pageVisible && !reduced, reduced };
}

const CANCELLED = Symbol("cancelled");

/**
 * Runs `script` in a loop. `wait(ms)` only counts time while `active`, so a
 * demo scrolled out of view pauses mid-step and resumes where it left off.
 */
export function useSequence(active: boolean, script: (wait: (ms: number) => Promise<void>) => Promise<void>) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const scriptRef = useRef(script);
  scriptRef.current = script;
  useEffect(() => {
    let cancelled = false;
    const wait = (ms: number) => new Promise<void>((resolve, reject) => {
      let left = ms;
      let last = performance.now();
      const tick = () => {
        if (cancelled) { reject(CANCELLED); return; }
        const now = performance.now();
        if (activeRef.current) left -= now - last;
        last = now;
        if (left <= 0) resolve();
        else setTimeout(tick, Math.min(left, 90));
      };
      setTimeout(tick, Math.min(ms, 90));
    });
    void (async () => {
      try { for (;;) await scriptRef.current(wait); } catch (error) { if (error !== CANCELLED) throw error; }
    })();
    return () => { cancelled = true; };
  }, []);
}

/** Types `text` into a setter, one character at a time. */
export async function typeInto(text: string, set: (value: string) => void, wait: (ms: number) => Promise<void>, speed = 34) {
  for (let i = 1; i <= text.length; i++) { set(text.slice(0, i)); await wait(speed); }
}

/**
 * A rounded panel over the shared 流光以太 background — the same component the
 * Display and the user page use. The shader rests when the panel is off screen.
 */
export function Stage({ palette, theme, className, children, label }: {
  palette: PaletteId; theme: "light" | "dark"; className?: string; children?: ReactNode; label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInViewport(ref, "80px");
  const pageVisible = usePageVisible();
  const reduced = Boolean(useReducedMotion());
  return <div ref={ref} className={`lp-stage${className ? ` ${className}` : ""}`} data-theme={theme} data-palette={palette} role={label ? "img" : undefined} aria-label={label}>
    <AtmosphereBackground theme={theme} palette={palette} paused={!inView || !pageVisible || reduced} className="lp-stage-bg" />
    <div className={`lp-stage-content${theme === "dark" ? " dark" : ""}`}>{children}</div>
  </div>;
}

/** In-memory edits for user-page cards on the landing: same schema gate, nothing saved. */
export function useDemoCardState(initial: CardRecord[], onChange?: (card: CardRecord) => void) {
  const [cards, setCards] = useState<Record<string, CardRecord>>(() => Object.fromEntries(initial.map(card => [card.id, card])));
  const latest = useRef(cards);
  latest.current = cards;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const actions = useMemo<CardActions>(() => ({
    editable: true,
    update: (cardId, patch) => {
      const current = latest.current[cardId];
      if (!current) return false;
      const parsed = CardRecordSchema.safeParse({ ...current,
        displayProps: { ...current.displayProps, ...patch.displayProps },
        sourceData: { ...current.sourceData, ...patch.sourceData },
        metadata: { ...current.metadata, updatedAt: new Date().toISOString() } });
      if (!parsed.success) return false;
      latest.current = { ...latest.current, [cardId]: parsed.data };
      setCards(latest.current);
      onChangeRef.current?.(parsed.data);
      return true;
    },
  }), []);
  return { cards, actions, setCards };
}

/**
 * One real card, as the Display ("display") or the user page ("control")
 * renders it. `scale` shrinks the whole card visually while the layout box
 * follows, so cards of different sizes can sit side by side.
 */
export function CardFrame({ card, mode = "display", scale = 1, actions, theme = "light", className }: {
  card: CardRecord; mode?: CardMode; scale?: number; actions?: CardActions; theme?: "light" | "dark"; className?: string;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const width = card.layout.width;
  const body = <SubcardThemeContext.Provider value={theme}>
    <CardModeContext.Provider value={mode}>
      <CardActionsContext.Provider value={mode === "control" ? actions ?? null : null}>
        <VivicCard record={card} height={mode === "display" ? fixedContentHeight(card) : undefined} />
      </CardActionsContext.Provider>
    </CardModeContext.Provider>
  </SubcardThemeContext.Provider>;
  return <div className={`lp-card-frame${className ? ` ${className}` : ""}`} data-card-type={card.type}
    style={{ width: (size?.w ?? width) * scale, height: size ? size.h * scale : undefined }}>
    <div ref={inner} className={mode === "control" ? "vivic-user-card lp-user-card" : "vivic-card lp-display-card"}
      style={{ width, transform: scale === 1 ? undefined : `scale(${scale})`, transformOrigin: "top left" }}>
      {body}
    </div>
  </div>;
}

/** Fades content up as it scrolls into view (once). */
export function Reveal({ children, className, delay = 0, y = 26, as = "div" }: {
  children: ReactNode; className?: string; delay?: number; y?: number; as?: "div" | "p" | "h2" | "li";
}) {
  const reduced = useReducedMotion();
  const Component = motion[as];
  return <Component className={className}
    initial={reduced ? false : { opacity: 0, y }}
    whileInView={{ opacity: 1, y: 0 }}
    viewport={{ once: true, margin: "0px 0px -12% 0px" }}
    transition={{ duration: 0.8, ease: EASE, delay }}>
    {children}
  </Component>;
}

function InkChar({ char, progress, from, to }: { char: string; progress: MotionValue<number>; from: number; to: number }) {
  const opacity = useTransform(progress, [from, to], [0.14, 1]);
  return <motion.span style={{ opacity }}>{char}</motion.span>;
}

/**
 * Large statement whose characters fill in with ink as it scrolls through the
 * middle of the screen. Lines are separated with "\n".
 */
export function InkText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 88%", "end 45%"] });
  const total = text.replace(/\n/g, "").length;
  let index = 0;
  return <h2 ref={ref} className={className} aria-label={text.replace(/\n/g, "")}>
    {text.split("\n").map((line, l) => <span key={l} className="lp-ink-line" aria-hidden="true">
      {Array.from(line).map((char, c) => {
        const i = index++;
        return reduced ? <span key={c}>{char}</span>
          : <InkChar key={c} char={char} progress={scrollYProgress} from={(i / total) * 0.75} to={(i / total) * 0.75 + 0.25} />;
      })}
    </span>)}
  </h2>;
}

export function Wordmark({ beta = false, className }: { beta?: boolean; className?: string }) {
  return <span className={`lp-wordmark${className ? ` ${className}` : ""}`}>
    vivic{beta && <em> beta</em>}
  </span>;
}
