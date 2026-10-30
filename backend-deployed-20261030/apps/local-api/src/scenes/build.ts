import { randomUUID } from "node:crypto";
import {
  absoluteReminderTime, CardRecordSchema, SCENE_BY_ID, SCENE_CARD_SIZES, type CardRecord, type EvidenceRef, type SceneId,
} from "@vivic/contracts";
import { dayOfWeek, isoOf, mondayOf, monthOf, parseIso, daysBetween } from "./calendar.js";
import {
  groundedDate, groundedDoi, groundedNumber, groundedPartialDate, groundedPhrase, groundedTime, groundedUrl, groundedWeekday, overlapRatio, type Corpus,
} from "./grounding.js";
import type { ParsedScene, SceneDataOf } from "./payload.js";

/** A page the user linked, already fetched by the verified bounded reader. */
export interface ScenePage { url: string; title?: string; text: string; fetchedAt: string; provider: string; readFullPage: boolean; truncated: boolean }

export interface SceneBuildContext {
  corpus: Corpus;
  /** User-supplied text beyond the bare command (pasted article, notes…). */
  sourceTextLength: number;
  page?: ScenePage;
  timeZone: string;
  now: number;
}

/** A failed check: `issue` goes back to the model; `ask` is what the user sees if it still fails. */
export interface SceneIssue { issue: string; ask?: string }
type Built = { ok: true; card: CardRecord } | ({ ok: false } & SceneIssue);

const fail = (issue: string, ask?: string): Built => ({ ok: false, issue, ask });
const ids = (prefix: string) => (index: number) => `${prefix}-${index + 1}`;

// ----------------------------------------------------------------- grounding

