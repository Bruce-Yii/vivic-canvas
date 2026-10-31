import { presentCards, groupedReminder, completedCountdown, reminderGroupKey, reminderVisible } from "@/canvas/reminderPresentation";
import { hostedCardHeight } from "@vivic/contracts";
import { useSyncExternalStore } from "react";
import {
  ActionEnvelopeSchema,
  CardRecordSchema,
  onUserSurface,
  type Action,
  type ActionEnvelope,
  type CardRecord,
  validCardTarget,
} from "@/contracts";
import { CanvasInteractionSchema, DEFAULT_DISPLAY_PREFERENCES, DisplayPreferencesSchema,
  type CanvasInteraction, type DisplayPreferences } from "@/sync/protocol";

export type VisualStage = "STANDBY" | "AWAKENING" | "WORKSPACE";
export type ThemeMode = "auto" | "light" | "dark";

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CardState {
  record: CardRecord;
  /** Set while the 120–280ms delete exit animation runs, before commit. */
  exitingRequestId?: string;
}

export interface FocusState {
  cardId: string;
  prevViewport: Viewport;
}

export interface SubtitleState {
  id: string;
  text: string;
  durationMs: number;
  shownAt: number;
  priority?: "normal" | "reminder";
}

export interface HighlightState {
  id: string;
  cardId: string;
  itemId?: string;
  durationMs: number;
}

export interface VivicState {
  stage: VisualStage;
  /** Timestamp of the last confirmed stage.awaken, drives the reveal. */
  awakenedAt: number | null;
  cards: CardState[];
  /** Delete snapshots, newest last; undo restores the exact prior record. */
  undoStack: Array<{ card: CardRecord; index: number; groupId?: string }>;
  /** Trash entries awaiting exit-animation commit, keyed by requestId. */
  pendingDeletes: Record<string, { cardId: string; index: number }>;
  focus: FocusState | null;
  focusHistory: string[];
  /** Window-local screen size of the canvas view (drives auto-fit after card.create). */
  viewportSize: { width: number; height: number } | null;
  highlight: HighlightState | null;
  subtitle: SubtitleState | null;
  activity: import("@vivic/contracts").SerializedVivicState["activity"];
  targetChoice: import("@vivic/contracts").SerializedVivicState["targetChoice"];
  ambient: { preset: "grainient" | "clouds" | "clouds2"; theme: ThemeMode };
  viewport: Viewport;
  /** One-shot effect pings for the view layer. */
  lastFitRequestId: string | null;
  processedRequestIds: string[];
}

const MAX_PROCESSED = 500;
const DEFAULT_LAYOUT = { width: 260, height: 120, pinned: false };
const GRID_X = 0;
const GRID_Y = 0;
const GAP_X = 48;
const GAP_Y = 40;

const initialState = (): VivicState => ({
  stage: "STANDBY",
  awakenedAt: null,
  cards: [],
  undoStack: [],
  pendingDeletes: {},
  focus: null,
  focusHistory: [],
  viewportSize: null,

  highlight: null,
  subtitle: null,
  activity: null,
  targetChoice: null,
  ambient: { preset: "grainient", theme: "auto" },
  viewport: { x: 0, y: 0, zoom: 1 },
  lastFitRequestId: null,
  processedRequestIds: [],
});

