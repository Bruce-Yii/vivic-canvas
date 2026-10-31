import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import { motion, useReducedMotion } from "motion/react";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import { SubcardThemeContext } from "../SubcardEditorContext";
import { ControlOverlayContext } from "@/control/ControlOverlayContext";

/**
 * Shared browse helpers for the reading cards (paper, news, quote, book,
 * link, notification, comparison): a "详情" popover, safe external links,
 * a copy button with inline status, a segmented control and a measuring hook
 * that lets fixed-height Display cards clamp to whole lines.
 */

export const hostnameOf = (url: string): string => {
  try { return new URL(url).hostname.replace(/^www\./i, "") || url; } catch { return url; }
};

const isHttps = (href: string) => /^https:\/\/[^\s<>"']+$/i.test(href);

/** Link built only from validated card data; anything that is not https renders as plain text. */
export function SceneLink({ href, children, className, label }: { href: string; children: ReactNode; className?: string; label?: string }) {
  if (!isHttps(href)) return <span className={`vivic-scene-muted min-w-0 ${className ?? ""}`}>{children}</span>;
  return <a className={`vivic-scene-link nodrag nopan min-w-0 max-w-full ${className ?? ""}`} href={href} target="_blank" rel="noopener noreferrer" aria-label={label} data-scene-link>
    <span className="min-w-0 truncate">{children}</span><HarkIcon name="link-out" size={12} aria-hidden className="shrink-0" />
  </a>;
}

/** Labelled block inside a details popover. */
export function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return <section className="grid min-w-0 gap-1" data-detail-field={label}>
    <h4 className="m-0 text-[11px] font-semibold tracking-[0.08em] text-[var(--vivic-muted-ink)]">{label}</h4>
    <div className="min-w-0 [overflow-wrap:anywhere]">{children}</div>
  </section>;
}

/**
 * "详情" trigger + portal popover. A browse interaction, so it exists on the
 * Display too; the portal copies the canvas theme the way subcards do.
 */
export function DetailPopover({ heading, children, label = "详情", triggerLabel }: {
  heading: string; children: ReactNode; label?: string; triggerLabel?: string;
}) {
  const longHeading = heading.length > 80;
  const theme = useContext(SubcardThemeContext);
  const overlayHost = useContext(ControlOverlayContext);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const reduced = useReducedMotion();
  return <Popover.Root open={open} onOpenChange={value => {
    if (value) setDark(theme === "dark" || Boolean(trigger.current?.closest(".dark")));
    setOpen(value);
  }}>
    <Popover.Trigger asChild>
      <button ref={trigger} type="button" className="vivic-scene-action nodrag nopan" aria-label={triggerLabel} data-scene-detail-trigger>
        <HarkIcon name="expand" size={13} aria-hidden />{label}
      </button>
    </Popover.Trigger>
    <Popover.Portal container={overlayHost ?? undefined}>
      <Popover.Content side="bottom" align="end" sideOffset={8} collisionPadding={12} hideWhenDetached
        className={`${dark ? "dark " : ""}vh-hark vivic-subcard-popover nodrag nopan nowheel flex flex-col overflow-hidden`} data-appearance={dark ? "dark" : "light"} data-scene-detail-popover>
        {/* Bounded column: the heading stays put (clamped), everything else scrolls inside the popover. */}
        <motion.div className="flex min-h-0 flex-1 flex-col" initial={{ opacity: 0, y: reduced ? 0 : 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduced ? 0 : 0.16 }}>
          <div className="flex shrink-0 items-start justify-between gap-3">
            <div className="vivic-scene-clamp-3 min-w-0 text-[15px] font-semibold leading-snug" title={longHeading ? heading : undefined} data-scene-detail-heading>{heading}</div>
            <Popover.Close asChild>
              <button type="button" className="vivic-scene-icon-button -mr-1 -mt-1 shrink-0" aria-label="关闭详情"><HarkIcon name="close" size={16} aria-hidden /></button>
            </Popover.Close>
          </div>
          <div className="mt-3 grid min-h-0 flex-1 content-start gap-3.5 overflow-auto overscroll-contain pb-1 text-[13px] leading-relaxed select-text" data-scene-detail-body>
            {longHeading && <DetailField label="完整标题">{heading}</DetailField>}
            {children}
          </div>
        </motion.div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

/** Copy to the clipboard with a short inline "已复制 / 复制失败" status. */
export function CopyButton({ text, label = "复制", ariaLabel }: { text: string; label?: string; ariaLabel?: string }) {
  const [status, setStatus] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    let ok = false;
    try {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (clipboard?.writeText) { await clipboard.writeText(text); ok = true; }
    } catch { ok = false; }
    setStatus(ok ? "done" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus("idle"), 1800);
  };
  return <span className="inline-flex items-center gap-1.5">
    <button type="button" className="vivic-scene-action nodrag nopan" aria-label={ariaLabel} onClick={() => void copy()} data-scene-copy>
      {status === "done" ? <HarkIcon name="check" size={13} aria-hidden /> : <HarkIcon name="copy" size={13} aria-hidden />}{label}
    </button>
    <span role="status" aria-live="polite" data-scene-copy-status={status}
      className={`text-[11.5px] ${status === "failed" ? "text-[var(--vivic-danger)]" : "text-[var(--vivic-positive)]"}`}>
      {status === "done" ? "已复制" : status === "failed" ? "复制失败" : ""}
    </span>
  </span>;
}

/** Small radio-style segmented control for control-mode enum edits. */
export function SegmentedControl<T extends string>({ label, value, options, onChange }: {
  label: string; value: T | undefined; options: ReadonlyArray<{ value: T; label: string }>; onChange: (value: T) => void;
}) {
  return <div role="radiogroup" aria-label={label} data-scene-segmented={label}
    className="nodrag nopan inline-flex max-w-full flex-wrap gap-0.5 rounded-[var(--radius-md)] bg-[var(--vivic-subtle)] p-0.5">
    {options.map(option => <button key={option.value} type="button" role="radio" aria-checked={value === option.value} data-value={option.value}
      onClick={() => onChange(option.value)}
      className="min-h-[26px] cursor-pointer rounded-[calc(var(--radius-md)-2px)] px-2.5 text-[12px] font-medium text-[var(--vivic-muted-ink)] transition-colors hover:text-[var(--foreground)] focus-visible:outline-2 focus-visible:outline-[var(--ring)] aria-checked:bg-[var(--card)] aria-checked:text-[var(--foreground)] aria-checked:ring-1 aria-checked:ring-[var(--vivic-line)]">
      {option.label}
    </button>)}
  </div>;
}

/**
 * Display only: the laid-out block size of a flexible region (its size must
 * not depend on its own content, e.g. `flex: 1 1 0` + `contain: size`). Null
 * when disabled or when there is no layout (tests), so callers use defaults.
 */
export function useFitHeight<T extends HTMLElement>(enabled: boolean): [(node: T | null) => void, number | null] {
  const [element, setElement] = useState<T | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!enabled || !element) return;
    const read = () => {
      const next = element.getClientRects().length ? element.clientHeight : null;
      setHeight(previous => previous === next ? previous : next);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, element]);
  return [setElement, enabled && element ? height : null];
}

/** Whole rows of `unit` px that fit in `space` (after an optional fixed `lead`), bounded by `max`. */
export const rowsThatFit = (space: number | null, unit: number, max: number, lead = 0): number =>
  space === null ? max : Math.max(0, Math.min(max, Math.floor((space - lead + 0.5) / unit)));
