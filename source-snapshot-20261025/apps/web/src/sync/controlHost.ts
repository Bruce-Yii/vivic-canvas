import { notifyReminder } from "@/reminders/notifications";
import { ActionEnvelopeSchema, CardRecordSchema, TargetChoiceSchema, type ActionEnvelope } from "@/contracts";
import { CardHistory } from "./cardHistory";
import { organizedCards, OrganizeOptionsSchema, CardOrganizationSchema, type OrganizeOptions, type CardOrganization } from "@/state/organizeCards";
import { emitSpaceFeedback, type SpaceFeedback } from "@/motion/spaceMotion";
import { isLiveWeatherCard, nextAliases } from "@/location/liveWeather";
import type { WeatherHereFields } from "@/ai/api";
import { fetchTravelOffers } from "@/ai/api";
import { newId } from "@/lib/id";
import {
  emptyVivicState,
  fromCanvasRecord,
  toCanvasRecord,
  type CanvasRecord,
} from "@/persistence/canvasRecord";
import {
  fileToCanvasRecord,
  parseCanvasFile,
  toCanvasFile,
} from "@/persistence/canvasFile";
import type { VivicDB } from "@/persistence/db";
import {
  canvasStore,
  createCanvasStore,
  relayout,
  hasUnpinnedOverlap,
  type CanvasStore,
  type DispatchResult,
  type VivicState,
} from "@/state/canvasStore";
import type { SyncChannel } from "./channel";
import {
  createOwnerManager,
  type LockProvider,
  type OwnerManager,
  type OwnerMode,
} from "./owner";
import { parseSyncMessage, CanvasInteractionSchema, DisplayInteractionSchema, DisplayPreferencesSchema, DEFAULT_DISPLAY_PREFERENCES,
  type DisplayPreferences, type CanvasInteraction, type SyncMessage } from "./protocol";
import { isDue, reminderText, sameDelivery, conditionSatisfied, deliveredNoticeCurrent, ReminderInboxSchema, type ReminderNotice, type ReminderSummary } from "@/reminders/reminders";
import { isDateCountdown, nextReminderOccurrence, TravelQuerySchema, type CardSurface, type CountdownCard } from "@vivic/contracts";
import { presentCards } from "@/canvas/reminderPresentation";
import { playReminderSound } from "@/reminders/sound";
import { envelopeCardPolicyIssue } from "./cardPolicy";
import { extensionDefinitions, validateExtensionCard } from "@/extensions/definitionStore";
import { getCanvasRecovery } from "@/persistence/canvasRecord";

/**
 * CONTROL_OWNER host: the sole writer. Dispatches validated ActionEnvelopes
 * into the local canvasStore (shared reducer with display), persists the
 * multi-canvas registry to IndexedDB (debounced), and broadcasts
 * snapshot/patch messages to display readers. Reacts to hello /
 * snapshot-request with a snapshot of the requested (or active) canvas.
 */

export interface CanvasMeta {
  id: string;
  title: string;
  version: number;
  updatedAt: string;
}

export interface ControlSnapshot {
  history?: { canUndo: boolean; canRedo: boolean; undoLabel?: string; redoLabel?: string };
  preferences: DisplayPreferences;
  ready: boolean;
  ownerMode: OwnerMode;
  /** Existing owner broadcasts identify the UI reading session, including
   * readonly windows whose mode stays unchanged during a takeover. */
  ownerId: string | null;
  canvases: CanvasMeta[];
  activeCanvasId: string | null;
  reminders: ReminderSummary[];
  reminderNotices: ReminderNotice[];
  reminderError: string | null;
  recovery?: { canvasId: string; quarantinedCardCount: number; issueCount: number };
}

export interface ControlHostDeps {
  db: VivicDB;
  channel: SyncChannel;
  instanceId?: string;
  lockProvider?: LockProvider | null;
  store?: CanvasStore;
  autosaveMs?: number;
  reminderPollMs?: number;
  now?: () => number;
  onLocalDataReset?: () => void;
  travelRefresh?: typeof fetchTravelOffers;
}

export interface ControlHost {
  start: () => Promise<void>;
  stop: () => void;
  dispatch: (raw: unknown) => DispatchResult;
  /** Confirm an active canvas version has reached the local database. Throws on uncertain ownership/save. */
  flush: (canvasId: string, version: number) => Promise<void>;
  setCardPinned: (cardId: string, pinned: boolean, canvasId?: string) => DispatchResult;
  moveCard: (cardId: string, x: number, y: number, canvasId?: string) => DispatchResult;
  /** Move a card to the user page, or back onto the Display canvas (auto-placed). */
  setCardSurface: (cardId: string, surface: CardSurface, position?: { x: number; y: number }, canvasId?: string) => DispatchResult;
  setPreferences: (patch: Partial<DisplayPreferences>) => DispatchResult;
  arrangeCanvas: () => DispatchResult;
  organizeCanvas: (options: OrganizeOptions, expectedVersion: number) => DispatchResult;
  setCardOrganization: (cardIds: string[], patch: CardOrganization, expectedCanvasId: string) => DispatchResult;
  /** Swap verified "where I am" weather into an existing live card; layout, pin and subcards stay. */
  refreshWeatherCard: (cardId: string, fields: WeatherHereFields) => DispatchResult;
  refreshTravelCard: (cardId: string) => Promise<DispatchResult>;
  setActivity: (requestId: string, activity: VivicState["activity"]) => void;
  setTargetChoice: (choice: VivicState["targetChoice"]) => void;
  undo: () => boolean;
  redo: () => boolean;
  createCanvas: (title?: string) => string;
  renameCanvas: (id: string, title: string) => void;
  deleteCanvas: (id: string) => void;
  switchCanvas: (id: string) => void;
  clearActiveCanvas: () => void;
  clearLocalData: (beforeClear?: () => Promise<void>) => Promise<DispatchResult>;
  exportActiveCanvas: () => string;
  importCanvas: (text: string) => { ok: boolean; error?: string; id?: string };
  takeover: () => void;
  getSnapshot: () => ControlSnapshot;
  subscribe: (listener: () => void) => () => void;
  checkReminders: () => Promise<void>;
}

const SUBTITLE_MAX = 120;

const SpokenEnvelopeSchema = ActionEnvelopeSchema;