export const cardHeight = ({ record }: CardState): number => hostedCardHeight(record);
/** Persisted layout bounds, using the same conservative content heights as placement. */
export const hasUnpinnedOverlap = (cards: CardState[]): boolean => presentCards(cards).some(({ entry: left }, index, visible) => !left.exitingRequestId && visible.slice(index + 1).some(({ entry: right }) => {
  if (right.exitingRequestId || (left.record.layout.pinned && right.record.layout.pinned)) return false;
  const a = left.record.layout, b = right.record.layout;
  return a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + cardHeight(right) && a.y + cardHeight(left) > b.y;
}));
/** Dimension-aware grid; pinned/restored layouts are obstacles, never moved. */
const placeCards = (cards: CardState[], preserved: ReadonlySet<string> = new Set()): CardState[] => {
  const fixed = (entry: CardState) => entry.exitingRequestId || entry.record.layout.pinned || preserved.has(entry.record.id);
  const automatic = cards.filter(entry => !fixed(entry));
  const cellWidth = Math.max(DEFAULT_LAYOUT.width, ...automatic.map(entry => entry.record.layout.width));
  const cellHeight = Math.max(140, ...automatic.map(cardHeight));
  const occupied = cards.filter(fixed).map(entry => ({ ...entry.record.layout, height: cardHeight(entry) }));
  let cursor = 0;
  return cards.map((entry) => {
    if (fixed(entry)) return entry;
    const height = cardHeight(entry);
    let x = entry.record.layout.x, y = entry.record.layout.y;
    for (let attempt = 0; attempt < 4096; attempt++, cursor++) {
      x = GRID_X + (cursor % 3) * (cellWidth + GAP_X);
      y = GRID_Y + Math.floor(cursor / 3) * (cellHeight + GAP_Y);
      const collision = occupied.some(rect => x < rect.x + rect.width + 12 && x + entry.record.layout.width + 12 > rect.x
        && y < rect.y + rect.height + 12 && y + height + 12 > rect.y);
      if (!collision) { cursor++; break; }
    }
    occupied.push({ ...entry.record.layout, x, y, height });
    if (entry.record.layout.x === x && entry.record.layout.y === y && entry.record.layout.height === height) return entry;
    return {
      ...entry,
      record: {
        ...entry.record,
        layout: {
          ...entry.record.layout,
          x, y, height,
        },
      },
    };
  });
};

export const relayout = (cards: CardState[], preserved: ReadonlySet<string> = new Set(), focusId?: string): CardState[] => {
  const view = presentCards(cards, { focusId });
  const fixed = new Set(preserved);
  for (const group of view) if (group.memberIds.some(id => preserved.has(id))) fixed.add(group.entry.record.id);
  const placed = placeCards(view.map(item => item.entry), fixed);
  const layouts = new Map(view.flatMap((group, index) => group.memberIds.map(id => [id, placed[index]!.record.layout] as const)));
  const next = cards.map(entry => {
    const layout = layouts.get(entry.record.id);
    if (!layout || Object.keys(layout).length === Object.keys(entry.record.layout).length
      && Object.entries(layout).every(([key, value]) => Object.is(Reflect.get(entry.record.layout, key), value))) return entry;
    return { ...entry, record: { ...entry.record, layout } };
  });
  return next.every((entry, index) => entry === cards[index]) ? cards : next;
};

const withProcessed = (state: VivicState, requestId: string): VivicState => ({
  ...state,
  processedRequestIds: [...state.processedRequestIds, requestId].slice(-MAX_PROCESSED),
});

