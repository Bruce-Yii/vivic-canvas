import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActionEnvelopeSchema, CardRecordSchema, SCENE_CARD_TYPE, SCENE_IDS, SCENES, sceneOfCard, type Action, type CardRecord, type SceneId,
} from "@vivic/contracts";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type IntentResult } from "../src/intent/pipeline.js";
import { isReminderCreation } from "../src/intent/reminders.js";
import { buildSceneActions, explicitScene, looksLikeDateCountdown, sceneSourceUrl, sceneUpdateIssue } from "../src/scenes/index.js";
import { buildCorpus, groundedDate, groundedNumber, groundedTime, parseChineseNumber } from "../src/scenes/grounding.js";
import { parseScenePayload } from "../src/scenes/payload.js";
import { buildProviderSceneActions } from "../src/scenes/travel.js";
import { chatOk, emptyContext, fetchStub } from "./helpers.js";
import { CONFUSABLE_CASES, SCENE_CASES, SCENE_NOW, SCENE_ZONE } from "./sceneCases.js";

const ctx = (cards: Parameters<typeof emptyContext>[0] = []) => ({ ...emptyContext(cards), timeZone: SCENE_ZONE });
const request = (text: string, extra: Partial<Parameters<typeof buildSceneActions>[1]> = {}) => ({ text, ctx: ctx(), now: SCENE_NOW, ...extra });
const created = (actions: Action[]) => actions.filter((a): a is Extract<Action, { type: "card.create" }> => a.type === "card.create").map(a => a.card);
const build = (scene: SceneId, input: string, data: Record<string, unknown>) => buildSceneActions([{ scene_id: scene, card_type: SCENE_CARD_TYPE[scene], data }], request(input));

afterEach(() => vi.useRealTimers());

describe("scene registry", () => {
  it("maps 21 scene ids to 21 distinct card types, both ways", () => {
    expect(SCENES).toHaveLength(21);
    expect(new Set(SCENE_IDS).size).toBe(21);
    expect(new Set(SCENES.map(scene => scene.cardType)).size).toBe(21);
    for (const scene of SCENES) expect(SCENE_CARD_TYPE[scene.id]).toBe(scene.cardType);
  });
  it("every registered card type has a contract schema", () => {
    const types = new Set(CardRecordSchema.options.map(option => option.shape.type.value));
    for (const scene of SCENES) expect(types.has(scene.cardType)).toBe(true);
  });
  it("covers every scene with a realistic test utterance", () => {
    expect(new Set(SCENE_CASES.map(item => item.scene))).toEqual(new Set(SCENE_IDS));
  });
});

describe("scene payload contract", () => {
  it("rejects a card_type that does not belong to the scene", () => {
    const result = parseScenePayload({ scene_id: "countdown", card_type: "TimelineCard", data: { title: "x", targetDate: "2026-11-11" } });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.issue).toContain("只能对应 card_type CountdownCard");
  });
  it("rejects unknown scenes, markup-ish extra fields and invalid shapes", () => {
    expect(parseScenePayload({ scene_id: "dashboard", data: {} }).ok).toBe(false);
    expect(parseScenePayload({ scene_id: "quote_note", data: { text: "a", html: "<b>x</b>" } }).ok).toBe(false);
    expect(parseScenePayload({ scene_id: "quote_note", data: { text: "a" }, component: "Foo" }).ok).toBe(false);
    expect(parseScenePayload({ scene_id: "countdown", data: { title: "x", targetDate: "11月11日" } }).ok).toBe(false);
  });
});