function groundingIssue(scene: ParsedScene, context: SceneBuildContext): SceneIssue | null {
  const { corpus } = context;
  const hasSource = Boolean(context.page) || context.sourceTextLength >= 60;
  const number = (value: number | undefined, field: string) => value === undefined || groundedNumber(corpus, value) ? null
    : { issue: `${scene.scene}.${field} 的数值不在用户提供的信息里，不能推测；缺少时省略或 clarify`, ask: "需要的数值没有在你的话里找到，请补充具体数字。" };
  const url = (value: string | undefined, field: string) => value === undefined || groundedUrl(corpus, value) ? null
    : { issue: `${scene.scene}.${field} 必须是用户原话或页面里出现的 https 链接，不能自造或补全` };
  const phrase = (value: string | undefined, field: string) => value === undefined || groundedPhrase(corpus, value) ? null
    : { issue: `${scene.scene}.${field} 必须原样来自用户提供的文字或链接页面，不能凭记忆补充` };
  const day = (value: string | undefined, field: string) => value === undefined || groundedDate(corpus, value) ? null
    : { issue: `${scene.scene}.${field} 日期不在用户的话里，不能推测；缺日期时请 clarify`, ask: "请告诉我具体日期，我再生成卡片。" };
  const clock = (value: string | undefined, field: string) => value === undefined || groundedTime(corpus, value) ? null
    : { issue: `${scene.scene}.${field} 时间不在用户的话里，不能推测；没有时间就省略` };
  const first = (...checks: Array<SceneIssue | null>) => checks.find(Boolean) ?? null;
  switch (scene.scene) {
    case "travel_offers": return { issue: "旅游卡必须由服务适配器构建，禁止模型直接创建结果" };
    case "countdown": return first(day(scene.data.targetDate, "targetDate"), clock(scene.data.targetTime, "targetTime"));
    case "academic_paper": {
      const d = scene.data;
      if (d.abstract && (!hasSource || overlapRatio(corpus, d.abstract) < 0.3)) return { issue: "academic_paper.abstract 只能依据用户粘贴的原文或链接页面；没有原文就省略 abstract" };
      if (d.keyPoints?.length && !hasSource) return { issue: "academic_paper.keyPoints 需要用户提供的原文或链接页面；没有就省略" };
      return first(phrase(d.title, "title"), ...(d.authors ?? []).map(author => phrase(author, "authors")), phrase(d.venue, "venue"),
        d.year === undefined || corpus.years.has(d.year) || groundedNumber(corpus, d.year) ? null : { issue: "academic_paper.year 不在用户提供的信息里" },
        d.doi === undefined || groundedDoi(corpus, d.doi) ? null : { issue: "academic_paper.doi 必须来自用户提供的信息" }, url(d.url, "url"));
    }
    case "photo_gallery": return first(...(scene.data.images ?? []).map(image => url(image.url, "images.url")));
    case "weekly_schedule": return first(...scene.data.events.flatMap(event => [
      event.date ? day(event.date, "events.date") : event.day !== undefined && !groundedWeekday(corpus, event.day)
        ? { issue: "weekly_schedule.events.day 的星期不在用户的话里，不能推测" } : null,
      clock(event.start, "events.start"), clock(event.end, "events.end"),
    ]));
    case "data_visualization": return first(...scene.data.points.flatMap((point, index) => [
      number(point.y, `points[${index}].y`), typeof point.x === "number" ? number(point.x, `points[${index}].x`) : null,
    ]));
    case "news_summary": {
      const d = scene.data;
      if (!hasSource) return { issue: "没有可摘要的新闻原文：请让用户提供原文或链接，不要凭空写新闻", ask: "请把新闻原文或链接发给我，我再整理成资讯卡片。" };
      if (overlapRatio(corpus, d.summary) < 0.3) return { issue: "news_summary.summary 必须依据用户提供的原文或链接页面概括" };
      return first(url(d.url, "url"), url(d.imageUrl, "imageUrl"),
        d.publishedAt === undefined || groundedDate(corpus, d.publishedAt) ? null
          : { issue: "news_summary.publishedAt 没有原文发布日期依据，必须省略这个可选字段；不能把今天或事件发生日当作发布日期，无需向用户追问日期" });
    }
    case "historical_timeline": return first(...scene.data.events.map(event => groundedPartialDate(corpus, event.date) ? null
      : { issue: "historical_timeline.events.date 不在用户提供的信息里，不能编造事件或日期；缺少时请 clarify", ask: "请告诉我这些事情发生的时间，我再整理成时间线。" }));
    case "quote_note": {
      const d = scene.data;
      if ((d.author || d.source) && overlapRatio(corpus, d.text) < 0.6) return { issue: "quote_note 不能给未出现在用户原话里的句子署名或标注出处" };
      return first(phrase(d.author, "author"), phrase(d.source, "source"));
    }
    case "photo_story": return first(...scene.data.slides.map(slide => url(slide.imageUrl, "slides.imageUrl")));
    case "activity_feed": {
      if (scene.data.live) return null;
      const items = scene.data.items ?? [];
      if (!items.length) return { issue: "activity_feed 没有用户提供的动态记录：查看画布动态请用 {\"live\":true}" };
      return items.some(item => overlapRatio(corpus, item.text) < 0.3)
        ? { issue: "activity_feed.items 必须来自用户提供的记录；查看画布自身动态请改用 {\"live\":true}" } : null;
    }
    case "goal_progress": return first(number(scene.data.current, "current"), number(scene.data.target, "target"), day(scene.data.deadline, "deadline"));
    case "habit_tracking": return first(...(scene.data.checkins ?? []).map(date => day(date, "checkins")),
      scene.data.weeklyGoal === undefined || groundedNumber(corpus, scene.data.weeklyGoal) ? null
        : { issue: "habit_tracking.weeklyGoal 没有用户给出的每周目标数值依据，必须省略这个可选字段；不要复制示例目标4，也不需要为已有打卡记录追问目标" },
      day(scene.data.startDate, "startDate"));
    case "book_record": {
      const d = scene.data;
      return first(phrase(d.title, "title"), phrase(d.author, "author"), number(d.currentPage, "currentPage"), number(d.totalPages, "totalPages"),
        number(d.rating, "rating"), url(d.coverUrl, "coverUrl"));
    }
    case "monthly_calendar": return first(...scene.data.events.flatMap(event => [day(event.date, "events.date"), clock(event.time, "events.time")]));
    case "option_comparison": {
      const d = scene.data;
      return first(...d.options.map(option => phrase(option.name, "options.name")),
        ...d.criteria.flatMap(row => row.values.map(value => typeof value === "number" ? number(value, `criteria.${row.name}`) : null)));
    }
    case "web_bookmark": return url(scene.data.url, "url");
    case "photo_memory": return first(day(scene.data.date, "date"), url(scene.data.imageUrl, "imageUrl"));
    case "todo_list": case "project_roadmap": case "single_notification": return null;
  }
}