const applyAction = (
  state: VivicState,
  action: Action,
  requestId: string,
): VivicState => {
  switch (action.type) {
    case "stage.awaken": {
      if (state.stage !== "STANDBY") return state;
      return { ...state, stage: "AWAKENING", awakenedAt: Date.now() };
    }
    case "card.create": {
      // A visible new card must not remain hidden behind standby just because a
      // provider omitted a presentation-only wake action. Hidden reminders stay quiet.
      const awakened = !onUserSurface(action.card) && reminderVisible({ record: action.card })
        ? applyAction(state, { type: "stage.awaken" }, requestId) : state;
      const exists = state.cards.some((c) => c.record.id === action.card.id);
      if (exists)
        return {
          ...awakened,
          cards: relayout(
            state.cards.map((c) =>
              c.record.id === action.card.id ? { record: c.record.layout.pinned
                ? { ...action.card, layout: c.record.layout } : action.card } : c,
            ),
          ),
        };
      return { ...awakened, cards: relayout([...state.cards, { record: action.card }]) };
    }
    case "cards.delete": {
      return action.targetIds.reduce((next, targetId) => applyAction(next, { type: "card.delete", targetId }, requestId), state);
    }
    case "card.delete": {
      const index = state.cards.findIndex(
        (c) => c.record.id === action.targetId && !c.exitingRequestId,
      );
      if (index < 0) return state;
      return {
        ...state,
        cards: state.cards.map((c) =>
          c.record.id === action.targetId && !c.exitingRequestId
            ? { ...c, exitingRequestId: requestId }
            : c,
        ),
        pendingDeletes: {
          ...state.pendingDeletes,
          [requestId]: { cardId: action.targetId, index },
        },
      };
    }
    case "card.focus": {
      const card = state.cards.find(
        (c) => c.record.id === action.targetId && !c.exitingRequestId,
      );
      // A card on the user page is not on the canvas: never dim the stage for it.
      if (!card || onUserSurface(card.record)) return state;
      return {
        ...applyAction(state, { type: "stage.awaken" }, requestId),
        cards: !reminderVisible(card) ? relayout(state.cards, new Set(state.cards.filter(c => reminderVisible(c)).map(c => c.record.id)), card.record.id) : state.cards,
        focus: { cardId: card.record.id, prevViewport: state.viewport },
        focusHistory: [...state.focusHistory, card.record.id].slice(-20),
      };
    }
    case "card.highlight": {
      return {
        ...state,
        highlight: {
          id: requestId,
          cardId: action.targetId,
          itemId: action.itemId,
          durationMs: action.durationMs ?? 2000,
        },
      };
    }
    case "card.subcard.set":
    case "card.subcard.delete": {
      const entry = state.cards.find(c => c.record.id === action.targetId && !c.exitingRequestId && !completedCountdown(c));
      if (!entry) return state;
      const previous = entry.record.metadata.subcards ?? [];
      if (action.type === "card.subcard.set" && !validCardTarget(entry.record, action.subcard)) return state;
      const subcards = action.type === "card.subcard.delete" ? previous.filter(item => item.id !== action.subcardId)
        : [...previous.filter(item => item.id !== action.subcard.id), action.subcard];
      const parsed = CardRecordSchema.safeParse({ ...entry.record, metadata: { ...entry.record.metadata, subcards, updatedAt: new Date().toISOString() } });
      if (!parsed.success) return state;
      return { ...state, cards: state.cards.map(c => c === entry ? { ...c, record: parsed.data } : c) };
    }
    case "card.update": {
      const index = state.cards.findIndex(
        (c) => c.record.id === action.targetId,
      );
      if (index < 0) return state;
      const current = state.cards[index]!.record;
      if (action.variant !== undefined && (current.type !== "NoteCard"
        || (action.displayProps && Object.keys(action.displayProps).length)
        || (action.sourceData && Object.keys(action.sourceData).length))) return state;
      // CardRegistry check: merged displayProps must still pass the schema.
      const candidate = {
        ...current,
        variant: action.variant ?? current.variant,
        layout: action.variant !== undefined && action.variant !== current.variant
          ? { ...current.layout, height: action.variant === "standard" ? 192 : 128 }
          : current.layout,
        displayProps: action.displayProps
          ? { ...current.displayProps, ...action.displayProps }
          : current.displayProps,
        sourceData: action.sourceData
          ? { ...current.sourceData, ...action.sourceData }
          : current.sourceData,
        metadata: { ...current.metadata, updatedAt: new Date().toISOString() },
      };
      const parsed = CardRecordSchemaSafeParse(candidate);
      if (!parsed) return state;
      const updated = { record: parsed };
      const height = cardHeight(updated);
      // Content growth must reserve space before it can cover the next row.
      // Fixed positions stay fixed; surrounding automatic cards move away.
      const resized = height > parsed.layout.height
        ? { record: { ...parsed, layout: { ...parsed.layout, height } } }
        : updated;
      const cards = state.cards.map((c, i) => i === index ? resized : c);
      return {
        ...state,
        ...(completedCountdown(resized) && state.focus?.cardId === current.id ? { focus: null } : {}),
        cards: hasUnpinnedOverlap(cards) || action.variant !== undefined ? relayout(cards) : cards,
      };
    }
    case "canvas.fit":
      return { ...(state.cards.some(card => !card.exitingRequestId && !onUserSurface(card.record) && reminderVisible(card))
        ? applyAction(state, { type: "stage.awaken" }, requestId) : state), focus: null, lastFitRequestId: requestId };
    case "canvas.restore":
      return { ...state, focus: null };
    case "canvas.switch":
    case "canvas.create":
      // Multi-canvas routing happens in controlRuntime/displayClient before a
      // reducer sees the envelope; per-canvas state itself does not change.
      return state;
    case "ambient.setPreset": {
      return {
        ...state,
        ambient: {
          preset: action.preset, // only "grainient" is mounted in Phase 0
          theme: action.theme ?? state.ambient.theme,
        },
      };
    }
    case "subtitle.show": {
      if (!action.text.trim()) return state;
      if (action.priority !== "reminder" && state.subtitle?.priority === "reminder"
        && Date.now() < state.subtitle.shownAt + state.subtitle.durationMs) return state;
      return {
        ...state,
        subtitle: {
          id: requestId,
          text: action.text,
          durationMs: action.durationMs ?? 3000,
          shownAt: Date.now(),
          priority: action.priority,
        },
      };
    }
    case "subtitle.hide":
      return { ...state, subtitle: null };
  }
};