describe("grounding evidence", () => {
  const corpus = (text: string) => buildCorpus([text], { now: SCENE_NOW, timeZone: SCENE_ZONE });
  it("reads Chinese numerals, units and percentages", () => {
    expect(parseChineseNumber("二十五")).toBe(25);
    expect(parseChineseNumber("一百零八")).toBe(108);
    expect(parseChineseNumber("两万")).toBe(20000);
    const c = corpus("还剩二十五天，预算3.5万，完成68%");
    expect(groundedNumber(c, 25)).toBe(true);
    expect(groundedNumber(c, 35000)).toBe(true);
    expect(groundedNumber(c, 0.68)).toBe(true);
    expect(groundedNumber(c, 26)).toBe(false);
  });
  it("resolves relative and explicit dates against the user's today", () => {
    expect(groundedDate(corpus("还有 25 天"), "2026-11-11")).toBe(true);
    expect(groundedDate(corpus("还有 25 天"), "2026-11-20")).toBe(false);
    expect(groundedDate(corpus("明天"), "2026-10-18")).toBe(true);
    expect(groundedDate(corpus("下周三开会"), "2026-10-21")).toBe(true);
    expect(groundedDate(corpus("11月11日"), "2026-11-11")).toBe(true);
    expect(groundedDate(corpus("2025年12月31日"), "2025-12-31")).toBe(true);
    expect(groundedDate(corpus("国庆"), "2027-10-01")).toBe(true);
    expect(groundedDate(corpus("没有日期"), "2026-12-01")).toBe(false);
  });
  it("accepts both readings of an hour without a period, but not invented minutes", () => {
    const c = corpus("3点开会，晚上7点半吃饭");
    expect(groundedTime(c, "03:00")).toBe(true);
    expect(groundedTime(c, "15:00")).toBe(true);
    expect(groundedTime(c, "19:30")).toBe(true);
    expect(groundedTime(c, "19:00")).toBe(false);
  });
});

describe("21 scenes build validated cards from grounded payloads", () => {
  it.each(SCENE_CASES)("$scene → its registered card type", async ({ scene, input, payload }) => {
    const result = await buildProviderSceneActions([{ scene_id: scene, data: payload }], request(input));
    expect(result.ok, result.ok ? "" : result.issue).toBe(true);
    if (!result.ok) return;
    const [card] = created(result.actions);
    expect(card!.type).toBe(SCENE_CARD_TYPE[scene]);
    expect(sceneOfCard(card!)).toBe(scene);
    expect(CardRecordSchema.safeParse(card).success).toBe(true);
    expect(ActionEnvelopeSchema.safeParse({ schemaVersion: "0.6", requestId: "r", canvasId: "c1", actions: result.actions }).success).toBe(true);
  });

  it("derives the countdown target from the user's date in their time zone", () => {
    const result = build("countdown", "距离我的生日还有 25 天", { title: "生日", targetDate: "2026-11-11" });
    const card = result.ok ? created(result.actions)[0] : undefined;
    expect(card?.type === "CountdownCard" && card.sourceData).toMatchObject({ timeZone: SCENE_ZONE, targetAt: "2026-11-10T16:00:00.000Z", event: { date: "2026-11-11" } });
  });

  it("places weekday events in one Monday-first week", () => {
    const result = build("weekly_schedule", "下周一9点开会，下周三3点健身", { title: "下周", events: [{ date: "2026-10-19", start: "09:00", title: "开会" }, { date: "2026-10-21", start: "15:00", title: "健身" }] });
    const card = result.ok ? created(result.actions)[0] : undefined;
    expect(card?.type === "WeeklyScheduleCard" && card.displayProps).toMatchObject({ weekStart: "2026-10-19", events: [{ day: 1 }, { day: 3 }] });
  });

  it("wakes the stage once and creates several independent cards", () => {
    const result = buildSceneActions([
      { scene_id: "todo_list", data: { items: ["交周报"] } },
      { scene_id: "quote_note", data: { text: "今天也要加油" } },
    ], { ...request("待办：交周报；再记一句：今天也要加油"), ctx: { ...ctx(), stage: "STANDBY" } });
    expect(result.ok && result.actions.map(a => a.type)).toEqual(["stage.awaken", "card.create", "card.create"]);
  });
});