// ----------------------------------------------------------------- builders

const sceneTitle = (scene: ParsedScene): string => {
  switch (scene.scene) {
    case "travel_offers": return `${scene.data.destination}旅游结果`;
    case "news_summary": return scene.data.headline;
    case "quote_note": return scene.data.text;
    case "habit_tracking": return scene.data.habit;
    case "web_bookmark": return scene.data.title ?? new URL(scene.data.url).hostname;
    case "monthly_calendar": case "todo_list": case "data_visualization": return scene.data.title ?? SCENE_BY_ID[scene.scene].label;
    default: return scene.data.title;
  }
};

function evidenceFor(context: SceneBuildContext, url?: string): EvidenceRef[] {
  const page = context.page;
  if (!page || (url && page.url.replace(/\/+$/, "") !== url.replace(/\/+$/, ""))) return [];
  return [{ title: (page.title || new URL(page.url).hostname).slice(0, 500), url: page.url, fetchedAt: page.fetchedAt, provider: page.provider.slice(0, 80), readFullPage: page.readFullPage }];
}

function displayFor(scene: ParsedScene, context: SceneBuildContext): { type: CardRecord["type"]; displayProps: Record<string, unknown>; sourceData: Record<string, unknown> } | SceneIssue {
  const today = parseIso(context.corpus.today)!;
  const base = { scene: scene.scene, provenance: context.page ? "fetched-page" : "user-text" };
  switch (scene.scene) {
    case "travel_offers": return { issue: "旅游结果必须经服务适配器构建" };
    case "countdown": {
      const d = scene.data;
      let targetAt: string;
      try { targetAt = absoluteReminderTime(d.targetDate, d.targetTime ?? "00:00", context.timeZone); }
      catch { return { issue: "countdown 的日期时间在当地时区无效或有歧义", ask: "这个日期时间在当地时区无效，请换一个具体时间。" }; }
      return { type: "CountdownCard", displayProps: {}, sourceData: { targetAt, startedAt: new Date(context.now).toISOString(), timeZone: context.timeZone,
        event: { title: d.title, date: d.targetDate, ...(d.targetTime ? { time: d.targetTime } : {}), ...(d.note ? { note: d.note } : {}) } } };
    }
    case "academic_paper": {
      const { doi, ...d } = scene.data;
      return { type: "PaperCard", displayProps: { ...d, ...(doi && /^10\.\d{4,9}\/\S+$/.test(doi) ? { doi } : {}), readStatus: "unread" }, sourceData: base };
    }
    case "photo_gallery":
      return { type: "GalleryCard", displayProps: { title: scene.data.title, images: (scene.data.images ?? []).map(image => ({ src: image.url, ...(image.caption ? { caption: image.caption } : {}) })) }, sourceData: base };
    case "weekly_schedule": {
      const d = scene.data;
      const dated = d.events.map(event => event.date ? parseIso(event.date) : null);
      const anchor = d.weekStart ? parseIso(d.weekStart) : dated.find(Boolean) ?? today;
      if (!anchor) return { issue: "weekly_schedule.weekStart 不是有效日期" };
      const weekStart = mondayOf(anchor);
      const events = [];
      for (const [index, event] of d.events.entries()) {
        const date = dated[index];
        if (date && (daysBetween(weekStart, date) < 0 || daysBetween(weekStart, date) > 6)) return { issue: "weekly_schedule 只能包含同一周（周一到周日）的安排；跨周请拆成多张卡片或改用 monthly_calendar" };
        const day = date ? dayOfWeek(date) : event.day;
        if (!day) return { issue: "weekly_schedule.events 每项需要 day(1-7) 或 date" };
        if (event.end && (!event.start || event.end <= event.start)) return { issue: "weekly_schedule.events 结束时间必须晚于开始时间" };
        events.push({ id: ids("ev")(index), day, title: event.title, ...(event.start ? { start: event.start } : {}), ...(event.end ? { end: event.end } : {}),
          ...(event.location ? { location: event.location } : {}) });
      }
      return { type: "WeeklyScheduleCard", displayProps: { title: d.title, weekStart: isoOf(weekStart), events }, sourceData: base };
    }
    case "todo_list":
      return { type: "TodoCard", displayProps: { ...(scene.data.title ? { title: scene.data.title } : {}),
        items: scene.data.items.map((item, index) => ({ id: ids("item")(index), text: item.text, done: Boolean(item.done) })) }, sourceData: base };
    case "project_roadmap":
      return { type: "RoadmapCard", displayProps: { title: scene.data.title, phases: scene.data.phases.map((phase, index) => ({
        id: ids("p")(index), name: phase.name, status: phase.status ?? "planned", ...(phase.period ? { period: phase.period } : {}), ...(phase.goal ? { goal: phase.goal } : {}),
        milestones: (phase.milestones ?? []).map((milestone, i) => ({ id: `m-${index + 1}-${i + 1}`, text: milestone.text, done: Boolean(milestone.done) })),
      })) }, sourceData: base };
    case "data_visualization": {
      const { title, chartKind, points, xLabel, yLabel } = scene.data;
      return { type: "ChartCard", displayProps: { ...(title ? { title } : {}), chartKind, points, ...(xLabel ? { xLabel } : {}), ...(yLabel ? { yLabel } : {}) },
        sourceData: { ...base, provenance: "user-input", capturedAt: new Date(context.now).toISOString() } };
    }
    case "news_summary": {
      const { imageUrl, ...d } = scene.data;
      return { type: "NewsCard", displayProps: { ...d, ...(imageUrl ? { image: imageUrl } : {}), summaryBy: "ai" }, sourceData: base };
    }
    case "historical_timeline":
      return { type: "TimelineCard", displayProps: { title: scene.data.title, ...(scene.data.order ? { order: scene.data.order } : {}),
        events: scene.data.events.map((event, index) => ({ id: ids("t")(index), date: event.date, title: event.title, ...(event.description ? { description: event.description } : {}) })) }, sourceData: base };
    case "quote_note": return { type: "QuoteCard", displayProps: { ...scene.data }, sourceData: base };
    case "photo_story":
      return { type: "StoryCarouselCard", displayProps: { title: scene.data.title, slides: scene.data.slides.map((slide, index) => ({
        id: ids("s")(index), text: slide.text, ...(slide.heading ? { heading: slide.heading } : {}), ...(slide.imageUrl ? { image: slide.imageUrl } : {}) })) }, sourceData: base };
    case "activity_feed":
      return { type: "ActivityFeedCard", displayProps: { title: scene.data.title, ...(scene.data.live ? { live: "canvas" } : {}),
        items: scene.data.live ? [] : (scene.data.items ?? []).map((item, index) => ({ id: ids("a")(index), kind: item.kind ?? "event", text: item.text,
          ...(item.at ? { at: new Date(item.at).toISOString() } : {}), ...(item.time ? { time: item.time } : {}) })) }, sourceData: base };
    case "goal_progress": return { type: "ProgressRingCard", displayProps: { ...scene.data }, sourceData: base };
    case "habit_tracking": {
      const checkins = [...new Set(scene.data.checkins ?? [])].sort();
      return { type: "HabitHeatmapCard", displayProps: { ...scene.data, checkins }, sourceData: base };
    }
    case "book_record": {
      const { coverUrl, status, ...d } = scene.data;
      if (d.currentPage !== undefined && d.totalPages !== undefined && d.currentPage > d.totalPages) return { issue: "book_record.currentPage 不能超过 totalPages" };
      return { type: "BookCard", displayProps: { ...d, status: status ?? (d.currentPage ? "reading" : "want"), ...(coverUrl ? { cover: coverUrl } : {}) }, sourceData: base };
    }
    case "monthly_calendar": {
      const d = scene.data;
      const first = d.events.map(event => parseIso(event.date)).find(Boolean);
      const month = d.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(d.month) ? d.month : monthOf(first ?? today);
      return { type: "MonthCalendarCard", displayProps: { ...(d.title ? { title: d.title } : {}), month,
        events: d.events.map((event, index) => ({ id: ids("c")(index), date: event.date, title: event.title, ...(event.time ? { time: event.time } : {}) })) }, sourceData: base };
    }
    case "option_comparison": {
      const d = scene.data;
      if (d.criteria.some(row => row.values.length !== d.options.length)) return { issue: "option_comparison.criteria 每行 values 数量必须等于 options 数量" };
      const options = d.options.map((option, index) => ({ id: ids("o")(index), name: option.name, ...(option.note ? { note: option.note } : {}) }));
      const chosen = d.chosen ? options.find(option => option.name === d.chosen) : undefined;
      return { type: "ComparisonCard", displayProps: { title: d.title, options,
        criteria: d.criteria.map((row, index) => ({ id: ids("k")(index), name: row.name, values: row.values, ...(row.better ? { better: row.better } : {}), ...(row.unit ? { unit: row.unit } : {}) })),
        ...(d.recommendation ? { recommendation: d.recommendation } : {}), ...(chosen ? { chosenId: chosen.id } : {}) }, sourceData: base };
    }
    case "web_bookmark": {
      const d = scene.data;
      const page = context.page && context.page.url.replace(/\/+$/, "") === d.url.replace(/\/+$/, "") ? context.page : undefined;
      // Titles are never guessed: the fetched page title wins, otherwise only a title the user wrote.
      const title = page?.title?.trim().slice(0, 200) || (d.title && groundedPhrase(context.corpus, d.title) ? d.title : undefined);
      return { type: "LinkPreviewCard", displayProps: { url: d.url, ...(title ? { title } : {}), ...(d.siteName && (page || groundedPhrase(context.corpus, d.siteName)) ? { siteName: d.siteName } : {}),
        ...(d.description && page ? { description: d.description } : {}), ...(d.tags?.length ? { tags: d.tags } : {}) }, sourceData: { ...base, fetched: Boolean(page) } };
    }
    case "photo_memory": {
      const { imageUrl, ...d } = scene.data;
      return { type: "PhotoCoverCard", displayProps: { ...d, ...(imageUrl ? { image: { src: imageUrl, alt: d.title } } : {}) }, sourceData: base };
    }
    case "single_notification":
      return { type: "NotificationCard", displayProps: { ...scene.data, level: scene.data.level ?? "info",
        at: scene.data.at ? new Date(scene.data.at).toISOString() : new Date(context.now).toISOString(), status: "unread" }, sourceData: base };
  }
}

