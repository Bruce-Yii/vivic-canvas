import type { CountdownCard } from "@/contracts";
import type { CardState, HighlightState } from "@/state/canvasStore";

export interface VivicNodeData extends Record<string, unknown> {
  entry: CardState;
  reminders?: CountdownCard[];
  focusedId?: string;
  focused: boolean;
  dimmed: boolean;
  highlight: HighlightState | null;
}

/** Render memoization only: no canvas state is stored or changed by this cache. */
export const createNodeDataMemo = () => {
  const cache = new WeakMap<CardState, VivicNodeData>();
  return (next: VivicNodeData): VivicNodeData => {
    const before = cache.get(next.entry);
    if (before && before.focusedId === next.focusedId && before.focused === next.focused
      && before.dimmed === next.dimmed && before.highlight === next.highlight
      && (before.reminders === next.reminders || before.reminders && next.reminders
        && before.reminders.length === next.reminders.length && before.reminders.every((item, index) => item === next.reminders![index]))) return before;
    cache.set(next.entry, next);
    return next;
  };
};