describe("no fabricated facts", () => {
  const rejects = (scene: SceneId, input: string, data: Record<string, unknown>, fragment: string) => {
    const result = build(scene, input, data);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issue).toContain(fragment);
  };
  it("refuses a guessed countdown date and asks the user instead", () => {
    const result = build("countdown", "帮我做个生日倒计时", { title: "生日", targetDate: "2026-12-01" });
    expect(result).toMatchObject({ ok: false, ask: "请告诉我具体日期，我再生成卡片。" });
  });
  it("refuses chart values the user never gave", () => rejects("data_visualization", "这周步数：周一 8000，周二 6500",
    { chartKind: "bar", points: [{ x: "周一", y: 8000 }, { x: "周二", y: 6500 }, { x: "周三", y: 9000 }] }, "points[2].y"));
  it("refuses invented paper authors, DOIs and abstracts", () => {
    rejects("academic_paper", "收藏论文 Attention Is All You Need", { title: "Attention Is All You Need", authors: ["Geoffrey Hinton"] }, "authors");
    rejects("academic_paper", "收藏论文 Attention Is All You Need", { title: "Attention Is All You Need", doi: "10.1000/fake" }, "doi");
    rejects("academic_paper", "收藏论文 Attention Is All You Need", { title: "Attention Is All You Need", abstract: "本文提出了一种卷积网络用于图像识别。" }, "abstract");
  });
  it("refuses news without a source text and images without user links", () => {
    rejects("news_summary", "帮我摘要一下今天的新闻", { headline: "今日要闻", summary: "股市大涨" }, "没有可摘要的新闻原文");
    rejects("photo_gallery", "展示我们一起拍的照片", { title: "照片", images: ["https://images.example.com/invented.jpg"] }, "images.url");
  });
  it("refuses invented history and activity records", () => {
    rejects("historical_timeline", "整理我们认识以来的重要事情", { title: "回忆", events: [{ date: "2019", title: "相识" }] }, "events.date");
    rejects("activity_feed", "最近产生了什么活动", { title: "动态", items: [{ text: "完成了季度复盘" }] }, "live");
  });
  it("refuses unseen numbers in progress/book/comparison and unknown option names", () => {
    rejects("goal_progress", "读书目标 50 本", { title: "读书", current: 18, target: 50 }, "current");
    rejects("book_record", "在读《三体》", { title: "三体", author: "刘慈欣" }, "author");
    rejects("option_comparison", "比较 A 和 B", { title: "对比", options: ["A", "B"], criteria: [{ name: "价格", values: [100, 200] }] }, "criteria");
  });
  it("does not attribute a quote the user never said", () => rejects("quote_note", "记一句鼓励的话",
    { text: "千里之行，始于足下。", author: "老子" }, "署名"));
  it("never trusts a bookmark title the page or user did not provide", () => {
    const result = build("web_bookmark", "收藏这个网站 https://github.com/xyflow/xyflow", { url: "https://github.com/xyflow/xyflow", title: "最好的流程图库" });
    const card = result.ok ? created(result.actions)[0] : undefined;
    expect(card?.type === "LinkPreviewCard" && card.displayProps.title).toBeUndefined();
    expect(card?.sourceData).toMatchObject({ fetched: false });
  });
  it("uses a fetched page as evidence and cites it", () => {
    const page = { url: "https://news.example.com/metro", title: "5号线南延段开通", text: "地铁5号线南延段将于10月25日开通运营，新增6座车站。", fetchedAt: "2026-10-17T01:00:00.000Z", provider: "vivic-bounded-https", readFullPage: true, truncated: false };
    const result = buildSceneActions([{ scene_id: "news_summary", data: { headline: "5号线南延段开通", summary: "5号线南延段将于10月25日开通运营，新增6座车站。", url: page.url, publishedAt: "2026-10-25" } }],
      request(`帮我摘要这篇新闻 ${page.url}`, { page }));
    const card = result.ok ? created(result.actions)[0] : undefined;
    expect(card?.sources).toEqual([{ title: page.title, url: page.url, fetchedAt: page.fetchedAt, provider: page.provider, readFullPage: true }]);
  });
  it("rejects model edits that introduce unseen numbers or dates", () => {
    const target = { id: "goal", type: "ProgressRingCard", displayProps: { title: "读书", current: 18, target: 50 }, sourceDataSummary: {}, layout: { x: 0, y: 0 } };
    const req = { text: "读书进度更新到 20 本", ctx: ctx([target]), now: SCENE_NOW };
    expect(sceneUpdateIssue([{ type: "card.update", targetId: "goal", displayProps: { current: 20 } }], req)).toBeNull();
    expect(sceneUpdateIssue([{ type: "card.update", targetId: "goal", displayProps: { current: 25 } }], req)).toContain("数值");
  });
});

