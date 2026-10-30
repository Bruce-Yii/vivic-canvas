import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const reducedQuery = () => typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
const subscribeReduced = (notify: () => void) => {
  const query = reducedQuery();
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
};
/** Reacts to OS preference changes while the app remains open. */
export const useSystemReducedMotion = () => useSyncExternalStore(subscribeReduced, () => reducedQuery()?.matches ?? false, () => false);

/** Pause decorations when the page is hidden or the element is outside the viewport. */
export function useMotionVisibility<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    let inView = true;
    const update = () => setVisible(document.visibilityState !== "hidden" && inView);
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
      inView = entries.some(entry => entry.isIntersecting);
      update();
    }) : null;
    if (ref.current) observer?.observe(ref.current);
    document.addEventListener("visibilitychange", update);
    update();
    return () => { observer?.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  return { ref, visible };
}