/** Grounding → record → full contract validation. Never returns an invalid card. */
export function buildSceneCard(scene: ParsedScene, context: SceneBuildContext): Built {
  const grounding = groundingIssue(scene, context);
  if (grounding) return { ok: false, ...grounding };
  const built = displayFor(scene, context);
  if ("issue" in built) return { ok: false, ...built };
  const stamp = new Date(context.now).toISOString();
  const title = sceneTitle(scene).trim().slice(0, 80);
  const url = "url" in scene.data && typeof scene.data.url === "string" ? scene.data.url : undefined;
  const candidate = {
    id: `${scene.scene}_${context.now.toString(36)}_${randomUUID().slice(0, 8)}`,
    type: built.type,
    variant: "standard",
    displayProps: built.displayProps,
    sourceData: built.sourceData,
    sources: evidenceFor(context, url),
    layout: { x: 0, y: 0, ...SCENE_CARD_SIZES[scene.scene], pinned: false },
    metadata: { createdAt: stamp, updatedAt: stamp, ...(title ? { aliases: [title] } : {}) },
  };
  const parsed = CardRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(`${scene.scene} 生成的卡片未通过契约校验（${first?.path.slice(-2).join(".") || "card"}）`);
  }
  return { ok: true, card: parsed.data };
}

export type { SceneDataOf, SceneId };
