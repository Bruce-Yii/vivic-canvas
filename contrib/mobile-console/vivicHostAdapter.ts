import { CardPreviewSchema, FilePreviewSchema, SubcardPreviewSchema, ImagePreviewSchema, type CanvasSnapshot, type CardPreview, type CardSnapshot, type FileChunkData } from "./protocol";
import type { ComputerHostAdapter } from "./connector";
import { z } from "zod";

/** Structural subset of the existing ControlHost, not another owner implementation. */
export interface ExistingHost {
  getSnapshot(): {
    ready: boolean; ownerMode: string; ownerId: string | null;
    activeCanvasId: string | null;
    canvases: Array<{ id: string; title: string; version: number }>;
  };
  subscribe(listener: () => void): () => void;
  switchCanvas(id: string): void;
  setCardPinned(cardId: string, pinned: boolean, canvasId?: string): { ok: boolean };
  setCardSurface?(cardId: string, surface: "display" | "user", position?: { x: number; y: number }, canvasId?: string): { ok: boolean };
  flush?(canvasId: string, version: number): Promise<void>;
}
export interface ExistingCard {
  record: { id: string; type: string; layout: { pinned: boolean; surface?: "display" | "user" }; displayProps?: unknown; sourceData?: unknown; metadata?: unknown };
  exitingRequestId?: string;
}
export interface TextExecutionContext {
  /** Trusted connector scope, not supplied by phone payloads. */
  conversationId?: string;
  withCommit?<T>(write: () => T): T;
  requestId: string;
  signal: AbortSignal;
  /** The existing request entry MUST call this immediately before every dispatch. */
  isCurrent(): boolean;
}
export interface VivicHostAdapterOptions {
  /** A fresh attachment lease prevents commands from an old page being replayed after reload. */
  connectionEpoch?: string;
  host: ExistingHost;
  computerName: string;
  /** Explicitly opt into sharing the current Space's visible text with paired devices. */
  shareCardPreviews?: boolean;
  /** The Web host verifies the exact installed builtin definition/hash before Office projection. */
  isOfficeDefinition?(ref: unknown): boolean;
  /** Host validates current anchors against cardTargets; only visible label/text may leave it. */
  projectSubcards?(record: ExistingCard["record"]): unknown;
  readFileChunk?(canvasId: string, cardId: string, offset: number): Promise<FileChunkData>;
  projectImages?(record: ExistingCard["record"]): { images?: unknown; imageNotice?: string };
  readImageChunk?(canvasId: string, cardId: string, imageId: string, offset: number): Promise<FileChunkData>;
  readCards(): ExistingCard[];
  subscribeCards(listener: () => void): () => void;
  /** Must resolve on actual execution, never on request enqueue/HTTP acceptance. */
  submitText(text: string, context: TextExecutionContext): Promise<{ ok: boolean; message: string }>;
}

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const rawText = (value: unknown) => typeof value === "string" ? value : "";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const LABELS: Record<string, string> = { NoteCard: "便笺", TodoCard: "待办", CountdownCard: "倒计时", WeatherCard: "天气", TableCard: "表格", ChartCard: "图表", SearchResultCard: "搜索结果", QuoteCard: "金句", PaperCard: "文献", GalleryCard: "照片墙", WeeklyScheduleCard: "周计划", RoadmapCard: "路线图", NewsCard: "资讯", TimelineCard: "时间线", StoryCarouselCard: "照片故事", ActivityFeedCard: "动态", ProgressRingCard: "目标进度", HabitHeatmapCard: "习惯打卡", BookCard: "书籍", MonthCalendarCard: "月历", ComparisonCard: "方案对比", LinkPreviewCard: "链接收藏", PhotoCoverCard: "照片纪念", NotificationCard: "通知", TravelOffersCard: "旅游结果", ExtensionCard: "扩展卡片" };
const OFFICE_IDS = new Set(["vivic.office-tasks", "vivic.office-meeting", "vivic.office-week"]);
const TimerDate = z.iso.datetime({ offset: true });