export const createControlHost = (deps: ControlHostDeps): ControlHost => {
  const instanceId = deps.instanceId ?? newId("owner");
  const store = deps.store ?? canvasStore;

  const records = new Map<string, CanvasRecord>();
  const histories = new Map<string, CardHistory>();
  const historyFor = (id: string) => {
    let history = histories.get(id);
    if (!history) { history = new CardHistory(); histories.set(id, history); }
    return history;
  };
  const cardRecords = (state: VivicState) => state.cards.filter(c => !c.exitingRequestId).map(c => c.record);
  const retainRecovery = (record: CanvasRecord, previous = records.get(record.id)): CanvasRecord =>
    previous?.recovery && !record.recovery ? { ...record, recovery: previous.recovery } : record;
  const persistedVersions = new Map<string, number>();
  const repairedFitRequests = new Map<string, string>();
  // A pinned Display may manipulate a canvas while the owner works elsewhere.
  // Keep its transient view state in this owner session, never in IndexedDB.
  const inactiveViews = new Map<string, Pick<VivicState, "focus" | "lastFitRequestId">>();
  const travelRequests = new Map<string, AbortController>();
  const cancelTravelRequests = (ids: Iterable<string> = travelRequests.keys()) => {
    for (const id of ids) { travelRequests.get(id)?.abort(); travelRequests.delete(id); }
  };
  let activeCanvasId: string | null = null;
  let ready = false;
  let seqByCanvas = new Map<string, number>();
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let reminderTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reminderCheck: Promise<void> | null = null;
  let clearingLocalData = false;
  let reminderNotices: ReminderNotice[] = [];
  let reminderError: string | null = null;
  let ownerResyncing = false;
  let sessionEpoch = instanceId;
  let observedOwnerId: string | null = null;
  const now = deps.now ?? Date.now;
  let preferences: DisplayPreferences = { ...DEFAULT_DISPLAY_PREFERENCES };
  let persistedPreferences = preferences;
  let persistence: Promise<void> = Promise.resolve();
  const queueWrite = (write: () => Promise<void>): Promise<void> => {
    const acceptedEpoch = sessionEpoch;
    const next = persistence.catch(() => undefined).then(async () => {
      if (sessionEpoch !== acceptedEpoch) return;
      await write();
    });
    persistence = next;
    void next.catch(() => { reminderError = "本地保存失败，请保留控制页后重试。"; emit(); });
    return next;
  };
  const canPersist = () => ready && !stopped && !ownerResyncing && owner.mode() === "owner";
  const writable = () => canPersist() && !clearingLocalData;

  const getReminders = (): ReminderSummary[] => [...records.values()].flatMap(record => {
    const cards = record.id === activeCanvasId
      ? store.getState().cards.filter(c => !c.exitingRequestId).map(c => c.record)
      : record.cardOrder.map(id => record.cardsById[id]!);
    // Date countdowns (birthdays, exams…) are display cards, never scheduled reminders.
    return cards.filter(c => c?.type === "CountdownCard" && !isDateCountdown(c)).map(card => ({
      canvasId: record.id, canvasTitle: record.title, card: card as import("@/contracts").CountdownCard,
    }));
  });

  const listeners = new Set<() => void>();
  let uiSnapshot: ControlSnapshot = {
    preferences,
    ready: false,
    ownerMode: "readonly",
    ownerId: null,
    canvases: [],
    activeCanvasId: null,
    reminders: [],
    reminderNotices: [],
    reminderError: null,
  };

  const emit = () => {
    uiSnapshot = {
      history: activeCanvasId ? historyFor(activeCanvasId).status : { canUndo: false, canRedo: false },
      preferences,
      ready: ready && !ownerResyncing && !clearingLocalData,
      ownerMode: owner.mode(),
      ownerId: owner.mode() === "owner" ? instanceId : observedOwnerId,
      canvases: [...records.values()]
        .map(({ id, title, version, updatedAt }) => ({
          id,
          title,
          version,
          updatedAt,
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      activeCanvasId,
      reminders: getReminders(),
      reminderNotices,
      reminderError,
      ...(activeCanvasId && records.get(activeCanvasId)?.recovery ? { recovery: {
        canvasId: activeCanvasId,
        quarantinedCardCount: getCanvasRecovery(records.get(activeCanvasId)!)?.quarantinedCardCount ?? 0,
        issueCount: records.get(activeCanvasId)!.recovery!.issues.length,
      } } : {}),
    };
    listeners.forEach((l) => l());
  };

  const owner: OwnerManager = createOwnerManager({
    channel: deps.channel,
    instanceId,
    lockProvider: deps.lockProvider,
    onModeChange: mode => {
      cancelTravelRequests();
      if (mode === "owner" && ready) { sessionEpoch = newId("owner"); void refreshOwnerState(); }
      emit();
    },
  });

  async function loadPreferences() {
    const saved = await deps.db.getMeta("displayPreferences");
    try {
      const parsed = DisplayPreferencesSchema.safeParse(saved ? JSON.parse(saved) : DEFAULT_DISPLAY_PREFERENCES);
      preferences = parsed.success ? parsed.data : { ...DEFAULT_DISPLAY_PREFERENCES };
    } catch { preferences = { ...DEFAULT_DISPLAY_PREFERENCES }; }
    persistedPreferences = preferences;
    store.setPreferences(preferences);
  }

  // ------------------------------------------------------------------ persist
  const saveActiveNow = async () => {
    if (!activeCanvasId || owner.mode() !== "owner" || ownerResyncing) return;
    const canvasId = activeCanvasId;
    const meta = records.get(activeCanvasId);
    if (!meta) return;
    const record = retainRecovery(toCanvasRecord(
      activeCanvasId,
      meta.title,
      meta.version,
      store.getState(),
    ));
    records.set(activeCanvasId, record);
    await queueWrite(async () => {
      // A queued write from a demoted host must not overwrite the new owner.
      if (owner.mode() !== "owner" || ownerResyncing) return;
      await deps.db.putCanvas(record);
      persistedVersions.set(record.id, record.version);
      if (owner.mode() === "owner" && !ownerResyncing) await deps.db.setMeta("lastCanvasId", activeCanvasId ?? canvasId);
    });
    emit();
  };

  const scheduleAutosave = () => {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => void saveActiveNow().catch(() => undefined), deps.autosaveMs ?? 300);
  };

  /** Only an elected owner repairs legacy overlap, and only persisted revisions are published. */
  const repairLoadedRecords = async (loaded: CanvasRecord[]): Promise<CanvasRecord[]> => {
    if (owner.mode() !== "owner" || stopped) return loaded;
    const epoch = sessionEpoch;
    const repaired: CanvasRecord[] = [];
    for (const record of loaded) {
      const state = fromCanvasRecord(record);
      if (!hasUnpinnedOverlap(state.cards)) { repaired.push(record); continue; }
      const next = retainRecovery(toCanvasRecord(record.id, record.title, record.version + 1, { ...state, cards: relayout(state.cards) }), record);
      let saved = false;
      await queueWrite(async () => {
        if (owner.mode() !== "owner" || stopped || sessionEpoch !== epoch) return;
        await deps.db.putCanvas(next); saved = true;
      }).catch(() => { reminderError = "重叠布局暂未保存，请在画布设置中重新排布后重试。"; });
      if (saved) repairedFitRequests.set(record.id, newId("layout-repair"));
      repaired.push(saved ? next : record);
    }
    return repaired;
  };
  const restoredState = (record: CanvasRecord): VivicState => ({ ...fromCanvasRecord(record),
    lastFitRequestId: repairedFitRequests.get(record.id) ?? null,
    ...inactiveViews.get(record.id),
  });

  // ------------------------------------------------------------------ wire
  const nextSeq = (canvasId: string) => {
    const next = (seqByCanvas.get(canvasId) ?? 0) + 1;
    seqByCanvas.set(canvasId, next);
    return next;
  };

  const baseMsg = (canvasId: string, version: number) => ({
    canvasId,
    epoch: sessionEpoch,
    version,
    seq: nextSeq(canvasId),
    requestId: newId("msg"),
  });
  const postFeedback = (canvasId: string, feedback: SpaceFeedback) => {
    const record = records.get(canvasId);
    if (!record || !writable() || (persistedVersions.get(canvasId) ?? -1) < record.version) return;
    if (canvasId === activeCanvasId) emitSpaceFeedback(feedback);
    // Decorative receipts do not advance the patch stream cursor.
    deps.channel.post({ canvasId, epoch: sessionEpoch, version: record.version, seq: seqByCanvas.get(canvasId) ?? 0,
      requestId: newId("feedback"), type: "space-feedback", payload: feedback });
  };

  const snapshotPayloadFor = (canvasId: string) => {
    const meta = records.get(canvasId);
    if (!meta) return null;
    const vivicState: VivicState =
      canvasId === activeCanvasId
        ? store.toJSON()
        : restoredState(meta);
    // Don't hand a stale/expired subtitle to a freshly opened display.
    if (
      vivicState.subtitle &&
      Date.now() - vivicState.subtitle.shownAt > vivicState.subtitle.durationMs
    ) {
      vivicState.subtitle = null;
    }
    if (vivicState.activity && vivicState.activity.expiresAt <= Date.now()) {
      vivicState.activity = null;
    }
    if (vivicState.targetChoice && vivicState.targetChoice.expiresAt <= Date.now()) vivicState.targetChoice = null;
    return { title: meta.title, version: meta.version, vivicState, preferences,
      activeCanvasId: activeCanvasId ?? canvasId, ownerId: instanceId };
  };

  const postSnapshot = (canvasId: string) => {
    if (owner.mode() !== "owner" || ownerResyncing) return;
    if (preferences !== persistedPreferences) {
      void persistence.then(() => {
        if (preferences === persistedPreferences) postSnapshot(canvasId);
      }).catch(() => undefined);
      return;
    }
    const meta = records.get(canvasId);
    if (meta && meta.version > (persistedVersions.get(canvasId) ?? -1)) {
      const waitingFor = persistence;
      void waitingFor.then(() => {
        // A command can enqueue a newer write immediately after switching.
        // Follow that queue before publishing; otherwise an unpinned Display
        // ignores the new-canvas patch forever while its switch snapshot is lost.
        if (persistence !== waitingFor || (persistedVersions.get(canvasId) ?? -1) >= (records.get(canvasId)?.version ?? Infinity)) postSnapshot(canvasId);
      }).catch(() => undefined);
      return;
    }
    const payload = snapshotPayloadFor(canvasId);
    if (!payload) return;
    const msg: SyncMessage = {
      ...baseMsg(canvasId, payload.version),
      type: "snapshot",
      payload,
    };
    deps.channel.post(msg);
  };

  const unsubscribeChannel = deps.channel.subscribe((msg) => {
    if (stopped) return;
    if (msg.type === "owner") {
      const next = msg.payload.status === "off"
        ? (observedOwnerId === msg.payload.ownerId ? null : observedOwnerId)
        : msg.payload.ownerId;
      if (next !== observedOwnerId) { observedOwnerId = next; emit(); }
    }
    if (msg.type === "snapshot" && msg.payload.ownerId && msg.payload.ownerId !== observedOwnerId) {
      observedOwnerId = msg.payload.ownerId; emit();
    }
    if (msg.type === "local-data-reset" && owner.mode() === "readonly") {
      deps.onLocalDataReset?.();
      void refreshOwnerState(true);
      return;
    }
    if (msg.type === "hello" && msg.payload.role === "display") {
      postSnapshot(msg.canvasId || activeCanvasId || "");
      return;
    }
    if (msg.type === "snapshot-request") {
      postSnapshot(msg.canvasId || activeCanvasId || "");
    }
    if (msg.type === "interaction") {
      // Validate here too: custom/in-memory transports need the same boundary.
      const parsed = parseSyncMessage(msg);
      if (!parsed || parsed.type !== "interaction" || !writable()) return;
      const target = records.get(parsed.canvasId);
      if (!target || parsed.payload.ownerEpoch !== sessionEpoch || parsed.version > target.version) return;
      // Global bound, not sender-keyed: rotating sender IDs cannot bypass it.
      const stamp = now();
      if (stamp - interactionWindow >= 1000 || stamp < interactionWindow) {
        interactionWindow = stamp; interactionCount = 0;
      }
      if (++interactionCount > 24) return;
      // Drag baselines tolerate unrelated updates. Portal/view buttons refer to
      // the exact visible revision, including the source surface and focus.
      if (parsed.payload.interaction.kind !== "card.move" && parsed.version !== target.version) {
        postSnapshot(parsed.canvasId); return;
      }
      const result = applyInteraction(parsed.canvasId, parsed.requestId, parsed.payload.interaction, true);
      if (!result.ok) postSnapshot(parsed.canvasId);
    }
  });

  let interactionWindow = now();
  let interactionCount = 0;
  function applyInteraction(canvasId: string, requestId: string, raw: unknown, fromDisplay = false): DispatchResult {
    if (!writable()) return { ok: false, error: "readonly-not-owner" };
    const meta = records.get(canvasId);
    if (!meta) return { ok: false, error: "missing-canvas" };
    const targetStore = canvasId === activeCanvasId ? store : (() => {
      const replica = createCanvasStore(); replica.loadState(restoredState(meta)); return replica;
    })();
    const parsed = DisplayInteractionSchema.safeParse(raw);
    const localParsed = CanvasInteractionSchema.safeParse(raw);
    const action = parsed.success ? parsed.data : !fromDisplay && localParsed.success ? localParsed.data : null;
    const state = targetStore.getState();
    if (fromDisplay && action?.kind === "card.move" && state.cards.find(c => c.record.id === action.cardId)?.record.layout.surface === "user")
      return { ok: false, error: "not-display-card" };
    if (fromDisplay && action?.kind === "card.surface") {
      const entry = state.cards.find(c => c.record.id === action.cardId && !c.exitingRequestId);
      if (!entry) return { ok: false, error: "missing-card" };
      if ((entry.record.layout.surface ?? "display") === action.surface) return { ok: false, error: "same-surface" };
    }
    let result: DispatchResult;
    if (action?.kind === "card.focus" || action?.kind === "canvas.fit" || action?.kind === "canvas.restore") {
      if (action.kind === "card.focus") {
        const entry = state.cards.find(c => c.record.id === action.cardId && !c.exitingRequestId);
        if (!entry) return { ok: false, error: "missing-card" };
        if (entry.record.layout.surface === "user") return { ok: false, error: "not-display-card" };
        if (Object.keys(action.from).some(key => entry.record.layout[key as keyof typeof action.from] !== action.from[key as keyof typeof action.from]))
          return { ok: false, error: "layout-conflict" };
      }
      result = targetStore.dispatch({ schemaVersion: "0.6", canvasId, requestId,
        actions: [action.kind === "card.focus" ? { type: "card.focus", targetId: action.cardId } : { type: action.kind }] });
    } else result = targetStore.interact(requestId, raw);
    if (!result.ok || result.deduplicated) return result;
    const next = targetStore.getState();
    if (action?.kind === "card.move" || action?.kind === "card.pin" || action?.kind === "card.surface") {
      historyFor(canvasId).record(cardRecords(state), cardRecords(next), action.kind === "card.surface" ? "传送卡片" : action.kind === "card.pin" ? "固定卡片" : "移动卡片");
    }
    if (canvasId !== activeCanvasId) inactiveViews.set(canvasId, { focus: next.focus, lastFitRequestId: next.lastFitRequestId });
    const record = retainRecovery(toCanvasRecord(canvasId, meta.title, meta.version + 1, next));
    records.set(canvasId, record);
    emit();
    void queueWrite(async () => {
      if (!canPersist()) return;
      await deps.db.putCanvas(record);
      persistedVersions.set(record.id, record.version);
      // Persist first, then send the exact confirmed revision; a newer queued
      // revision will send its own snapshot after its write completes.
      if (writable() && records.get(canvasId)?.version === record.version) {
        postSnapshot(canvasId);
        if (action?.kind === "card.surface") postFeedback(canvasId, { kind: "transfer", cardIds: [action.cardId] });
      }
    });
    return result;
  }

  type LocalChange = { kind: "card.move"; x: number; y: number } | { kind: "card.pin"; pinned: boolean }
    | { kind: "card.surface"; surface: CardSurface; x?: number; y?: number };
  const localInteraction = (cardId: string, change: LocalChange, canvasId = activeCanvasId ?? ""): DispatchResult => {
    if (!writable()) return { ok: false, error: "readonly-not-owner" };
    const card = canvasId === activeCanvasId ? store.getState().cards.find(c => c.record.id === cardId)?.record : records.get(canvasId)?.cardsById[cardId];
    if (!card) return { ok: false, error: "missing-card" };
    const { surface: _surface, userPos: _userPos, ...from } = card.layout;
    return applyInteraction(canvasId, newId("interaction"), { ...change, cardId, from } satisfies CanvasInteraction);
  };
  const setPreferences: ControlHost["setPreferences"] = patch => {
    if (!writable()) return { ok: false, error: "readonly-not-owner" };
    const parsed = DisplayPreferencesSchema.partial().safeParse(patch);
    if (!parsed.success) return { ok: false, error: "invalid-preferences" };
    preferences = { ...preferences, ...parsed.data };
    store.setPreferences(preferences);
    emit();
    const confirmed = preferences;
    void queueWrite(async () => {
      if (!canPersist()) return;
      await deps.db.setMeta("displayPreferences", JSON.stringify(confirmed));
      persistedPreferences = confirmed;
      if (writable() && preferences === confirmed) records.forEach(record => postSnapshot(record.id));
    });
    return { ok: true, deduplicated: false };
  };
  const arrangeCanvas: ControlHost["arrangeCanvas"] = () => {
    if (!writable() || !activeCanvasId) return { ok: false, error: "readonly-not-owner" };
    const canvasId = activeCanvasId, meta = records.get(canvasId);
    if (!meta) return { ok: false, error: "missing-canvas" };
    const current = store.getState();
    const next = { ...current, cards: relayout(current.cards), focus: null, lastFitRequestId: newId("arrange") };
    historyFor(canvasId).record(cardRecords(current), cardRecords(next), "整理布局");
    store.loadState(next);
    const record = retainRecovery(toCanvasRecord(canvasId, meta.title, meta.version + 1, next));
    records.set(canvasId, record); emit();
    void queueWrite(async () => {
      if (!canPersist()) return;
      await deps.db.putCanvas(record); persistedVersions.set(canvasId, record.version);
      if (writable() && records.get(canvasId)?.version === record.version) postSnapshot(canvasId);
    });
    return { ok: true, deduplicated: false };
  };

  const commitCardState = (next: VivicState, feedback: "arrange" | "undo" | "redo" | "saved"): DispatchResult => {
    if (!writable() || !activeCanvasId) return { ok: false, error: "readonly-not-owner" };
    const id = activeCanvasId, meta = records.get(id);
    if (!meta) return { ok: false, error: "missing-canvas" };
    store.loadState(next);
    const record = retainRecovery(toCanvasRecord(id, meta.title, meta.version + 1, next));
    records.set(id, record); emit();
    void queueWrite(async () => {
      if (!canPersist()) return;
      await deps.db.putCanvas(record); persistedVersions.set(id, record.version);
      if (writable() && records.get(id)?.version === record.version) { postSnapshot(id); postFeedback(id, { kind: feedback }); }
    });
    return { ok: true, deduplicated: false };
  };
  const organizeCanvas: ControlHost["organizeCanvas"] = (raw, expectedVersion) => {
    if (!writable() || !activeCanvasId) return { ok: false, error: "readonly-not-owner" };
    const parsed = OrganizeOptionsSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "整理选项不正确。" };
    if (records.get(activeCanvasId)?.version !== expectedVersion) return { ok: false, error: "卡片已变化，请重新预览整理结果。" };
    const current = store.getState();
    const next = { ...current, cards: organizedCards(current.cards, parsed.data), focus: null, lastFitRequestId: newId("arrange") };
    historyFor(activeCanvasId).record(cardRecords(current), cardRecords(next), "排序与分区");
    return commitCardState(next, "arrange");
  };
  const setCardOrganization: ControlHost["setCardOrganization"] = (ids, raw, expectedCanvasId) => {
    if (!writable() || !activeCanvasId || activeCanvasId !== expectedCanvasId) return { ok: false, error: "画布或控制权已变化。" };
    const parsed = CardOrganizationSchema.safeParse(raw), current = store.getState();
    if (!parsed.success || !ids.length || ids.length > 200 || new Set(ids).size !== ids.length
      || ids.some(id => !current.cards.some(c => c.record.id === id && !c.exitingRequestId))) return { ok: false, error: "选中的卡片已变化。" };
    const wanted = new Set(ids);
    const cards = current.cards.map(entry => {
      if (!wanted.has(entry.record.id)) return entry;
      const metadata = { ...entry.record.metadata, ...parsed.data, updatedAt: new Date(now()).toISOString() };
      if (!metadata.section) delete metadata.section;
      if (!metadata.dueDate) delete metadata.dueDate;
      const result = CardRecordSchema.safeParse({ ...entry.record, metadata });
      return result.success ? { ...entry, record: result.data } : entry;
    });
    const next = { ...current, cards };
    historyFor(activeCanvasId).record(cardRecords(current), cardRecords(next), "卡片分类");
    return commitCardState(next, "saved");
  };

  const refreshWeatherCard: ControlHost["refreshWeatherCard"] = (cardId, fields) => {
    if (!writable() || !activeCanvasId) return { ok: false, error: "readonly-not-owner" };
    const canvasId = activeCanvasId, meta = records.get(canvasId);
    if (!meta) return { ok: false, error: "missing-canvas" };
    const current = store.getState();
    const entry = current.cards.find(c => c.record.id === cardId && !c.exitingRequestId);
    if (!entry || !isLiveWeatherCard(entry.record)) return { ok: false, error: "not-live-weather" };
    const parsed = CardRecordSchema.safeParse({ ...entry.record, displayProps: fields.displayProps,
      sourceData: fields.sourceData, sources: fields.sources,
      metadata: { ...entry.record.metadata, aliases: nextAliases(entry.record, fields.aliases), updatedAt: new Date().toISOString() } });
    // The replacement must itself be a live weather card: a refresh can never turn it into anything else.
    if (!parsed.success || !isLiveWeatherCard(parsed.data)) return { ok: false, error: "invalid-card" };
    const next = { ...current, cards: current.cards.map(c => c === entry ? { ...c, record: parsed.data } : c) };
    store.loadState(next);
    const record = retainRecovery(toCanvasRecord(canvasId, meta.title, meta.version + 1, next));
    records.set(canvasId, record); emit();
    void queueWrite(async () => {
      if (!canPersist()) return;
      await deps.db.putCanvas(record); persistedVersions.set(canvasId, record.version);
      if (writable() && records.get(canvasId)?.version === record.version) postSnapshot(canvasId);
    });
    return { ok: true, deduplicated: false };
  };

  // --------------------------------------------------------------- dispatch
  const setActivity: ControlHost["setActivity"] = (requestId, activity) => {
    if (!writable() || !activeCanvasId) return;
    if (!activity && store.getState().activity?.requestId !== requestId) return;
    store.internal({ type: "activity.set", activity });
    // Transient effects do not advance canvas patch sequence/version.
    deps.channel.post({
      type: "activity",
      canvasId: activeCanvasId,
      epoch: sessionEpoch,
      version: records.get(activeCanvasId)?.version ?? 0,
      seq: seqByCanvas.get(activeCanvasId) ?? 0,
      requestId: newId("activity"),
      payload: { requestId, activity },
    });
  };
  const setTargetChoice: ControlHost["setTargetChoice"] = choice => {
    if (!writable() || !activeCanvasId) return;
    if (choice && (!TargetChoiceSchema.safeParse(choice).success || choice.expiresAt <= Date.now()
      || choice.targets.some(id => !store.getState().cards.some(c => c.record.id === id && !c.exitingRequestId)))) return;
    store.internal({ type: "targetChoice.set", choice });
    deps.channel.post({ type: "target-choice", canvasId: activeCanvasId, epoch: sessionEpoch,
      version: records.get(activeCanvasId)?.version ?? 0, seq: seqByCanvas.get(activeCanvasId) ?? 0,
      requestId: newId("choice"), payload: { choice } });
  };
  const withSpokenSubtitle = (
    envelope: ActionEnvelope,
  ): unknown => {
    if (!envelope.spokenText?.trim()) return envelope;
    return {
      ...envelope,
      actions: [
        ...envelope.actions,
        {
          type: "subtitle.show",
          text: envelope.spokenText.trim().slice(0, SUBTITLE_MAX),
        },
      ],
    };
  };

  const applyCanvasOps = (envelope: ActionEnvelope) => {
    for (const action of envelope.actions) {
      if (action.type === "canvas.create") {
        if (!records.has(action.canvasId)) {
          const record: CanvasRecord = {
            id: action.canvasId,
            title: action.title,
            version: 0,
            updatedAt: new Date().toISOString(),
            cardsById: {},
            cardOrder: [],
            viewport: { x: 0, y: 0, zoom: 1 },
            focusHistory: [],
            processedRequestIds: [],
          };
          records.set(action.canvasId, record);
          void queueWrite(async () => {
            if (!canPersist()) return;
            await deps.db.putCanvas(record); persistedVersions.set(record.id, record.version);
          });
          emit();
        }
      }
      if (action.type === "canvas.switch") {
        switchCanvas(action.canvasId);
      }
    }
  };

  const dispatch = (raw: unknown, authority: "user" | "provider" = "user"): DispatchResult => {
    if (!writable()) {
      return { ok: false, error: "readonly-not-owner" };
    }
    const parsed = SpokenEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "invalid",
      };
    }
    let envelope: ActionEnvelope = parsed.data;
    // Never apply an envelope for another canvas to the active canvas store.
    if (envelope.canvasId !== activeCanvasId) return { ok: false, error: "wrong-canvas" };
    if (store.getState().processedRequestIds.includes(envelope.requestId)) return { ok: true, deduplicated: true };
    const policyIssue = envelopeCardPolicyIssue(envelope, store.getState().cards.map(entry => entry.record), validateExtensionCard, authority);
    if (policyIssue) return { ok: false, error: policyIssue };
    if (authority === "user") {
      const invalidated = envelope.actions.flatMap(action => action.type === "card.delete" ? [action.targetId]
        : action.type === "cards.delete" ? action.targetIds : action.type === "card.create" ? [action.card.id] : []);
      cancelTravelRequests(invalidated);
    }
    if (envelope.actions.some(action => action.type === "canvas.switch")) {
      if (envelope.actions.some(action => action.type !== "canvas.switch" && action.type !== "canvas.create"))
        return { ok: false, error: "mixed-canvas-routing" };
      const result = store.dispatch(envelope);
      if (result.ok && !result.deduplicated) applyCanvasOps(envelope);
      return result;
    }
    if (envelope.spokenText?.trim()) {
      const re = SpokenEnvelopeSchema.safeParse(withSpokenSubtitle(envelope));
      if (re.success) envelope = re.data;
    }
    applyCanvasOps(envelope);
    const beforeCards = cardRecords(store.getState());
    const result = store.dispatch(envelope);
    if (result.ok && !result.deduplicated) {
      const targetId = envelope.canvasId || activeCanvasId;
      if (targetId) {
        const previous = records.get(targetId);
        const meta = previous ? { ...previous, version: previous.version + 1, updatedAt: new Date().toISOString() } : undefined;
        if (meta) records.set(targetId, meta);
        const version = meta?.version ?? 0;
        // Control runs no view layer, so the window-local delete-exit commit
        // displays perform after their animation is committed instantly here
        // — otherwise the undo stack would fill late and a quick 撤销 click
        // would find nothing to restore.
        if (envelope.actions.some((a) => a.type === "card.delete" || a.type === "cards.delete")) {
          store.internal({
            type: "card.delete.commit",
            requestId: envelope.requestId,
          });
        }
        if (authority === "user") historyFor(targetId).record(beforeCards, cardRecords(store.getState()),
          envelope.actions.some(a => a.type === "card.delete" || a.type === "cards.delete") ? "删除卡片"
            : envelope.actions.some(a => a.type === "card.create") ? "创建卡片" : "编辑卡片");
        if (store.getState().stage === "AWAKENING") {
          setTimeout(
            () => store.internal({ type: "stage.awakening.complete" }),
            1200,
          );
        }
        // Card changes immediately enter the IDB write queue. A takeover
        // reader must not reload an older, debounced copy of a delivered timer.
        const saving = saveActiveNow();
        // Publish the accepted in-memory revision synchronously. Callers still
        // require flush() before a durable receipt; leased multi-step writers
        // must not mistake their own later save notification for an outside edit.
        emit();
        void saving.then(() => {
          if (!writable()) return;
          deps.channel.post({ ...baseMsg(targetId, version), type: "patch", payload: { envelope } });
          if (envelope.actions.some(a => ["card.create", "card.update", "card.subcard.set", "card.subcard.delete"].includes(a.type))) postFeedback(targetId, { kind: "saved" });
        }).catch(() => undefined);
      }
    }
    return result;
  };

  const refreshTravelCard: ControlHost["refreshTravelCard"] = async cardId => {
    if (!writable()) return { ok: false, error: "readonly-not-owner" };
    const original = store.getState().cards.find(entry => entry.record.id === cardId && !entry.exitingRequestId)?.record;
    if (original?.type !== "TravelOffersCard") return { ok: false, error: "missing-travel-card" };
    travelRequests.get(cardId)?.abort();
    const controller = new AbortController(), acceptedEpoch = sessionEpoch, canvasId = activeCanvasId;
    travelRequests.set(cardId, controller);
    try {
      const result = await (deps.travelRefresh ?? fetchTravelOffers)(original.displayProps.query,
        AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
      if (controller.signal.aborted || travelRequests.get(cardId) !== controller || !writable()
        || sessionEpoch !== acceptedEpoch || activeCanvasId !== canvasId) return { ok: false, error: "旧查询结果已丢弃。" };
      if (!result.ok) return result;
      const responseQuery = TravelQuerySchema.safeParse(result.card.displayProps.query);
      if (!responseQuery.success || JSON.stringify(responseQuery.data) !== JSON.stringify(original.displayProps.query))
        return { ok: false, error: "服务返回的查询条件与本次请求不一致，未修改卡片。" };
      const current = store.getState().cards.find(entry => entry.record.id === cardId && !entry.exitingRequestId)?.record;
      if (current?.type !== "TravelOffersCard" || JSON.stringify(current.displayProps.query) !== JSON.stringify(original.displayProps.query))
        return { ok: false, error: "卡片或查询已改变，旧结果已丢弃。" };
      const parsed = CardRecordSchema.safeParse({ ...current,
        displayProps: { ...result.card.displayProps, notes: current.displayProps.notes,
          selectedIds: current.displayProps.selectedIds.filter(id => result.card.displayProps.items.some(item => item.id === id)) },
        sourceData: result.card.sourceData, sources: result.card.sources,
        metadata: { ...current.metadata, updatedAt: new Date(now()).toISOString() },
      });
      if (!parsed.success) return { ok: false, error: "刷新结果未通过校验。" };
      // Provider authority is held only by this validated, generation-checked callback.
      return dispatch({ schemaVersion: "0.6", requestId: newId("travel-refresh"), canvasId,
        actions: [{ type: "card.create", card: parsed.data }] }, "provider");
    } catch { return { ok: false, error: controller.signal.aborted ? "查询已取消。" : "旅游查询暂不可用，请重试。" }; }
    finally { if (travelRequests.get(cardId) === controller) travelRequests.delete(cardId); }
  };

  // ------------------------------------------------------------ canvas CRUD
  function switchCanvas(id: string) {
    if (!writable()) return;
    if (id === activeCanvasId) return;
    if (!records.has(id)) return;
    cancelTravelRequests();
    const activity = store.getState().activity;
    if (activity) setActivity(activity.requestId, null);
    void saveActiveNow().catch(() => undefined);
    let record = records.get(id);
    if (!record) return; // UI only offers existing canvases
    activeCanvasId = id;
    store.loadState(restoredState(record));
    inactiveViews.delete(id);
    void queueWrite(async () => {
      if (canPersist()) await deps.db.setMeta("lastCanvasId", activeCanvasId ?? id);
    });
    emit();
    // Unpinned displays follow the owner's active canvas.
    postSnapshot(id);
  }

  const createCanvas = (title = "新画布"): string => {
    const id = newId("canvas");
    dispatch({
      schemaVersion: "0.6",
      requestId: newId("req"),
      canvasId: activeCanvasId ?? id,
      actions: [{ type: "canvas.create", canvasId: id, title }],
    });
    return id;
  };

  const renameCanvas = (id: string, title: string) => {
    if (!writable()) return;
    const trimmed = title.trim();
    const previous = records.get(id);
    if (!previous || !trimmed || trimmed.length > 120) return;
    const meta = { ...previous, title: trimmed, version: previous.version + 1, updatedAt: new Date().toISOString() };
    records.set(id, meta);
    if (id === activeCanvasId) scheduleAutosave();
    else void queueWrite(async () => {
      if (!canPersist()) return;
      await deps.db.putCanvas(meta); persistedVersions.set(meta.id, meta.version);
    });
    emit();
    postSnapshot(id);
  };

  const deleteCanvas = (id: string) => {
    if (!writable()) return;
    if (!records.has(id)) return;
    records.delete(id);
    histories.delete(id);
    inactiveViews.delete(id);
    void queueWrite(async () => {
      if (!canPersist()) return;
      await deps.db.deleteCanvas(id); persistedVersions.delete(id);
    });
    if (id === activeCanvasId) {
      const next = [...records.keys()][0];
      if (next) {
        activeCanvasId = null; // force re-hydrate even if same id edge
        switchCanvas(next);
      } else {
        const freshId = newId("canvas");
        const fresh: CanvasRecord = {
          id: freshId,
          title: "默认画布",
          version: 0,
          updatedAt: new Date().toISOString(),
          cardsById: {},
          cardOrder: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          focusHistory: [],
          processedRequestIds: [],
        };
        records.set(freshId, fresh);
        void queueWrite(async () => {
          if (!canPersist()) return;
          await deps.db.putCanvas(fresh); persistedVersions.set(fresh.id, fresh.version);
        });
        activeCanvasId = null;
        switchCanvas(freshId);
      }
    }
    emit();
  };

  const clearActiveCanvas = () => {
    if (!writable()) return;
    if (!activeCanvasId) return;
    const meta = records.get(activeCanvasId);
    if (!meta) return;
    cancelTravelRequests();
    historyFor(activeCanvasId).record(cardRecords(store.getState()), [], "清空画布");
    store.loadState(emptyVivicState());
    records.set(activeCanvasId, { ...meta, version: meta.version + 1, updatedAt: new Date().toISOString() });
    void saveActiveNow().catch(() => undefined);
    emit();
    postSnapshot(activeCanvasId); // displays replace state, no replay
  };

  const clearLocalData: ControlHost["clearLocalData"] = async beforeClear => {
    if (!writable()) return { ok: false, error: "readonly-not-owner" };
    cancelTravelRequests();
    const acceptedEpoch = sessionEpoch;
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    // Save accepted edits before blocking new ones; a cache failure must not
    // discard a just-created canvas, rename, position or preference change.
    const acceptedSave = saveActiveNow();
    clearingLocalData = true; emit();
    const stillOwner = () => !stopped && owner.mode() === "owner" && sessionEpoch === acceptedEpoch;
    try {
      // Drain both queued saves and a scheduler's direct inbox transaction.
      await acceptedSave; await persistence; await reminderCheck;
      if (!stillOwner()) return { ok: false, error: "readonly-not-owner" };
      await beforeClear?.();
      if (!stillOwner()) return { ok: false, error: "readonly-not-owner" };
      const fresh = toCanvasRecord(newId("canvas"), "默认画布", 0, emptyVivicState());
      await deps.db.reset(fresh);
      if (!stillOwner()) return { ok: false, error: "readonly-not-owner" };
      records.clear(); records.set(fresh.id, fresh); histories.clear();
      inactiveViews.clear();
      persistedVersions.clear(); persistedVersions.set(fresh.id, 0);
      repairedFitRequests.clear(); seqByCanvas.clear();
      activeCanvasId = fresh.id;
      reminderNotices = []; reminderError = null;
      preferences = { ...DEFAULT_DISPLAY_PREFERENCES }; persistedPreferences = preferences;
      store.setPreferences(preferences); store.loadState(emptyVivicState());
      sessionEpoch = newId("owner");
      deps.channel.post({ ...baseMsg(fresh.id, 0), type: "local-data-reset", payload: { ownerId: instanceId } });
      return { ok: true, deduplicated: false };
    } catch {
      return { ok: false, error: "清除未完成，请检查本地存储后重试。" };
    } finally {
      clearingLocalData = false; emit();
      if (writable() && activeCanvasId) postSnapshot(activeCanvasId);
    }
  };

  const exportActiveCanvas = (): string => {
    const meta = activeCanvasId ? records.get(activeCanvasId) : undefined;
    const record =
      activeCanvasId && meta
        ? retainRecovery(toCanvasRecord(activeCanvasId, meta.title, meta.version, store.getState()))
        : undefined;
    return record ? JSON.stringify(toCanvasFile(record), null, 2) : "";
  };

  const importCanvas = (text: string) => {
    if (!writable()) return { ok: false, error: "readonly-not-owner" };
    const parsed = parseCanvasFile(text);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    let id = newId("canvas");
    // Card ids may collide with an existing canvas's card ids only within
    // their own record; canvas id itself is always fresh.
    let record = fileToCanvasRecord(parsed.file, id);
    const imported = fromCanvasRecord(record);
    if (hasUnpinnedOverlap(imported.cards)) record = retainRecovery(toCanvasRecord(id, record.title, record.version, { ...imported, cards: relayout(imported.cards) }), record);
    records.set(id, record);
    void queueWrite(async () => {
      if (!canPersist()) return;
      await deps.db.putCanvas(record); persistedVersions.set(record.id, record.version);
    });
    emit();
    return { ok: true, id };
  };

    const undo = (): boolean => {
    if (!writable()) return false;
    if (!activeCanvasId) return false;
    const current = store.getState(), cards = historyFor(activeCanvasId).undo(cardRecords(current));
    if (!cards) return false;
    return commitCardState({ ...current, cards: cards.map(record => ({ record })), undoStack: [], pendingDeletes: {},
      focus: null, highlight: null, targetChoice: null, focusHistory: current.focusHistory.filter(id => cards.some(c => c.id === id)),
      stage: cards.length ? "WORKSPACE" : current.stage }, "undo").ok;
  };
  const redo = (): boolean => {
    if (!writable() || !activeCanvasId) return false;
    const current = store.getState(), cards = historyFor(activeCanvasId).redo(cardRecords(current));
    if (!cards) return false;
    return commitCardState({ ...current, cards: cards.map(record => ({ record })), undoStack: [], pendingDeletes: {},
      focus: null, highlight: null, targetChoice: null, focusHistory: current.focusHistory.filter(id => cards.some(c => c.id === id)),
      stage: cards.length ? "WORKSPACE" : current.stage }, "redo").ok;
  };

  // ----------------------------------------------------------------- lifecycle
  async function refreshOwnerState(allowReadonly = false) {
    histories.clear();
    ownerResyncing = true;
    let restored = false;
    emit();
    try {
      const all = await repairLoadedRecords(await deps.db.getAllCanvases());
      const last = await deps.db.getMeta("lastCanvasId");
      const inbox = await deps.db.getMeta("reminderInbox");
      await loadPreferences();
      if (stopped || (!allowReadonly && owner.mode() !== "owner")) return;
      records.clear();
      inactiveViews.clear();
      all.forEach(record => records.set(record.id, record));
      persistedVersions.clear();
      all.forEach(record => persistedVersions.set(record.id, record.version));
      activeCanvasId = last && records.has(last) ? last : all[0]?.id ?? null;
      if (activeCanvasId) store.loadState(restoredState(records.get(activeCanvasId)!));
      reminderNotices = [];
      if (inbox) {
        const parsed = ReminderInboxSchema.safeParse(JSON.parse(inbox));
        if (parsed.success) reminderNotices = parsed.data;
      }
      seqByCanvas = new Map();
      restored = true;
    } catch {
      reminderError = "接管后无法恢复最新画布，请刷新控制页后重试。";
    } finally {
      ownerResyncing = !restored && owner.mode() === "owner";
      emit();
      if (!stopped && owner.mode() === "owner" && activeCanvasId) postSnapshot(activeCanvasId);
    }
  }

  const updateReminder = async (item: ReminderSummary, patch: Partial<CountdownCard["sourceData"]>, highlight = false) => {
    if (!writable()) return;
    if (item.canvasId === activeCanvasId) {
      dispatch({ schemaVersion: "0.6", requestId: newId("reminded"), canvasId: item.canvasId,
        actions: [{ type: "card.update", targetId: item.card.id, sourceData: patch },
          ...(highlight ? [{ type: "card.highlight" as const, targetId: item.card.id, durationMs: 8000 }] : [])] }, "provider");
      await saveActiveNow();
    } else {
      const record = records.get(item.canvasId), card = record?.cardsById[item.card.id];
      if (!record || card?.type !== "CountdownCard") return;
      const updated: CanvasRecord = { ...record, version: record.version + 1, updatedAt: new Date(now()).toISOString(),
        cardsById: { ...record.cardsById, [card.id]: { ...card, sourceData: { ...card.sourceData, ...patch } } } };
      records.set(item.canvasId, updated);
      await queueWrite(async () => { if (!canPersist()) return; await deps.db.putCanvas(updated); persistedVersions.set(updated.id, updated.version); });
      if (records.get(item.canvasId) === updated) postSnapshot(item.canvasId);
    }
  };

  let presentationCanvas: string | null = null;
  let presentationIds = new Set<string>();
  let presentationKnownIds = new Set<string>();
  const runReminderCheck = async () => {
    try {
      await persistence;
      if (!writable()) return;
      // A long reminder enters the near-term canvas when it crosses one hour.
      // Refresh only on membership changes, and resolve collisions as owner.
      const state = store.getState();
      const visible = new Set(presentCards(state.cards, { focusId: state.focus?.cardId, now: now() }).flatMap(item => item.memberIds));
      const entering = presentationCanvas === activeCanvasId && [...visible].some(id => presentationKnownIds.has(id) && !presentationIds.has(id));
      presentationCanvas = activeCanvasId; presentationIds = visible;
      presentationKnownIds = new Set(state.cards.map(c => c.record.id));
      if (entering && activeCanvasId) {
        const id = activeCanvasId, meta = records.get(id);
        store.loadState({ ...state, cards: hasUnpinnedOverlap(state.cards) ? relayout(state.cards) : [...state.cards] });
        if (meta) records.set(id, { ...meta, version: meta.version + 1 });
        await saveActiveNow();
        if (!writable()) return;
        if (activeCanvasId === id) postSnapshot(id);
      }
      for (const item of getReminders()) {
        const record = records.get(item.canvasId);
        const cards = item.canvasId === activeCanvasId ? store.getState().cards.filter(c => !c.exitingRequestId).map(c => c.record)
          : record ? record.cardOrder.map(id => record.cardsById[id]!) : [];
        if (conditionSatisfied(item.card, cards)) await updateReminder(item, {
          conditionMetAt: new Date(now()).toISOString(), targetAt: new Date(now() + item.card.sourceData.condition!.delaySeconds * 1000).toISOString(), notifiedAt: null,
        });
      }
      const due = getReminders().filter(item => isDue(item.card, now()));
      if (!due.length) return;
      const fresh = due.filter(item => !reminderNotices.some(n => sameDelivery(n, item))).map(item => ({
        id: newId("due"), canvasId: item.canvasId, canvasTitle: item.canvasTitle,
        cardId: item.card.id, text: reminderText(item.card),
        targetAt: item.card.sourceData.targetAt, firedAt: new Date(now()).toISOString(),
      }));
      // Save the visible inbox before claiming delivery, so a reload cannot
      // silently lose an already claimed reminder. No secrets in these records.
      if (fresh.length) {
        const next = [...reminderNotices, ...fresh].slice(-50);
        await deps.db.setMeta("reminderInbox", JSON.stringify(next));
        if (!writable()) return;
        reminderNotices = next;
      }
      for (const item of due) {
        if (!writable()) return;
        // The user may delete, pause or reschedule while persistence awaits.
        const current = getReminders().find(r => r.canvasId === item.canvasId && r.card.id === item.card.id);
        if (!current || current.card.sourceData.targetAt !== item.card.sourceData.targetAt || !isDue(current.card, now())) continue;
        const firedAt = new Date(now()).toISOString(), schedule = current.card.sourceData.schedule;
        await updateReminder(current, { lastFiredAt: firedAt, lastDeliveredTargetAt: current.card.sourceData.targetAt,
          ...(schedule ? { targetAt: nextReminderOccurrence(schedule, current.card.sourceData.targetAt, now()), notifiedAt: null } : { notifiedAt: firedAt }) }, true);
      }
      const reportable = fresh.filter(notice => getReminders().some(item =>
        notice.canvasId === item.canvasId && notice.cardId === item.card.id && deliveredNoticeCurrent(notice, item.card)));
      const stale = new Set(fresh.filter(n => !reportable.includes(n)).map(n => n.id));
      if (stale.size) {
        reminderNotices = reminderNotices.filter(n => !stale.has(n.id));
        await deps.db.setMeta("reminderInbox", JSON.stringify(reminderNotices));
      }
      if (writable()) {
        reportable.forEach(notifyReminder);
        if (reportable.length) playReminderSound();
      }
      if (reportable.length && activeCanvasId && owner.mode() === "owner") {
        const text = reportable.length === 1 ? `提醒：${reportable[0]!.text}`
          : `${reportable.length}项提醒到时间了：${reportable.map(n => n.text).join("；")}`;
        dispatch({ schemaVersion: "0.6", requestId: newId("alert"), canvasId: activeCanvasId,
          actions: [{ type: "subtitle.show", text: text.slice(0, 120), durationMs: 10000, priority: "reminder" }],
        });
      }
      reminderError = null;
      emit();
    } catch {
      reminderError = "提醒记录暂时无法保存，请保留控制页并检查本地存储。";
      emit();
    }
  };

  const checkReminders = (): Promise<void> => {
    if (!writable() || reminderCheck) return reminderCheck ?? Promise.resolve();
    reminderCheck = runReminderCheck().finally(() => { reminderCheck = null; });
    return reminderCheck;
  };

  const start = async () => {
    await owner.start();
    await extensionDefinitions.ready();
    await loadPreferences();
    const inbox = await deps.db.getMeta("reminderInbox");
    if (inbox) {
      try { const parsed = ReminderInboxSchema.safeParse(JSON.parse(inbox));
        if (parsed.success) reminderNotices = parsed.data;
      } catch { /* A corrupt optional inbox must not prevent opening canvases. */ }
    }
    const all = await repairLoadedRecords(await deps.db.getAllCanvases());
    all.forEach((r) => records.set(r.id, r));
    all.forEach((r) => persistedVersions.set(r.id, r.version));
    if (records.size === 0 && owner.mode() === "owner") {
      const fresh: CanvasRecord = {
        id: newId("canvas"),
        title: "默认画布",
        version: 0,
        updatedAt: new Date().toISOString(),
        cardsById: {},
        cardOrder: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        focusHistory: [],
        processedRequestIds: [],
      };
      records.set(fresh.id, fresh);
      await deps.db.putCanvas(fresh);
      persistedVersions.set(fresh.id, fresh.version);
    }
    const last = await deps.db.getMeta("lastCanvasId");
    activeCanvasId = last && records.has(last) ? last : [...records.keys()][0] ?? null;
    if (activeCanvasId) {
      store.loadState(restoredState(records.get(activeCanvasId)!));
      if (owner.mode() === "owner") await deps.db.setMeta("lastCanvasId", activeCanvasId);
    }
    ready = true;
    emit();
    if (activeCanvasId && owner.mode() === "owner") postSnapshot(activeCanvasId);
    reminderTimer = setInterval(() => void checkReminders(), deps.reminderPollMs ?? 500);
    heartbeatTimer = setInterval(() => {
      if (!writable()) return;
      deps.channel.post({ type: "owner", canvasId: "", epoch: instanceId,
        version: 0, seq: 0, requestId: newId("heartbeat"), payload: { status: "on", ownerId: instanceId } });
    }, 1200);
  };

  const stop = () => {
    stopped = true;
    for (const controller of travelRequests.values()) controller.abort();
    travelRequests.clear();
    if (reminderTimer) clearInterval(reminderTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (autosaveTimer) clearTimeout(autosaveTimer);
    void saveActiveNow().catch(() => undefined);
    unsubscribeChannel();
    owner.stop();
  };

  return {
    start,
    stop,
    dispatch: raw => dispatch(raw),
    flush: async (canvasId, version) => {
      const epoch = sessionEpoch;
      if (!canPersist() || activeCanvasId !== canvasId) throw new Error("save_scope_changed");
      await saveActiveNow();
      await persistence;
      if (!canPersist() || sessionEpoch !== epoch || activeCanvasId !== canvasId
        || (persistedVersions.get(canvasId) ?? -1) < version) throw new Error("save_unconfirmed");
    },
    refreshTravelCard,
    setCardPinned: (cardId, pinned, canvasId) => localInteraction(cardId, { kind: "card.pin", pinned }, canvasId),
    moveCard: (cardId, x, y, canvasId) => localInteraction(cardId, { kind: "card.move", x, y }, canvasId),
    setCardSurface: (cardId, surface, position, canvasId) => localInteraction(cardId, { kind: "card.surface", surface,
      ...(position ? { x: Math.round(position.x), y: Math.round(position.y) } : {}) }, canvasId),
    setPreferences,
    arrangeCanvas,
    organizeCanvas,
    setCardOrganization,
    refreshWeatherCard,
    setActivity,
    setTargetChoice,
    checkReminders,
    undo,
    redo,
    createCanvas,
    renameCanvas,
    deleteCanvas,
    switchCanvas,
    clearActiveCanvas,
    clearLocalData,
    exportActiveCanvas,
    importCanvas,
    takeover: () => owner.takeover(),
    getSnapshot: () => uiSnapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
