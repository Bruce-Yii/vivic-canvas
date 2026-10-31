import { useEffect } from "react";
import { animate } from "motion";

/** Animate existing native disclosures without replacing their state or editors. */
export function useDisclosureMotion() {
  useEffect(() => {
    const running = new Map<HTMLDetailsElement, { open: boolean; stop(): void }>();
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return;
      const summary = event.target.closest("summary"), detail = summary?.parentElement;
      if (!(detail instanceof HTMLDetailsElement) || !detail.closest(".vh-hark") || detail.hasAttribute("data-expanded")) return;
      if (detail.classList.contains("hosted-add-menu")) return;
      if (event.target.closest("button,a,input,select,textarea")) return;
      if (typeof window.matchMedia !== "function" || !detail.getClientRects().length || window.matchMedia("(prefers-reduced-motion: reduce)").matches || detail.closest('[data-reduced-motion="true"]')) return;
      event.preventDefault();
      const previous = running.get(detail), open = !(previous?.open ?? detail.open);
      const start = detail.getBoundingClientRect().height;
      previous?.stop();
      detail.style.height = "";
      detail.open = open;
      const end = detail.getBoundingClientRect().height;
      detail.open = true;
      detail.style.height = `${start}px`; detail.style.overflow = "hidden";
      detail.dataset.harkDisclosure = open ? "opening" : "closing";
      const content = [...detail.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node !== summary);
      if (open && !previous) content.forEach(node => { node.style.opacity = "0"; node.style.transform = "translateY(4px)"; });
      if (!open && detail.contains(document.activeElement)) (summary as HTMLElement).focus({ preventScroll: true });
      const body = content.length ? animate(content, { opacity: open ? 1 : 0, y: open ? 0 : 4 }, { duration: open ? 0.2 : 0.14, ease: "easeOut" }) : null;
      const height = animate(detail, { height: [start, end] }, { duration: open ? 0.24 : 0.18, ease: [0.2, 0.8, 0.2, 1] });
      const record = { open, stop: () => { height.stop(); body?.stop(); } }; running.set(detail, record);
      void height.then(() => {
        if (running.get(detail) !== record) return;
        detail.open = open; detail.style.height = ""; detail.style.overflow = ""; delete detail.dataset.harkDisclosure;
        content.forEach(node => { node.style.opacity = ""; node.style.transform = ""; });
        running.delete(detail);
      });
    };
    const toggle = (event: Event) => {
      const detail = event.target;
      if (!(detail instanceof HTMLDetailsElement) || detail.open) return;
      const record = running.get(detail);
      if (!record) return;
      running.delete(detail); record.stop(); detail.style.height = ""; detail.style.overflow = ""; delete detail.dataset.harkDisclosure;
      [...detail.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node.tagName !== "SUMMARY").forEach(node => { node.style.opacity = ""; node.style.transform = ""; });
    };
    document.addEventListener("click", click);
    document.addEventListener("toggle", toggle, true);
    return () => {
      document.removeEventListener("click", click);
      document.removeEventListener("toggle", toggle, true);
      running.forEach((record, detail) => { record.stop(); detail.open = record.open; detail.style.height = ""; detail.style.overflow = ""; delete detail.dataset.harkDisclosure;
        [...detail.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node.tagName !== "SUMMARY").forEach(node => { node.style.opacity = ""; node.style.transform = ""; });
      });
    };
  }, []);
}
