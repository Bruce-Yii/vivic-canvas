import { describe, expect, it, vi } from "vitest";
import { createVivicHostAdapter, type ExistingHost, type ExistingCard } from "../vivicHostAdapter";
import { CardPreviewSchema, CanvasSnapshotSchema } from "../protocol";

const record = (type: string, displayProps: unknown, sourceData: unknown = {}): ExistingCard => ({ record: {
  id: "visible-card", type, layout: { pinned: false, surface: "user" }, displayProps, sourceData,
} });
function projection(card: ExistingCard | ExistingCard[], isOfficeDefinition?: (ref: unknown) => boolean) {
  const host: ExistingHost = {
    getSnapshot: () => ({ ready: true, ownerMode: "owner", ownerId: "owner", activeCanvasId: "canvas", canvases: [{ id: "canvas", title: "Space", version: 1 }] }),
    subscribe: () => () => {}, switchCanvas: vi.fn(), setCardPinned: vi.fn(() => ({ ok: true })),
  };
  return createVivicHostAdapter({ host, computerName: "电脑", shareCardPreviews: true, isOfficeDefinition, readCards: () => Array.isArray(card) ? card : [card], subscribeCards: () => () => {}, submitText: async () => ({ ok: true, message: "done" }) }).getSnapshot();
}

describe("Vivic owner summary adapter", () => {
  it("retains an active canvas beyond the first 100 and excludes card contents", () => {
    const host: ExistingHost = {
      getSnapshot: () => ({ ready: true, ownerMode: "owner", ownerId: "owner", activeCanvasId: "canvas_109",
        canvases: Array.from({ length: 110 }, (_, i) => ({ id: `canvas_${i}`, title: `Canvas ${i}`, version: i })) }),
      subscribe: () => () => {}, switchCanvas: vi.fn(), setCardPinned: vi.fn(() => ({ ok: true })),
    };
    const adapter = createVivicHostAdapter({ host, computerName: "电脑", subscribeCards: () => () => {},
      readCards: () => [{ record: { id: "note", type: "NoteCard", layout: { pinned: false }, displayProps: { text: "private card body" } } }],
      submitText: async () => ({ ok: true, message: "done" }),
    });
    const snapshot = adapter.getSnapshot();
    expect(snapshot.canvases).toHaveLength(100);
    expect(snapshot.canvases.some(canvas => canvas.id === "canvas_109")).toBe(true);
    expect(snapshot.version).toBe(109);
    expect(JSON.stringify(snapshot)).not.toContain("private card body");
  });
});

