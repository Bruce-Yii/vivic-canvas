import { useCallback, useEffect } from "react";
import { canvasStore } from "@/state/canvasStore";
import { demoCards } from "./demoActions";

let seq = 0;
const reqId = (tag: string) => `dev-${tag}-${Date.now()}-${(seq += 1)}`;

const fire = (tag: string, actions: Array<Record<string, unknown>>) =>
  canvasStore.dispatch({
    schemaVersion: "0.6",
    requestId: reqId(tag),
    canvasId: "dev",
    actions,
  });

/**
 * Debug panel for the visual stage; only rendered on `/display?dev=1`
 * (plain /display ships without it; /control is the real operator UI).
 * Drives the LOCAL store directly — it bypasses sync on purpose.
 */
export const DevPanel = () => {
  const awaken = useCallback(() => fire("awaken", [{ type: "stage.awaken" }]), []);
  const createCards = useCallback(
    () =>
      fire("cards", demoCards().map((card) => ({ type: "card.create", card }))),
    [],
  );
  const focusTodo = useCallback(
    () => fire("focus", [{ type: "card.focus", targetId: "demo-todo" }]),
    [],
  );
  const restore = useCallback(
    () => fire("restore", [{ type: "canvas.restore" }]),
    [],
  );
  const deleteCountdown = useCallback(
    () => fire("delete", [{ type: "card.delete", targetId: "demo-countdown" }]),
    [],
  );
  const undo = useCallback(
    () => canvasStore.internal({ type: "undo" }),
    [],
  );
  const feedback = useCallback(
    () =>
      fire("feedback", [
        {
          type: "subtitle.show",
          text: "Found it — the second one is worth a look.",
          durationMs: 2600,
        },
        {
          type: "card.highlight",
          targetId: "demo-todo",
          itemId: "demo-t2",
          durationMs: 2400,
        },
      ]),
    [],
  );
  const setTheme = useCallback(
    (theme: "auto" | "light" | "dark") =>
      fire("theme", [{ type: "ambient.setPreset", preset: "grainient", theme }]),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const handlers: Record<string, () => void> = {
        a: awaken,
        c: createCards,
        f: focusTodo,
        r: restore,
        d: deleteCountdown,
        u: undo,
        s: feedback,
      };
      handlers[e.key]?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [awaken, createCards, focusTodo, restore, deleteCountdown, undo, feedback]);

  const button = (label: string, onClick: () => void, key: string) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-800"
      title={`Shortcut: ${key}`}
    >
      {label} <span className="text-neutral-500">{key}</span>
    </button>
  );

  return (
    <div
      className="absolute bottom-3 left-3 z-50 flex max-w-[300px] flex-col gap-2 rounded-lg border border-amber-500/60 bg-neutral-950/95 p-3 font-mono"
      data-vivic-devpanel
    >
      <span className="text-[10px] font-semibold tracking-widest text-amber-400">
        DEV PANEL — PHASE 0 SCAFFOLD (?dev=1)
      </span>
      <div className="flex flex-wrap gap-1.5">
        {button("awaken", awaken, "a")}
        {button("3 demo cards", createCards, "c")}
        {button("focus todo", focusTodo, "f")}
        {button("restore", restore, "r")}
        {button("delete countdown", deleteCountdown, "d")}
        {button("undo", undo, "u")}
        {button("orb + subtitle", feedback, "s")}
      </div>
      <div className="flex gap-1.5">
        {button("auto", () => setTheme("auto"), "-")}
        {button("light", () => setTheme("light"), "-")}
        {button("dark", () => setTheme("dark"), "-")}
      </div>
    </div>
  );
};