const CardRecordSchemaSafeParse = (candidate: unknown): CardRecord | null => {
  const res = CardRecordSchema.safeParse(candidate);
  return res.success ? res.data : null;
};

export const reduceEnvelope = (
  state: VivicState,
  envelope: ActionEnvelope,
): VivicState => {
  if (state.processedRequestIds.includes(envelope.requestId)) return state;
  let next = state;
  for (const action of envelope.actions) {
    next = applyAction(next, action, envelope.requestId);
  }
  next = withProcessed(next, envelope.requestId);
  return maybeRequestFit(next, envelope);
};

/**
 * Phase 1.1: after an envelope that creates cards, ask the view for a
 * one-shot smooth fit when the relayouted bounds overflow THIS window's
 * visible world rect. Per-envelope and idempotent (the requestId was just
 * deduped above). A card.focus in the same envelope wins; a prior focus or
 * an explicit canvas.fit suppress the auto-fit; bounds that already fit
 * leave the camera untouched (fitView adds its own padding).
 */
const maybeRequestFit = (
  state: VivicState,
  envelope: ActionEnvelope,
): VivicState => {
  const types = new Set(envelope.actions.map((a) => a.type));
  if (!types.has("card.create") && !types.has("card.update")) return state;
  if (types.has("card.focus") || types.has("canvas.fit")) return state;
  if (state.focus) return state;
  const size = state.viewportSize;
  if (!size) return state;
  const live = presentCards(state.cards).map(item => item.entry).filter(c => !c.exitingRequestId);
  if (live.length === 0) return state;
  const zoom = state.viewport.zoom || 1;
  const vis = {
    x0: -state.viewport.x / zoom,
    y0: -state.viewport.y / zoom,
    x1: (-state.viewport.x + size.width) / zoom,
    y1: (-state.viewport.y + size.height) / zoom,
  };
  const minX = Math.min(...live.map((c) => c.record.layout.x));
  const minY = Math.min(...live.map((c) => c.record.layout.y));
  const maxX = Math.max(
    ...live.map((c) => c.record.layout.x + c.record.layout.width),
  );
  const maxY = Math.max(
    ...live.map((c) => c.record.layout.y + c.record.layout.height),
  );
  const fits =
    minX >= vis.x0 && minY >= vis.y0 && maxX <= vis.x1 && maxY <= vis.y1;
  if (fits) return state;
  return { ...state, lastFitRequestId: envelope.requestId };
};

/** Internal (non-wire) commits driven by the view layer. */
export const getUndoGroup = (state: VivicState): VivicState["undoStack"] => {
  const last = state.undoStack.at(-1);
  if (!last) return [];
  if (!last.groupId) return [last];
  let start = state.undoStack.length - 1;
  while (start > 0 && state.undoStack[start - 1]?.groupId === last.groupId) start -= 1;
  return state.undoStack.slice(start).sort((a, b) => a.index - b.index);
};

export type InternalAction =
  | { type: "targetChoice.set"; choice: VivicState["targetChoice"] }
  | { type: "activity.set"; activity: VivicState["activity"] }
  | { type: "stage.awakening.complete" }
  | { type: "card.delete.commit"; requestId: string }
  | { type: "undo" }
  | { type: "subtitle.dismiss"; id: string }
  | { type: "highlight.clear"; id: string }
  | { type: "canvas.viewport"; viewport: Viewport }
  | { type: "canvas.viewportSize"; width: number; height: number };