describe("explicit visible-content sharing", () => {
  it.each([
    ["NoteCard", { text: "便笺正文", bullets: ["要点"] }, "text", "便笺正文"],
    ["TodoCard", { title: "准备", items: [{ text: "整理材料", done: true }] }, "checklist", "整理材料"],
    ["WeatherCard", { tempC: 18, conditionIcon: "cloud" }, "metric", "多云"],
    ["TableCard", { columns: ["项目"], rows: [["评审"]] }, "table", "评审"],
    ["ChartCard", { points: [{ x: "周一", y: 2 }], yLabel: "完成量" }, "chart", "周一"],
    ["QuoteCard", { text: "引用正文", author: "作者" }, "text", "引用正文"],
    ["SearchResultCard", { title: "结果", summary: "搜索摘要" }, "text", "搜索摘要"],
    ["PaperCard", { title: "论文", abstract: "论文摘要", keyPoints: ["结论"] }, "text", "论文摘要"],
    ["GalleryCard", { title: "照片", images: [{ src: "https://private.invalid/photo", caption: "照片说明" }] }, "collection", "照片说明"],
    ["WeeklyScheduleCard", { title: "本周", weekStart: "2026-10-19", events: [{ title: "会议", day: 1, start: "10:00", done: true }] }, "timeline", "会议"],
    ["RoadmapCard", { title: "路线", phases: [{ name: "准备阶段", status: "active", milestones: [{ text: "评审", done: false }] }] }, "timeline", "准备阶段"],
    ["NewsCard", { headline: "资讯标题", summary: "资讯摘要" }, "text", "资讯摘要"],
    ["TimelineCard", { title: "进展", events: [{ title: "里程碑", date: "2026-10", description: "验收" }] }, "timeline", "里程碑"],
    ["StoryCarouselCard", { title: "故事", slides: [{ text: "故事正文", image: "https://private.invalid/story" }] }, "collection", "故事正文"],
    ["ActivityFeedCard", { title: "动态", items: [{ text: "完成评审", kind: "done", time: "今天" }] }, "timeline", "完成评审"],
    ["ProgressRingCard", { title: "目标", current: 2, target: 5, unit: "项", note: "本周推进" }, "metric", "2 / 5"],
    ["HabitHeatmapCard", { habit: "阅读", checkins: ["2026-10-22"], weeklyGoal: 3 }, "collection", "2026-10-22"],
    ["BookCard", { title: "书籍", status: "reading", currentPage: 8, totalPages: 100, notes: ["阅读笔记"] }, "text", "阅读笔记"],
    ["MonthCalendarCard", { month: "2026-10", events: [{ title: "演讲", date: "2026-10-23", time: "20:00" }] }, "timeline", "演讲"],
    ["ComparisonCard", { title: "对比", options: [{ name: "甲" }, { name: "乙" }], criteria: [{ name: "预算", values: [100, 200] }] }, "table", "预算"],
    ["LinkPreviewCard", { title: "收藏", url: "https://private.invalid/link", description: "收藏摘要" }, "text", "收藏摘要"],
    ["PhotoCoverCard", { title: "纪念", image: { src: "https://private.invalid/cover", caption: "封面说明" } }, "text", "封面说明"],
    ["NotificationCard", { title: "通知", body: "提醒正文", level: "info" }, "text", "提醒正文"],
    ["TravelOffersCard", { query: { destination: "杭州" }, mode: "demo", items: [{ id: "hotel", title: "样例酒店", price: { amount: 300, currency: "CNY" } }], selectedIds: ["hotel"], notes: "安静房间" }, "collection", "DEMO"],
    ["ExtensionCard", { def: { id: "vivic.office-tasks" }, config: { title: "发布准备", context: "本周工作" }, state: { items: [{ title: "检查材料", status: "完成", owner: "本人" }] } }, "checklist", "检查材料"],
  ] as const)("projects only the visible %s fields", (type, props, kind, expected) => {
    const snapshot = projection(record(type, { ...props, apiKey: "NOT_VISIBLE_SENTINEL" }, { apiKey: "SOURCE_SENTINEL" }), type === "ExtensionCard" ? () => true : undefined);
    expect(CanvasSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.cards[0]).toMatchObject({ surface: "user", preview: { kind } });
    expect(JSON.stringify(snapshot)).toContain(expected);
    expect(JSON.stringify(snapshot)).not.toMatch(/NOT_VISIBLE_SENTINEL|SOURCE_SENTINEL|private\.invalid/);
    expect(snapshot).toMatchObject({ cardCount: 1, cardsTruncated: false });
  });

  it("includes only the explicitly visible countdown source fields", () => {
    const snapshot = projection(record("CountdownCard", {}, { targetAt: "2099-01-01T00:00:00.000Z", reminderText: "检查烤箱", apiKey: "SOURCE_SENTINEL", condition: { text: "PRIVATE_CONDITION" } }));
    expect(snapshot.cards[0]).toMatchObject({ title: "检查烤箱", preview: { kind: "metric" } });
    expect(JSON.stringify(snapshot)).toContain("2099-01-01");
    expect(JSON.stringify(snapshot)).not.toMatch(/SOURCE_SENTINEL|PRIVATE_CONDITION/);
    expect(projection(record("CountdownCard", {}, { targetAt: "invalid" })).cards[0]!.preview).toBeUndefined();
  });

  it("keeps the legacy timer wire shape, freezes paused time and does not count down unmet conditions", () => {
    const source = { targetAt:"2026-10-23T10:02:00.000Z", pausedAt:"2026-10-23T10:00:00.000Z" };
    const paused = projection(record("CountdownCard", {}, source)).cards[0]!.preview!;
    expect(paused).toEqual({kind:"metric", stat:{value:"02:00"}, body:"已暂停 · 到期：2026-10-23T10:02:00.000Z"});
    expect(Object.keys(paused).sort()).toEqual(["body","kind","stat"]);
    const waiting = projection(record("CountdownCard", {}, {...source,reminderText:"检查烤箱",condition:{text:"PRIVATE_CONDITION"}})).cards[0]!.preview!;
    expect(waiting.stat?.value).toBe("等待"); expect(JSON.stringify(waiting)).not.toContain("PRIVATE_CONDITION");
    expect(projection(record("CountdownCard", {}, {...source,condition:{text:"PRIVATE"},conditionMetAt:"2026-10-23T09:00:00.000Z"})).cards[0]!.preview!.stat?.value).toBe("02:00");
  });

  it.each(["2026-02-31T10:00:00Z","2026-10-23","next week","2099-01-01T00:00:00Z token=PRIVATE"])("rejects non-ISO or impossible timer dates: %s", targetAt => {
    expect(projection(record("CountdownCard", {}, {targetAt})).cards[0]!.preview).toBeUndefined();
    expect(projection(record("CountdownCard", {}, {targetAt:"2099-01-01T00:00:00Z",pausedAt:targetAt})).cards[0]!.preview).toBeUndefined();
  });

  it("does not fabricate previews for unknown cards or arbitrary extension packages", () => {
    expect(projection(record("FutureCard", { title: "未来卡片", text: "PRIVATE_UNKNOWN" })).cards[0]).toEqual({ id: "visible-card", title: "未来卡片", type: "FutureCard", pinned: false, surface: "user" });
    const unknownExtension = projection(record("ExtensionCard", { def: { id: "other.package" }, config: { title: "PRIVATE_CONFIG" }, state: { items: [{ title: "PRIVATE_STATE" }] } }));
    expect(unknownExtension.cards[0]!.preview).toBeUndefined();
    expect(JSON.stringify(unknownExtension)).not.toMatch(/PRIVATE_CONFIG|PRIVATE_STATE/);
    const sameId = record("ExtensionCard", { def: { id: "vivic.office-tasks", hash: "substituted" }, config: { title: "PRIVATE_CONFIG" }, state: { items: [{ title: "PRIVATE_STATE" }] } });
    expect(projection(sameId).cards[0]!.preview).toBeUndefined();
    expect(projection(sameId, () => false).cards[0]!.preview).toBeUndefined();
    expect(projection(sameId, () => { throw new Error("definition unavailable"); }).cards[0]!.preview).toBeUndefined();
  });

  it("bounds strings, lists and nonfinite chart values without serializing arbitrary objects", () => {
    const note = projection(record("NoteCard", { text: "字".repeat(7000) })).cards[0]!.preview!;
    expect(note.body).toHaveLength(6000); expect(note.truncated).toBe(true);
    const table = projection(record("TableCard", { columns: Array(15).fill("列".repeat(110)), rows: Array(45).fill(Array(15).fill("值".repeat(300))) })).cards[0]!.preview!;
    expect(table.columns).toHaveLength(12); expect(table.columns![0]).toHaveLength(100);
    expect(table.rows).toHaveLength(40); expect(table.rows![0]).toHaveLength(12); expect(table.rows![0]![0]).toHaveLength(256); expect(table.truncated).toBe(true);
    const chart = projection(record("ChartCard", { points: [{ x: "无效", y: Infinity }, { x: { apiKey: "PRIVATE_OBJECT" }, y: 2 }, { x: "有效", y: 3 }] })).cards[0]!.preview!;
    expect(chart.series).toEqual([{ label: "有效", value: 3 }]);
    expect(CardPreviewSchema.safeParse(chart).success).toBe(true);
  });

  it("flags item caps and preserves renderer ordering without inventing metadata-derived live events", () => {
    const timeline = projection(record("TimelineCard", { order: "desc", events: [{ date: "2020", title: "较早" }, { date: "2026", title: "最新" }] })).cards[0]!.preview!;
    expect(timeline.items!.map(item => item.text)).toEqual(["最新", "较早"]);
    const weekly = projection(record("WeeklyScheduleCard", { events: Array.from({ length: 60 }, (_, index) => ({ title: `事件${index}`, day: index % 7 + 1 })) })).cards[0]!.preview!;
    expect(weekly.items).toHaveLength(40); expect(weekly.truncated).toBe(true);
    const gallery = projection(record("GalleryCard", { images: Array.from({ length: 45 }, () => ({ caption: "图".repeat(700), src: "PRIVATE_IMAGE" })) })).cards[0]!.preview!;
    expect(gallery.items).toHaveLength(40); expect(gallery.items![0]!.text).toHaveLength(600); expect(gallery.truncated).toBe(true);
    const chart = projection(record("ChartCard", { points: Array.from({ length: 50 }, (_, index) => ({ x: `点${index}`, y: index })) })).cards[0]!.preview!;
    expect(chart.series).toHaveLength(32); expect(chart.truncated).toBe(true);
    expect(projection(record("ActivityFeedCard", { live: "canvas", items: [{ text: "NOT_ACTUAL_LIVE_FEED" }] })).cards[0]!.preview).toBeUndefined();
    expect(projection(record("NoteCard", { text: "字".repeat(500) })).cards[0]!.preview!.truncated).toBeUndefined();
  });

  it.each(["vivic.office-tasks", "vivic.office-meeting", "vivic.office-week"])("requires the host's verified definition reference for %s", id => {
    const ref = { id, version: "1.0.0", hash: "a".repeat(64) };
    const verifiedReference = vi.fn(value => value === ref);
    const snapshot = projection(record("ExtensionCard", { def: ref, config: { title: "已验证办公卡", context: "工作说明" }, state: { items: [{ title: "真实行动", status: "完成" }], note: "个人备注" }, data: { token: "UNSHARED_DATA" } }), verifiedReference);
    expect(verifiedReference).toHaveBeenCalledWith(ref);
    expect(snapshot.cards[0]).toMatchObject({ title: "已验证办公卡", preview: { kind: "checklist", items: [{ text: "真实行动", checked: true }] } });
    expect(JSON.stringify(snapshot)).not.toContain("UNSHARED_DATA");
  });

  it("counts both surfaces and reports the real 200-card cap rather than filtering a Space by surface", () => {
    const cards = Array.from({ length: 205 }, (_, index) => {
      const card = record("NoteCard", { text: `便笺${index}` });
      card.record.id = `note_${index}`; card.record.layout.surface = index % 2 ? "user" : "display";
      return card;
    });
    const snapshot = projection([...cards, { ...record("NoteCard", { text: "已退出" }), exitingRequestId: "removed" }]);
    expect(snapshot).toMatchObject({ cardCount: 205, cardsTruncated: true });
    expect(snapshot.cards).toHaveLength(200);
    expect(snapshot.cards.some(card => card.surface === "user")).toBe(true);
    expect(snapshot.cards.some(card => card.surface === "display")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("已退出");
  });
});