describe("routing guards", () => {
  it("recognises only explicit card-form instructions", () => {
    expect(explicitScene("用时间线展示我们的故事")).toBe("historical_timeline");
    expect(explicitScene("做成月历")).toBe("monthly_calendar");
    expect(explicitScene("以照片墙形式展示")).toBe("photo_gallery");
    expect(explicitScene("帮我做个周计划")).toBe("weekly_schedule");
    expect(explicitScene("距离生日还有 25 天")).toBeNull();
    expect(explicitScene("今天有什么要完成")).toBeNull();
  });
  it("keeps date countdowns out of the minute-timer reminder extractor", () => {
    for (const text of ["帮我做个生日倒计时，11月11日", "距离考试还有 30 天倒计时", "离春节倒计时"]) {
      expect(isReminderCreation(text) && !looksLikeDateCountdown(text)).toBe(false);
    }
    for (const text of ["五分钟后提醒我喝水", "十分钟倒计时", "提醒我明天还有3天的作业"]) expect(looksLikeDateCountdown(text)).toBe(false);
  });
  it("fetches a page only for one https link the user wants summarised or saved", () => {
    expect(sceneSourceUrl("收藏这个网站 https://github.com/xyflow/xyflow")).toBe("https://github.com/xyflow/xyflow");
    expect(sceneSourceUrl("帮我摘要这篇新闻 https://a.example/n1。")).toBe("https://a.example/n1");
    expect(sceneSourceUrl("看看 http://a.example 和 https://b.example")).toBeNull();
    expect(sceneSourceUrl("https://a.example")).toBeNull();
  });
  it("lists the easily confused requests with a single expected scene each", () => {
    for (const item of CONFUSABLE_CASES) expect(SCENE_IDS).toContain(item.scene);
  });
});