const reduceInternal = (
  state: VivicState,
  action: InternalAction,
): VivicState => {
  switch (action.type) {
    case "targetChoice.set":
      return { ...state, targetChoice: action.choice };
    case "activity.set":
      return { ...state, activity: action.activity };
    case "stage.awakening.complete": {
      if (state.stage !== "AWAKENING") return state;
      return { ...state, stage: "WORKSPACE" };
    }
    case "card.delete.commit": {
      const pending = state.pendingDeletes[action.requestId];
      if (!pending) return state;
      const removed = state.cards.flatMap((c, index) => c.exitingRequestId === action.requestId
        ? [{ card: c.record, index, groupId: action.requestId }] : []);
      const removedIds = new Set(removed.map(c => c.card.id));
      const remaining = state.cards.filter(
        (c) => c.exitingRequestId !== action.requestId,
      );
      const rest = { ...state.pendingDeletes };
      delete rest[action.requestId];
      return {
        ...state,
        cards: relayout(remaining),
        pendingDeletes: rest,
        undoStack: [...state.undoStack, ...removed].slice(-Math.max(50, removed.length)),
        focus: state.focus && removedIds.has(state.focus.cardId) ? null : state.focus,
        highlight:
          state.highlight && removedIds.has(state.highlight.cardId) ? null : state.highlight,
      };
    }
    case "undo": {
      const group = getUndoGroup(state);
      if (!group.length) return state;
      const cards = [...state.cards];
      for (const snapshot of group) cards.splice(Math.min(snapshot.index, cards.length), 0, { record: snapshot.card });
      return {
        ...state,
        cards: relayout(cards, new Set(group.map(snapshot => snapshot.card.id))),
        undoStack: state.undoStack.slice(0, -group.length),
      };
    }
    case "subtitle.dismiss":
      return state.subtitle?.id === action.id
        ? { ...state, subtitle: null }
        : state;
    case "highlight.clear":
      return state.highlight?.id === action.id
        ? { ...state, highlight: null }
        : state;
    case "canvas.viewport":
      return { ...state, viewport: action.viewport };
    case "canvas.viewportSize":
      return {
        ...state,
        viewportSize: { width: action.width, height: action.height },
      };
    default:
      // Older debug clients may send removed internal action names. Never let
      // an unsupported internal input replace the entire store with undefined.
      return state;
  }
};

// ---------------------------------------------------------------------------
// Store (plain subscribers + useSyncExternalStore; no external state lib)
// ---------------------------------------------------------------------------

export type DispatchResult =
  | { ok: true; deduplicated: boolean }
  | { ok: false; error: string };

export interface CanvasStore {
  getState: () => VivicState;
  subscribe: (listener: () => void) => () => void;
  dispatch: (raw: unknown) => DispatchResult;
  /** Owner-only interaction engine. Replicas receive confirmed snapshots. */
  interact: (requestId: string, raw: unknown) => DispatchResult;
  getPreferences: () => DisplayPreferences;
  setPreferences: (raw: DisplayPreferences) => void;
  internal: (action: InternalAction) => void;
  /** Replace the whole state from a sync snapshot or a persisted record. */
  loadState: (next: VivicState) => void;
  /** Plain-JSON copy for snapshots/persistence (VivicStateSchema-shaped). */
  toJSON: () => VivicState;
  reset: () => void;
}