/** Whitelisted display fields only: never recursively walk a record or arbitrary extension data. */
function visibleCard(record: ExistingCard["record"], isOfficeDefinition?: (ref: unknown) => boolean): Pick<CardSnapshot, "title" | "preview"> {
  const p = fields(record.displayProps);
  let truncated = false;
  const text = (value: unknown, max = 6000) => { const valueText = rawText(value); if (valueText.length > max) truncated = true; return valueText.slice(0, max); };
  const headline = (value: unknown) => rawText(value).slice(0, 160);
  const scalar = (value: unknown, max = 256) => text(typeof value === "string" ? value : finite(value) || typeof value === "boolean" ? String(value) : "—", max);
  const join = (values: unknown[], max = 6000, separator = " · ") => text(values.filter(value => typeof value === "string" && value).join(separator), max);
  const list = (value: unknown, max = 40): unknown[] => { if (!Array.isArray(value)) return []; if (value.length > max) truncated = true; return value.slice(0, max); };
  const items = (value: unknown, project: (item: Fields) => NonNullable<CardPreview["items"]>[number]) =>
    list(value).map(value => project(fields(value))).filter(item => item.text);
  const item = (value: unknown, meta: unknown[] = [], checked?: unknown) => ({ text: text(value, 600),
    ...(join(meta, 240) ? { meta: join(meta, 240) } : {}), ...(typeof checked === "boolean" ? { checked } : {}) });
  let title = headline(p.title) || LABELS[record.type] || record.type.slice(0, 160);
  let preview: CardPreview | undefined;
  switch (record.type) {
    case "FileCard": {
      title = headline(p.name) || "文件";
      break;
    }
    case "NoteCard": {
      const bullets = list(p.bullets).map(value => item(value)).filter(row => row.text);
      title = headline(p.text) || bullets[0]?.text.slice(0, 160) || title;
      preview = { kind: "text", body: text(p.text), ...(bullets.length ? { items: bullets } : {}) }; break;
    }
    case "TodoCard": {
      const rows = items(p.items, row => item(row.text, [], row.done));
      title = headline(p.title) || rows[0]?.text.slice(0, 160) || title;
      preview = { kind: "checklist", items: rows }; break;
    }
    case "CountdownCard": {
      // These are the only sourceData fields copied: visible timer/date-reminder text.
      const source = fields(record.sourceData), event = fields(source.event);
      title = headline(event.title || source.reminderText) || title;
      if (rawText(event.date)) preview = { kind: "text", body: join([event.date, event.time, event.note]) };
      else {
        const targetAt = rawText(source.targetAt), pausedAt = rawText(source.pausedAt);
        if (!TimerDate.safeParse(targetAt).success || (pausedAt && !TimerDate.safeParse(pausedAt).success)) break;
        const target = Date.parse(targetAt);
        const at = rawText(source.pausedAt) ? Date.parse(rawText(source.pausedAt)) : Date.now();
        if (Number.isFinite(target) && Number.isFinite(at)) {
          const remaining = Math.max(0, Math.ceil((target - at) / 1000));
          const two = (value: number) => String(value).padStart(2, "0");
          const waiting = Boolean(source.condition && !source.conditionMetAt);
          const value = waiting ? "等待" : remaining >= 3600 ? `${Math.floor(remaining / 3600)}:${two(Math.floor(remaining / 60) % 60)}:${two(remaining % 60)}` : `${two(Math.floor(remaining / 60))}:${two(remaining % 60)}`;
          preview = { kind: "metric", stat: { value }, body: join([source.reminderText, rawText(source.pausedAt) ? "已暂停" : "", `到期：${rawText(source.targetAt)}`]) };
        }
      } break;
    }
    case "WeatherCard": {
      const conditions: Record<string, string> = { sun: "晴", cloud: "多云", rain: "雨", snow: "雪", wind: "风", fog: "雾", storm: "雷暴", night: "夜间" };
      if (finite(p.tempC) && p.tempC >= -100 && p.tempC <= 65) preview = { kind: "metric", stat: { value: String(p.tempC), unit: "°C" }, body: conditions[rawText(p.conditionIcon)] ?? "" }; break;
    }
    case "TableCard": preview = { kind: "table", columns: list(p.columns, 12).map(value => text(value, 100)), rows: list(p.rows).map(row => list(row, 12).map(value => scalar(value))) }; break;
    case "ChartCard": preview = { kind: "chart", body: join([p.xLabel, p.yLabel]), series: list(p.points, 32).flatMap(value => { const point = fields(value); return finite(point.y) && (typeof point.x === "string" || finite(point.x)) ? [{ label: scalar(point.x, 100), value: point.y }] : []; }) }; break;
    case "QuoteCard": title = headline(p.text) || title; preview = { kind: "text", body: text(p.text), items: [item(p.author, [p.tag])].filter(row => row.text) }; break;
    case "SearchResultCard": preview = { kind: "text", body: text(p.summary) }; break;
    case "PaperCard": preview = { kind: "text", body: text(p.abstract), items: list(p.keyPoints).map(value => item(value)).filter(row => row.text) }; break;
    case "GalleryCard": {
      const images = Array.isArray(p.images) ? p.images : [];
      preview = { kind: "collection", body: `${images.length} 张照片`, items: items(images, image => item(image.caption || image.alt)) }; break;
    }
    case "WeeklyScheduleCard": {
      const events = list(p.events, 60).map(fields).sort((a, b) => (finite(a.day) ? a.day : 0) - (finite(b.day) ? b.day : 0)
        || (rawText(a.start) ? 1 : 0) - (rawText(b.start) ? 1 : 0) || rawText(a.start).localeCompare(rawText(b.start)));
      preview = { kind: "timeline", body: text(p.weekStart), items: items(events, event => item(event.title, [finite(event.day) ? `周${["一", "二", "三", "四", "五", "六", "日"][event.day - 1] ?? event.day}` : "", join([event.start, event.end], 80, "–"), event.location], event.done)) }; break;
    }
    case "RoadmapCard": {
      const rows: NonNullable<CardPreview["items"]> = [];
      for (const value of list(p.phases)) {
        const phase = fields(value); rows.push(item(phase.name, [phase.period, phase.status, phase.goal]));
        rows.push(...items(phase.milestones, milestone => item(milestone.text, [], milestone.done)));
      }
      preview = { kind: "timeline", items: list(rows).map(row => row as NonNullable<CardPreview["items"]>[number]) }; break;
    }
    case "NewsCard": title = headline(p.headline) || title; preview = { kind: "text", body: text(p.summary), items: list(p.keyPoints).map(value => item(value)).filter(row => row.text) }; break;
    case "TimelineCard": {
      const events = list(p.events).map(fields).sort((a, b) => rawText(a.date).localeCompare(rawText(b.date)));
      if (p.order === "desc") events.reverse();
      preview = { kind: "timeline", items: items(events, event => item(join([event.title, event.description], 600, "\n"), [event.date])) }; break;
    }
    case "StoryCarouselCard": preview = { kind: "collection", items: items(p.slides, slide => item(join([slide.heading, slide.text], 600, "\n"))) }; break;
    case "ActivityFeedCard": {
      // The live canvas feed is derived from metadata by its renderer. Do not
      // pretend the inert items array is that feed or forward private metadata.
      if (p.live === "canvas") break;
      const entries = list(p.items, 50).map(fields);
      if (entries.every(row => Number.isFinite(Date.parse(rawText(row.at))))) entries.sort((a, b) => Date.parse(rawText(b.at)) - Date.parse(rawText(a.at)));
      preview = { kind: "timeline", items: items(entries, row => item(row.text, [row.time || row.at], row.kind === "done")) }; break;
    }
    case "ProgressRingCard": if (finite(p.current) && finite(p.target) && p.target > 0) preview = { kind: "metric", stat: { value: `${p.current} / ${p.target}`, ...(text(p.unit, 80) ? { unit: text(p.unit, 80) } : {}) }, body: join([p.note, p.deadline]) }; break;
    case "HabitHeatmapCard": title = headline(p.habit) || title; preview = { kind: "collection", items: list(p.checkins).map(date => item(date)).filter(row => row.text), ...(finite(p.weeklyGoal) ? { body: `每周目标：${p.weeklyGoal} 天` } : {}) }; break;
    case "BookCard": preview = { kind: "text", body: join([p.author, p.status]), items: list(p.notes).map(note => item(note)).filter(row => row.text), ...(finite(p.currentPage) ? { stat: { value: finite(p.totalPages) ? `${p.currentPage} / ${p.totalPages}` : String(p.currentPage), unit: "页" } } : {}) }; break;
    case "MonthCalendarCard": title = headline(p.title || p.month) || title; preview = { kind: "timeline", body: text(p.month), items: items(p.events, event => item(event.title, [event.date, event.time])) }; break;
    case "ComparisonCard": {
      const options = list(p.options, 11).map(fields);
      preview = { kind: "table", body: text(p.recommendation), columns: ["指标", ...options.map(option => text(option.name, 100))], rows: list(p.criteria).map(value => { const criterion = fields(value); return [text(criterion.name, 256), ...list(criterion.values, options.length).map(value => scalar(value))]; }) }; break;
    }
    case "LinkPreviewCard": preview = { kind: "text", body: text(p.description), items: list(p.tags).map(tag => item(tag)).filter(row => row.text) }; break;
    case "PhotoCoverCard": { const image = fields(p.image); preview = { kind: "text", body: join([p.caption, image.caption || image.alt, p.date], 6000, "\n") }; break; }
    case "NotificationCard": preview = { kind: "text", body: join([p.body, p.status, p.at], 6000, "\n") }; break;
    case "TravelOffersCard": {
      const query = fields(p.query), selected = Array.isArray(p.selectedIds) ? p.selectedIds : [];
      title = headline(query.destination ? `${rawText(query.destination)}旅游结果` : "") || title;
      preview = { kind: "collection", body: join([p.mode === "demo" ? "DEMO · 虚构样例" : "", query.dateText || query.startDate, p.notes], 6000, "\n"), items: items(p.items, offer => { const price = fields(offer.price); return item(offer.title, [offer.subtitle, finite(price.amount) ? `${price.amount} ${rawText(price.currency)}` : ""], selected.includes(offer.id)); }) }; break;
    }
    case "ExtensionCard": {
      let verified = false;
      try { verified = OFFICE_IDS.has(rawText(fields(p.def).id)) && isOfficeDefinition?.(p.def) === true; } catch { /* A missing/unavailable definition stays summary-only. */ }
      if (!verified) { title = LABELS.ExtensionCard!; break; }
      const config = fields(p.config), state = fields(p.state);
      title = headline(config.title) || title;
      preview = { kind: "checklist", body: join([config.period, config.context, state.note], 6000, "\n"), items: items(state.items, row => item(join([row.title, row.note], 600, "\n"), [row.day, row.owner, row.due, row.status, row.priority], row.status === "完成")) }; break;
    }
  }
  if (preview) {
    if (truncated) preview.truncated = true;
    const parsed = CardPreviewSchema.safeParse(preview);
    if (parsed.success) return { title, preview: parsed.data };
  }
  return { title };
}