describe("planner integration (stubbed model)", () => {
  const KEY = "unit-scene-key";
  const setup = (outputs: unknown[]) => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: KEY, models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "now" });
    const bodies: Array<{ system: string; user: Record<string, unknown> }> = [];
    let index = 0;
    const call = vi.fn((init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      bodies.push({ system: payload.messages[0].content, user: JSON.parse(payload.messages[1].content.split("\n上次校验失败")[0]) });
      return chatOk(outputs[Math.min(index++, outputs.length - 1)]);
    });
    return { deps: { credentials, stepfun: { baseUrl: "https://unit.test/v1", fetchImpl: fetchStub({ "/chat/completions": call }) } }, call, bodies };
  };
  const run = (text: string, deps: ReturnType<typeof setup>["deps"], extra: Partial<Parameters<typeof runIntent>[0]> = {}) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SCENE_NOW);
    return runIntent({ text, canvasContext: ctx(), ...extra }, deps);
  };
  const cardsOf = (result: IntentResult): CardRecord[] => created(result.envelope?.actions ?? []);

  it.each(SCENE_CASES)("chat → $scene card through the real pipeline", async ({ scene, input, payload }) => {
    const { deps, bodies } = setup([{ cards: [{ scene_id: scene, card_type: SCENE_CARD_TYPE[scene], data: payload }], spokenText: "已生成卡片" }]);
    const result = await run(input, deps);
    expect(result.kind, result.message).toBe("envelope");
    const cards = cardsOf(result);
    expect(cards.map(card => card.type)).toEqual([SCENE_CARD_TYPE[scene]]);
    expect(result.envelope?.spokenText).toBe("已生成卡片");
    expect(bodies[0]!.system).toContain(`${scene} → ${SCENE_CARD_TYPE[scene]}`);
    expect(bodies[0]!.user).toMatchObject({ today: "2026-10-17 周六", timeZone: SCENE_ZONE });
  });

  it("feeds a grounding failure back once, then asks the user for the missing fact", async () => {
    const guess = { cards: [{ scene_id: "countdown", data: { title: "生日", targetDate: "2026-12-01" } }] };
    const { deps, call } = setup([guess, guess]);
    const result = await run("帮我做个生日倒计时", deps);
    expect(call).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ kind: "clarify", message: "请告诉我具体日期，我再生成卡片。" });
  });

  it("falls back to the model's plain answer when its cards never validate", async () => {
    const bad = { cards: [{ scene_id: "data_visualization", data: { chartKind: "line", points: [{ x: "a", y: 999 }] } }], reply: "可以把每天的数值告诉我，我来画趋势图。" };
    const { deps } = setup([bad, bad]);
    const result = await run("帮我看看最近的趋势", deps);
    expect(result.kind).toBe("envelope");
    expect(cardsOf(result)).toEqual([]);
    expect(result.envelope?.actions).toEqual([expect.objectContaining({ type: "subtitle.show" })]);
  });

  it("rejects scene cards smuggled into raw actions", async () => {
    const raw = { actions: [{ type: "card.create", card: { id: "q1", type: "QuoteCard", variant: "standard", displayProps: { text: "x" }, sourceData: {}, sources: [],
      layout: { x: 0, y: 0, width: 300, height: 200, pinned: false }, metadata: { createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:00:00.000Z" } } }] };
    const { deps, call } = setup([raw, raw]);
    const result = await run("记一句话：x", deps);
    expect(call).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe("clarify");
  });

  it("enforces an explicit card form when the model picks another scene", async () => {
    const list = { cards: [{ scene_id: "todo_list", data: { items: ["入学", "毕业"] } }] };
    const timeline = { cards: [{ scene_id: "historical_timeline", data: { title: "经历", events: [{ date: "2015", title: "入学" }, { date: "2019", title: "毕业" }] } }] };
    const { deps, bodies } = setup([list, timeline]);
    const result = await run("做成时间线：2015年入学，2019年毕业", deps);
    expect(cardsOf(result).map(card => card.type)).toEqual(["TimelineCard"]);
    expect(bodies).toHaveLength(2);
  });

  it("combines a canvas action with a new scene card in one envelope", async () => {
    const context = ctx([{ id: "old", type: "NoteCard", displayProps: { text: "旧便笺" }, sourceDataSummary: {}, layout: { x: 0, y: 0 } }]);
    const { deps } = setup([{ actions: [{ type: "card.delete", targetId: "old" }], cards: [{ scene_id: "quote_note", data: { text: "新的开始" } }] }]);
    const result = await run("删掉旧便笺，再记一句：新的开始", deps, { canvasContext: context });
    expect(result.envelope?.actions.map(a => a.type)).toEqual(["card.delete", "card.create"]);
  });

  it("recomputes a moved date countdown's instant on the server", async () => {
    const birthday = { id: "bd", type: "CountdownCard", displayProps: {}, layout: { x: 0, y: 0 },
      sourceDataSummary: { targetAt: "2026-11-10T16:00:00.000Z", timeZone: SCENE_ZONE, event: { title: "生日", date: "2026-11-11" } } };
    const { deps } = setup([{ actions: [{ type: "card.update", targetId: "bd", sourceData: { event: { title: "生日", date: "2026-11-12" }, targetAt: "2030-01-01T00:00:00.000Z" } }] }]);
    const result = await run("生日改成11月12日", deps, { canvasContext: ctx([birthday]) });
    expect(result.envelope?.actions[0]).toMatchObject({ type: "card.update", sourceData: { targetAt: "2026-11-11T16:00:00.000Z", event: { date: "2026-11-12" } } });
  });

  it("sends date countdowns to the scene planner, not the timer extractor", async () => {
    const { deps, bodies } = setup([{ cards: [{ scene_id: "countdown", data: { title: "考试", targetDate: "2026-11-16" } }] }]);
    const result = await run("距离考试还有 30 天倒计时", deps);
    expect(bodies[0]!.system).toContain("场景卡片");
    expect(cardsOf(result)[0]).toMatchObject({ type: "CountdownCard", sourceData: { event: { title: "考试", date: "2026-11-16" } } });
  });
});
