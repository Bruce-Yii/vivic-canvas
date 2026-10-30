import type { CardRecord } from "@/contracts";

interface Frame { label: string; before: CardRecord[]; after: CardRecord[] }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const MAX_STEPS = 40, MAX_CHARS = 4_000_000;

/** Owner-session history, isolated per Space. Never rolls back a later external edit. */
export class CardHistory {
  private undoFrames: Frame[] = [];
  private redoFrames: Frame[] = [];
  get status() { return { canUndo: this.undoFrames.length > 0, canRedo: this.redoFrames.length > 0,
    undoLabel: this.undoFrames.at(-1)?.label, redoLabel: this.redoFrames.at(-1)?.label }; }
  clear() { this.undoFrames = []; this.redoFrames = []; }
  record(before: CardRecord[], after: CardRecord[], label: string) {
    if (equal(before, after)) return;
    this.undoFrames.push(structuredClone({ before, after, label })); this.redoFrames = [];
    this.trim();
  }
  private trim() {
    this.undoFrames = this.undoFrames.slice(-MAX_STEPS); this.redoFrames = this.redoFrames.slice(-MAX_STEPS);
    while (this.undoFrames.length && JSON.stringify([...this.undoFrames, ...this.redoFrames]).length > MAX_CHARS) this.undoFrames.shift();
  }
  private apply(current: CardRecord[], frame: Frame, reverse: boolean): CardRecord[] | null {
    const expected = reverse ? frame.after : frame.before, replacement = reverse ? frame.before : frame.after;
    const expectedById = new Map(expected.map(card => [card.id, card])), replacementById = new Map(replacement.map(card => [card.id, card]));
    const currentById = new Map(current.map(card => [card.id, card]));
    const changed = new Set([...expectedById.keys(), ...replacementById.keys()].filter(id => !equal(expectedById.get(id), replacementById.get(id))));
    // Reordering alone also needs its original order to remain meaningful.
    const orderChanged = !equal(expected.map(c => c.id), replacement.map(c => c.id));
    if ([...changed].some(id => !equal(currentById.get(id), expectedById.get(id)))) return null;
    if (orderChanged && !equal(current.filter(c => expectedById.has(c.id)).map(c => c.id), expected.map(c => c.id))) return null;
    for (const id of changed) {
      const card = replacementById.get(id);
      if (card) currentById.set(id, structuredClone(card)); else currentById.delete(id);
    }
    const ids = orderChanged ? [...replacement.map(c => c.id), ...current.filter(c => !replacementById.has(c.id)).map(c => c.id)] : current.map(c => c.id);
    const result = [...new Set([...ids, ...currentById.keys()])].flatMap(id => currentById.has(id) ? [currentById.get(id)!] : []);
    return result;
  }
  undo(current: CardRecord[]): CardRecord[] | null {
    const frame = this.undoFrames.at(-1); if (!frame) return null;
    const next = this.apply(current, frame, true); if (!next) return null;
    this.undoFrames.pop(); this.redoFrames.push(structuredClone({ label: frame.label, before: next, after: current })); this.trim(); return next;
  }
  redo(current: CardRecord[]): CardRecord[] | null {
    const frame = this.redoFrames.at(-1); if (!frame) return null;
    const next = this.apply(current, frame, false); if (!next) return null;
    this.redoFrames.pop(); this.undoFrames.push(structuredClone({ label: frame.label, before: current, after: next })); this.trim(); return next;
  }
}