/** No runtime imports, IndexedDB access, election, token storage or automatic activation. */
export function createVivicHostAdapter(options: VivicHostAdapterOptions): ComputerHostAdapter {
  const { host } = options;
  const getSnapshot = (): CanvasSnapshot => {
    const snapshot = host.getSnapshot();
    const active = snapshot.canvases.find(canvas => canvas.id === snapshot.activeCanvasId);
    const canvases = snapshot.canvases.slice(0, 100);
    const cards = options.readCards().filter(card => !card.exitingRequestId);
    // The active canvas may be later than the first 100; it must remain selectable on mobile.
    if (active && !canvases.some(canvas => canvas.id === active.id)) canvases[canvases.length - 1] = active;
    return {
      computerName: options.computerName.slice(0, 80),
      ownerAvailable: snapshot.ready && snapshot.ownerMode === "owner" && Boolean(active),
      ownerEpoch: `${snapshot.ownerId ?? "unavailable"}${options.connectionEpoch ? `_${options.connectionEpoch}` : ""}`,
      activeCanvasId: snapshot.activeCanvasId,
      version: active?.version ?? 0,
      // Content requires an explicit opt-in; no source records, credentials, images or preferences.
      canvases: canvases.map(({ id, title, version }) => ({ id, title: title.slice(0, 160), version })),
      cards: cards.slice(0, 200).map(({ record }) => ({
        id: record.id, title: record.type, type: record.type, pinned: record.layout.pinned,
        ...(options.shareCardPreviews ? { ...visibleCard(record, options.isOfficeDefinition), surface: record.layout.surface === "user" ? "user" as const : "display" as const,
          ...(() => {
            try {
              const parsed = z.array(SubcardPreviewSchema).max(24).safeParse(options.projectSubcards?.(record));
              return parsed.success && parsed.data.length ? { subcards: parsed.data } : {};
            } catch { return {}; }
          })(),
          ...(() => {
            if (!options.readImageChunk || !["GalleryCard", "BookCard"].includes(record.type)) return {};
            const projected = options.projectImages?.(record), parsed = z.array(ImagePreviewSchema).max(8).safeParse(projected?.images);
            return { ...(parsed.success ? { images: parsed.data } : {}), ...(projected?.imageNotice ? { imageNotice: projected.imageNotice.slice(0, 160) } : {}) };
          })(),
          ...(() => {
            if (record.type !== "FileCard" || !options.readFileChunk) return {};
            const p = fields(record.displayProps);
            const file = FilePreviewSchema.safeParse({ name: p.name, mediaType: p.mediaType, sizeBytes: p.sizeBytes, sha256: p.sha256, parseStatus: p.parseStatus, ...(p.pageCount ? { pageCount: p.pageCount } : {}) });
            return file.success ? { file: file.data } : {};
          })(),
          ...(() => {
            const m = fields(record.metadata);
            return { ...(typeof m.section === "string" && m.section.trim() ? { section: m.section.trim().slice(0, 60) } : {}),
              ...(m.priority === "high" || m.priority === "normal" || m.priority === "low" ? { priority: m.priority } : {}),
              ...(z.iso.date().safeParse(m.dueDate).success ? { dueDate: m.dueDate as string } : {}) };
          })(),
        } : {}),
      })),
      ...(options.shareCardPreviews ? { cardCount: cards.length, cardsTruncated: cards.length > 200 } : {}),
    };
  };
  return {
    getSnapshot,
    readImageChunk: options.readImageChunk ? async (cardId, imageId, offset, context) => {
      const snapshot = getSnapshot();
      if (!snapshot.ownerAvailable || !snapshot.activeCanvasId || !snapshot.cards.some(card => card.id === cardId && card.images?.some(image => image.id === imageId)) || !context.isCurrent()) throw new Error("image_scope_changed");
      const chunk = await options.readImageChunk!(snapshot.activeCanvasId, cardId, imageId, offset);
      if (!context.isCurrent()) throw new Error("image_scope_changed");
      return chunk;
    } : undefined,
    readFileChunk: options.readFileChunk ? async (cardId, offset, context) => {
      const snapshot = getSnapshot();
      if (!snapshot.ownerAvailable || !snapshot.activeCanvasId || !snapshot.cards.some(card => card.id === cardId && card.file) || !context.isCurrent()) throw new Error("file_scope_changed");
      const chunk = await options.readFileChunk!(snapshot.activeCanvasId, cardId, offset);
      if (!context.isCurrent()) throw new Error("file_scope_changed");
      return chunk;
    } : undefined,
    subscribe: listener => {
      const unsubscribeHost = host.subscribe(listener);
      const unsubscribeCards = options.subscribeCards(listener);
      return () => { unsubscribeHost(); unsubscribeCards(); };
    },
    submitText: async (text, context) => {
      const before = getSnapshot();
      const isCurrent = () => {
        const current = getSnapshot();
        return !context.signal.aborted && context.isCurrent() && current.ownerAvailable
          && current.ownerEpoch === before.ownerEpoch && current.activeCanvasId === before.activeCanvasId;
      };
      if (!isCurrent()) return { ok: false, message: "电脑控制权或目标画布已变化，请同步后重试。" };
      return options.submitText(text, { ...context, isCurrent });
    },
    switchCanvas: async (id, context) => {
      const snapshot = getSnapshot();
      if (!snapshot.ownerAvailable || !snapshot.canvases.some(canvas => canvas.id === id)) {
        return { ok: false, message: "画布不存在或电脑 owner 不可用。" };
      }
      if (snapshot.activeCanvasId) await host.flush?.(snapshot.activeCanvasId, snapshot.version);
      const current = getSnapshot();
      if (context && !context.isCurrent() || !current.ownerAvailable || current.ownerEpoch !== snapshot.ownerEpoch
        || current.activeCanvasId !== snapshot.activeCanvasId || current.version !== snapshot.version) return { ok: false, message: "控制会话或画布已变化，请同步后重试。" };
      host.switchCanvas(id);
      await host.flush?.(id, getSnapshot().version);
      return getSnapshot().activeCanvasId === id
        ? { ok: true, message: "电脑已切换画布。" }
        : { ok: false, message: "电脑没有确认画布切换。" };
    },
    setCardPinned: async (cardId, pinned) => {
      const snapshot = getSnapshot();
      if (!snapshot.ownerAvailable || !snapshot.activeCanvasId || !snapshot.cards.some(card => card.id === cardId)) {
        return { ok: false, message: "卡片不存在或电脑 owner 不可用。" };
      }
      const result = host.setCardPinned(cardId, pinned, snapshot.activeCanvasId);
      if (result.ok) await host.flush?.(snapshot.activeCanvasId, getSnapshot().version);
      return { ok: result.ok, message: result.ok ? (pinned ? "电脑已固定卡片。" : "电脑已取消固定卡片。") : "电脑未提交卡片操作。" };
    },
    setCardSurface: async (cardId, surface, context) => {
      const snapshot = getSnapshot();
      if (!host.setCardSurface || !host.flush) return { ok: false, message: "电脑版本暂不支持已保存的传送门操作。" };
      if (!snapshot.ownerAvailable || !snapshot.activeCanvasId || !snapshot.cards.some(card => card.id === cardId)
        || context && !context.isCurrent()) return { ok: false, message: "卡片、控制会话或目标画布已变化，请同步后重试。" };
      const write = () => host.setCardSurface!(cardId, surface, undefined, snapshot.activeCanvasId!);
      const result = context?.withCommit ? context.withCommit(write) : write();
      if (!result.ok) return { ok: false, message: "电脑未提交卡片移动。" };
      // flush rejects on failed durability; the connector then reports unknown, never success.
      const committed = getSnapshot();
      await host.flush(snapshot.activeCanvasId, committed.version);
      return { ok: true, message: surface === "user" ? "已移到聊天并保存。" : "已移回 Space 并保存。" };
    },
  };
}