export const createCanvasStore = (): CanvasStore => {
  let state = initialState();
  let preferences = { ...DEFAULT_DISPLAY_PREFERENCES };
  const applyPreferences = (next: VivicState): VivicState => ({ ...next,
    ambient: { ...next.ambient, theme: preferences.theme },
    subtitle: preferences.subtitles || next.subtitle?.priority === "reminder" ? next.subtitle : null,
  });
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  /** User page ⇄ Display. A drop point places the card exactly there (like a
   * manual drag); otherwise it takes the next free slot and nothing else moves. */
  const moveBetweenSurfaces = (requestId: string, entry: CardState,
    action: Extract<CanvasInteraction, { kind: "card.surface" }>): DispatchResult => {
    const layout = entry.record.layout;
    const current = layout.surface ?? "display";
    if (current === action.surface && action.x === undefined) {
      state = withProcessed(state, requestId); emit();
      return { ok: true, deduplicated: false };
    }
    // On the user page x/y is the drop point there (userPos); the canvas spot is kept.
    // Back on the Display x/y is the canvas drop point and the page position is dropped.
    const { surface: _previous, userPos, ...rest } = layout;
    const point = action.x !== undefined && action.y !== undefined ? { x: action.x, y: action.y } : undefined;
    const nextLayout = action.surface === "user" ? { ...rest, surface: "user" as const, ...(point ?? userPos ? { userPos: point ?? userPos } : {}) }
      : { ...rest, ...(point ?? {}) };
    const candidate = CardRecordSchema.safeParse({ ...entry.record, layout: nextLayout,
      metadata: { ...entry.record.metadata, updatedAt: new Date().toISOString() } });
    if (!candidate.success) return { ok: false, error: "invalid-card" };
    let cards = state.cards.map(c => c === entry ? { ...c, record: candidate.data } : c);
    if (action.surface === "display" && action.x === undefined) {
      cards = relayout(cards, new Set(cards.filter(c => c !== entry && c.record.id !== entry.record.id).map(c => c.record.id)));
    }
    const leavingFocus = action.surface === "user" && state.focus?.cardId === entry.record.id;
    const transferred = { ...state, cards, ...(leavingFocus ? { focus: null } : {}) };
    // A deliberate transfer must be visible even when a newly created canvas
    // has never received a text command. Reuse the normal reveal transition.
    state = withProcessed(action.surface === "display"
      ? applyAction(applyAction(transferred, { type: "stage.awaken" }, requestId), { type: "card.focus", targetId: entry.record.id }, requestId)
      : transferred, requestId);
    emit();
    return { ok: true, deduplicated: false };
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPreferences: () => preferences,
    setPreferences(raw) {
      const parsed = DisplayPreferencesSchema.safeParse(raw);
      if (!parsed.success) return;
      preferences = parsed.data;
      state = applyPreferences(state);
      emit();
    },
    interact(requestId, raw) {
      const parsed = CanvasInteractionSchema.safeParse(raw);
      if (!parsed.success || !requestId || requestId.length > 128)
        return { ok: false, error: "invalid-interaction" };
      if (state.processedRequestIds.includes(requestId)) return { ok: true, deduplicated: true };
      const action = parsed.data;
      const entry = state.cards.find(c => c.record.id === action.cardId && !c.exitingRequestId);
      if (!entry) return { ok: false, error: "missing-card" };
      const layout = entry.record.layout;
      if (Object.keys(action.from).some(key => layout[key as keyof typeof layout] !== action.from[key as keyof typeof action.from]))
        return { ok: false, error: "layout-conflict" };
      if (action.kind === "card.move" && layout.pinned) return { ok: false, error: "card-pinned" };
      if (action.kind === "card.surface") return moveBetweenSurfaces(requestId, entry, action);
      const candidate = CardRecordSchema.safeParse({ ...entry.record,
        layout: action.kind === "card.move" ? { ...layout, x: action.x, y: action.y } : { ...layout, pinned: action.pinned },
        metadata: { ...entry.record.metadata, updatedAt: new Date().toISOString() },
      });
      if (!candidate.success) return { ok: false, error: "invalid-card" };
      const grouped = action.kind === "card.move" && groupedReminder(entry) ? state.cards.filter(c => groupedReminder(c) && reminderGroupKey(c) === reminderGroupKey(entry)) : [entry];
      const dx = candidate.data.layout.x - layout.x, dy = candidate.data.layout.y - layout.y;
      const cards = state.cards.map(c => c === entry ? { ...c, record: candidate.data }
        : grouped.includes(c) ? { ...c, record: { ...c.record, layout: { ...c.record.layout, x: c.record.layout.x + dx, y: c.record.layout.y + dy } } } : c);
      state = withProcessed({ ...state, cards: action.kind === "card.move" ? cards : relayout(cards) }, requestId);
      emit();
      return { ok: true, deduplicated: false };
    },
    dispatch(raw) {
      const parsed = ActionEnvelopeSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
      }
      const deduplicated = state.processedRequestIds.includes(
        parsed.data.requestId,
      );
      const next = reduceEnvelope(state, parsed.data);
      if (next !== state) {
        state = preferences.subtitles || next.subtitle?.priority === "reminder" ? next : { ...next, subtitle: null };
        emit();
      }
      return { ok: true, deduplicated };
    },
    internal(action) {
      const next = reduceInternal(state, action);
      if (next !== state) {
        state = next;
        emit();
      }
    },
    loadState(next) {
      // Snapshot/persisted states carry no local screen info; keep this
      // window's measured size across reloads.
      state = applyPreferences({ ...next, viewportSize: state.viewportSize ?? next.viewportSize });
      emit();
    },
    toJSON() {
      return JSON.parse(JSON.stringify(state)) as VivicState;
    },
    reset() {
      state = initialState();
      emit();
    },
  };
};

export const canvasStore = createCanvasStore();

export const useVivicState = <T,>(selector: (state: VivicState) => T): T =>
  useSyncExternalStore(canvasStore.subscribe, () =>
    selector(canvasStore.getState()),
  );

export const useDisplayPreferences = (): DisplayPreferences =>
  useSyncExternalStore(canvasStore.subscribe, canvasStore.getPreferences);
