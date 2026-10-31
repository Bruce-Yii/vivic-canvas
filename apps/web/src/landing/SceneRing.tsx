import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { Pause, Play } from "lucide-react";
import { buildDemoCards, RING_ORDER } from "./demoCards";
import { CardFrame, useInViewport, usePageVisible } from "./shared";

const CARD_MAX_H = 300;
const CARD_MAX_W = 430;
/** Phones get smaller cards so a wide card never spans the whole screen. */
const compactLimits = () => typeof window !== "undefined" && window.innerWidth < 640
  ? { h: 250, w: Math.min(CARD_MAX_W, window.innerWidth - 70) } : { h: CARD_MAX_H, w: CARD_MAX_W };
const GAP = 56;
const SPEED = 34; // px per second
const MAX_TILT = 24; // degrees at the edge of the screen

/**
 * The curved scene ring (after Hark's carousel): every scene card the
 * product can draw, each over the sentence that produces it. It drifts on
 * its own, can be dragged, and bends away at the edges like the inside of a
 * cylinder. Positions are written straight to the DOM every frame.
 */
export function SceneRing() {
  const items = useMemo(() => {
    const cards = buildDemoCards();
    const limit = compactLimits();
    return RING_ORDER.map(key => {
      const { card, prompt } = cards[key];
      const scale = Math.min(1, limit.h / card.layout.height, limit.w / card.layout.width);
      return { key, card, prompt, scale };
    });
  }, []);
  const viewport = useRef<HTMLDivElement>(null);
  const nodes = useRef<Array<HTMLElement | null>>([]);
  const reduced = Boolean(useReducedMotion());
  const inView = useInViewport(viewport, "120px");
  const pageVisible = usePageVisible();
  const [paused, setPaused] = useState(false);
  const state = useRef({ offset: 0, velocity: 0, dragging: false, hover: false, lastX: 0, lastT: 0, moved: 0, widths: [] as number[] });

  useLayoutEffect(() => {
    const measure = () => { state.current.widths = nodes.current.map(node => node?.offsetWidth ?? 0); };
    measure();
    const observer = new ResizeObserver(measure);
    nodes.current.forEach(node => node && observer.observe(node));
    return () => observer.disconnect();
  }, []);

  const running = inView && pageVisible;
  const drift = !reduced && !paused;
  const driftRef = useRef(drift);
  driftRef.current = drift;

  useEffect(() => {
    if (!running) return;
    let frame = 0;
    let last = performance.now();
    const render = (now: number) => {
      const s = state.current;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!s.dragging) {
        if (Math.abs(s.velocity) > 4) { s.offset += s.velocity * dt; s.velocity *= Math.pow(0.04, dt); }
        else { s.velocity = 0; if (driftRef.current && !s.hover) s.offset += SPEED * dt; }
      }
      const vw = viewport.current?.clientWidth ?? window.innerWidth;
      const widths = s.widths;
      const total = widths.reduce((sum, w) => sum + w + GAP, 0);
      if (total > 0) {
        let base = 0;
        widths.forEach((w, i) => {
          const node = nodes.current[i];
          if (!node) return;
          const raw = base + w / 2 - s.offset;
          base += w + GAP;
          const c = ((((raw - total / 2) % total) + total) % total) - total / 2;
          const half = vw / 2;
          const visible = Math.abs(c) < half + w;
          node.style.visibility = visible ? "visible" : "hidden";
          if (!visible) return;
          const d = Math.max(-1.35, Math.min(1.35, c / half));
          const tilt = reduced ? 0 : -d * MAX_TILT;
          const depth = reduced ? 0 : Math.abs(d) * 70;
          node.style.transform = `translate3d(${half + c - w / 2}px, -50%, ${depth}px) rotateY(${tilt}deg)`;
          node.style.opacity = String(Math.max(0, Math.min(1, 1.55 - Math.abs(d) * 0.55)));
        });
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [running, reduced]);

  const onPointerDown = (event: React.PointerEvent) => {
    const s = state.current;
    s.dragging = true; s.velocity = 0; s.lastX = event.clientX; s.lastT = performance.now(); s.moved = 0;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const s = state.current;
    if (!s.dragging) return;
    const now = performance.now();
    const dx = event.clientX - s.lastX;
    s.offset -= dx;
    s.moved += Math.abs(dx);
    s.velocity = -dx / Math.max(0.008, (now - s.lastT) / 1000);
    s.lastX = event.clientX; s.lastT = now;
  };
  const onPointerUp = () => { state.current.dragging = false; };
  const nudge = (direction: 1 | -1) => { state.current.velocity = direction * 900; };

  return <div className="lp-ring-wrap">
    <div ref={viewport} className="lp-ring" role="region" aria-roledescription="轮播" aria-label="场景卡片示例，可左右拖动"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onPointerEnter={() => { state.current.hover = true; }} onPointerLeave={() => { state.current.hover = false; state.current.dragging = false; }}
      onKeyDown={event => { if (event.key === "ArrowRight") nudge(1); if (event.key === "ArrowLeft") nudge(-1); }} tabIndex={0}>
      {items.map((item, i) => <figure key={item.key} ref={node => { nodes.current[i] = node; }} className="lp-ring-item" style={{ visibility: "hidden" }}>
        <div className="lp-ring-card" inert><CardFrame card={item.card} scale={item.scale} /></div>
        <figcaption className="lp-ring-bubble">{item.prompt}</figcaption>
      </figure>)}
    </div>
    <div className="lp-ring-controls">
      <button type="button" className="lp-icon-button" onClick={() => nudge(-1)} aria-label="上一组">‹</button>
      {!reduced && <button type="button" className="lp-icon-button" onClick={() => setPaused(value => !value)} aria-pressed={paused} aria-label={paused ? "继续滚动" : "暂停滚动"}>
        {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
      </button>}
      <button type="button" className="lp-icon-button" onClick={() => nudge(1)} aria-label="下一组">›</button>
    </div>
  </div>;
}
