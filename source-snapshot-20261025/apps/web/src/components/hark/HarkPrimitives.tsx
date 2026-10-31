import { useLayoutEffect, useRef, type CSSProperties, type HTMLAttributes, type ReactNode, type SVGProps, type Ref } from "react";
import { continuousPath } from "./corner-path.mjs";
import glyphs from "./glyphs.json";
import "./hark.css";

// D semantic mapping. Values resolve to original Hark glyph paths, never redrawn.
const aliases: Record<string, keyof typeof glyphs> = {
  settings: "gear", "settings-2": "gear", "arrow-up-right": "link-out", "arrow-down-to-line": "download",
  "arrow-left": "back", "arrow-right": "next", "arrow-up": "up", "arrow-down": "down", arrowup: "up", send: "up",
  "chevron-down": "down", "chevron-up": "up", "chevron-right": "chevron", "chevron-left": "back",
  "circle-alert": "alert", "circle-check": "check", "check-check": "check", "check-circle-2": "check",
  cpu: "memory", monitor: "computer", smartphone: "computer", database: "memory", palette: "eye", cable: "link",
  blocks: "apps", sparkles: "research", "file-text": "file", "layout-dashboard": "apps", workflow: "research",
  "refresh-cw": "refresh", square: "stop", "list-checks": "list", "calendar-days": "calendar", "shopping-bag": "folder",
  "chart-no-axes-combined": "research", document: "file", bag: "folder", chart: "research", spark: "research",
  "loader-circle": "refresh", loader: "refresh", plus: "add", x: "close", pencil: "edit", undo: "back", "undo-2": "back",
  "rotate-ccw": "refresh", "rotate-cw": "refresh", user: "person", "user-round": "person", help: "info", "help-circle": "info",
  "qr-code": "card", "scan-line": "expand", scan: "expand", "camera": "photo", "camera-off": "photo",
  "history": "schedule", "clock": "schedule", "clock-3": "schedule", "message-circle": "chat", "message-square": "chat",
  "arrow-right-left": "share", "move-up-right": "link-out", "external-link": "link-out", "log-out": "sign-out",
  "shield-check": "security", "shield": "security", "wifi": "web", "wifi-off": "web", "link-2": "link", "unlink": "close",
  "volume-2": "volume", "volume-x": "volume", "mic-off": "mic", "trash-2": "trash", "save": "download",
  "check-circle": "check", "circle": "dot", "circle-dot": "point", "circle-help": "info", "menu": "list", "search-x": "search",
  "panel-left": "sidebar", "panel-left-close": "sidebar", "panel-left-open": "sidebar", "keyboard": "keyboard",
};

export type HarkIconProps = Omit<SVGProps<SVGSVGElement>, "name"> & { name: string; size?: number; strokeWidth?: number };
export function HarkIcon({ name, size = 16, strokeWidth: _strokeWidth, ...props }: HarkIconProps) {
  const key = (name in glyphs ? name : aliases[name] ?? "apps") as keyof typeof glyphs;
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"
    data-glyph={key} data-hark-icon={name} {...props} dangerouslySetInnerHTML={{ __html: glyphs[key].replace(/>\s+</g, "><") }} />;
}

type SurfaceStyle = CSSProperties & { [key: `--${string}`]: string | number | undefined };
export interface HarkSurfaceProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode;
  as?: "article" | "section" | "div";
  style?: SurfaceStyle;
  ref?: Ref<HTMLElement>;
}

/** Original continuous-corner geometry and separate fill/stroke; D React/observer host.
 * Only decorative layers are clipped, so card tools and focus rings remain visible.
 */
export function HarkSurface({ children, as: Tag = "article", className = "", ref: forwardedRef, ...props }: HarkSurfaceProps) {
  const host = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const fill = el.querySelector<HTMLElement>(":scope > .hark-surface-fill");
    const stroke = el.querySelector<HTMLElement>(":scope > .hark-surface-stroke");
    if (!fill || !stroke) return;
    const update = (entry?: ResizeObserverEntry) => {
      // Layout border box, independent of React Flow's ancestor zoom transform.
      const box = entry?.borderBoxSize?.[0];
      const width = box?.inlineSize ?? el.offsetWidth, height = box?.blockSize ?? el.offsetHeight;
      const radius = parseFloat(getComputedStyle(el).getPropertyValue("--surface-radius")) || 24;
      const outer = continuousPath(width, height, radius);
      if (!outer) return;
      const inner = continuousPath(width - 2, height - 2, Math.max(0, radius - 1), 1);
      fill.style.clipPath = `path("${outer}")`;
      stroke.style.clipPath = `path(evenodd,"${outer} ${inner}")`;
      el.dataset.harkCorner = "continuous";
    };
    const onScroll = () => { fill.style.translate = stroke.style.translate = `${el.scrollLeft}px ${el.scrollTop}px`; };
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(entries => update(entries[0])) : null;
    observer?.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { observer?.disconnect(); el.removeEventListener("scroll", onScroll); };
  }, []);
  return <Tag ref={node => { host.current = node; if (typeof forwardedRef === "function") forwardedRef(node); else if (forwardedRef) forwardedRef.current = node; }} className={`hark-surface ${className}`} {...props}>
    <span className="hark-surface-fill" aria-hidden="true" /><span className="hark-surface-stroke" aria-hidden="true" />{children}
  </Tag>;
}

export function HarkTabs<T extends string>({ label, value, tabs, onChange }: {
  label: string; value: T; tabs: readonly { id: T; label: string }[]; onChange(value: T): void;
}) {
  return <nav className="hark-tabs" aria-label={label}>{tabs.map(tab => <button key={tab.id} type="button"
    aria-current={value === tab.id ? "page" : undefined} onClick={() => onChange(tab.id)}>{tab.label}</button>)}</nav>;
}

export function HarkTaskCard({ template, onSelect, actionLabel, disabled = false }: {
  template: readonly string[]; onSelect(): void; actionLabel?: string; disabled?: boolean;
}) {
  const [title, description, icon] = template;
  return <HarkSurface className="hark-task-card" data-hark-task={title}>
    <span className="hark-task-mark"><HarkIcon name={icon ?? "file"} size={20} /></span>
    <div className="hark-task-copy"><h3>{title}</h3><p>{description}</p></div>
    <button className="hark-icon-button" type="button" disabled={disabled} aria-label={actionLabel ?? `使用模板：${title}`} onClick={onSelect}><HarkIcon name="add" /></button>
  </HarkSurface>;
}

/** Source shader snapshots with frozen D scene inputs. No GPU, geolocation or network work at runtime. */
export function HarkBackdrop({ className = "", theme }: { className?: string; theme?: "light" | "dark" }) {
  return <div className={`hark-backdrop ${className}`} data-hark-sky="source-shader-frozen" data-theme={theme} aria-hidden="true" />;
}
