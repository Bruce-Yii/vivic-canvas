import { TravelQuerySchema, type TravelQuery } from "@vivic/contracts";
import { buildCorpus, groundedDate, groundedNumber, groundedPhrase, parseChineseNumber } from "./grounding.js";
import type { SceneRequest, SceneBuild } from "./index.js";
import { buildSceneActions } from "./index.js";
import { buildTravelCard, demoTravelProvider, queryTravel, type TravelProvider } from "../providers/travel.js";

export function travelQueryIssue(query: TravelQuery, req: SceneRequest): { issue: string; ask?: string } | null {
  // Tool output, page text and canvas facts are deliberately excluded from query authority.
  const text = `${req.continuation?.utterance ?? ""}\n${req.text}`;
  const corpus = buildCorpus([text], { now: req.now, timeZone: req.ctx.timeZone ?? "Asia/Shanghai" });
  const fail = (ask: string) => ({ issue: `travel_offers：${ask}`, ask });
  if (!groundedPhrase(corpus, query.destination) || query.origin && !groundedPhrase(corpus, query.origin)) return fail("请明确出发地和目的地，不能推测城市。");
  if (query.kind === "hotel" && !/酒店|住宿|住|民宿|宾馆/.test(text)
    || query.kind === "flight" && !/航班|机票|飞机/.test(text)
    || query.kind === "poi" && !/景点|景区|门票|游玩/.test(text)) return fail("你想查询住宿、航班还是景点？");
  if (query.startDate && !groundedDate(corpus, query.startDate) && query.dateText && groundedPhrase(corpus, query.dateText)) {
    // The user supplied a usable coarse date; the planner added unsupported
    // precision. Reject that proposal and use the existing repair round.
    // No provider runs and no date is silently changed or accepted here.
    return { issue: "travel_offers.startDate 没有具体日期依据，但已有来自用户原话的dateText；保留dateText并省略编造的startDate，重新输出查询。仅说下周不能指定下周某一天，不需向用户追问已经提供的模糊日期。" };
  }
  if (query.startDate && !groundedDate(corpus, query.startDate) || query.dateText && !groundedPhrase(corpus, query.dateText)) return fail("请补充出行日期，不能推测日期。");
  if (query.kind !== "poi" && !query.startDate && !query.dateText) return fail("计划哪天出发或入住？");
  if (query.kind === "hotel" && !query.nights) return fail("计划住几晚？");
  if (query.kind === "flight" && !query.origin) return fail("从哪个城市出发？");
  for (const value of [query.nights, query.budget, query.partySize]) if (value !== undefined && !groundedNumber(corpus, value)) return fail("请补充真实的晚数、人数或预算，不可编造数字。");
  return null;
}

/** Closed offline demonstration grammar; unsupported wording still goes through the regular planner. */
export function parseTravelDemo(text: string): TravelQuery | null {
  if (/卡[：:]|然后|同时|顺便|并且|不要|不用|取消|删除|；|;/.test(text) || !/演示|DEMO|demo|住宿|酒店|住.{0,6}晚|景点|机票|航班/.test(text)) return null;
  const destination = text.match(/(?:去|到|查一下|查询|查|找)([\u4e00-\u9fff]{2,8}?)(?:的?(?:酒店|住宿|景点|机票)|住|[，,\s]|$)/)?.[1]
    ?? text.match(/([\u4e00-\u9fff]{2,6})(?:酒店|住宿|景点)/)?.[1];
  if (!destination) return null;
  const kind = /机票|航班/.test(text) ? "flight" : /景点/.test(text) ? "poi" : "hotel";
  const dateText = text.match(/下周[一二三四五六日天]?|本周[一二三四五六日天]|明天|后天|今天|\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}[日号]/)?.[0];
  const nightsText = text.match(/住\s*(\d+|[一二两三四五六七八九十]+)\s*晚/)?.[1];
  const budget = text.match(/预算\s*(\d+(?:\.\d+)?)/)?.[1];
  const origin = text.match(/从([\u4e00-\u9fff]{2,8}?)到/)?.[1];
  const query = TravelQuerySchema.safeParse({ destination, kind, ...(dateText ? { dateText } : {}),
    ...(nightsText ? { nights: /^\d+$/.test(nightsText) ? Number(nightsText) : parseChineseNumber(nightsText) } : {}),
    ...(budget ? { budget: Number(budget) } : {}), ...(origin ? { origin } : {}) });
  return query.success ? query.data : null;
}

/** Batch preparation is atomic: validate every query first, then adapters, then assemble all cards. */
export async function buildProviderSceneActions(rawCards: unknown[], req: SceneRequest, provider: TravelProvider = demoTravelProvider, signal?: AbortSignal): Promise<SceneBuild> {
  if (!rawCards.length || rawCards.length > 6) return { ok: false, issue: "一次需要1到6张卡片" };
  const { parseScenePayload } = await import("./payload.js");
  const ordinary: unknown[] = [], queries: TravelQuery[] = [];
  for (const raw of rawCards) {
    const parsed = parseScenePayload(raw);
    if (!parsed.ok) return parsed;
    if (parsed.value.scene !== "travel_offers") { ordinary.push(raw); continue; }
    const issue = travelQueryIssue(parsed.value.data, req);
    if (issue) return { ok: false, ...issue };
    queries.push(parsed.value.data);
  }
  const normal = ordinary.length ? buildSceneActions(ordinary, req) : { ok: true as const, actions: [], cards: [], ids: [] };
  if (!normal.ok) return normal;
  const cards = [...normal.cards];
  for (const query of queries) {
    const found = await queryTravel(provider, query, signal);
    if (!found.ok) return { ok: false, issue: "旅游服务查询失败", ask: found.message };
    signal?.throwIfAborted();
    cards.push(buildTravelCard(found.result, req.now));
  }
  return { ok: true, cards, ids: cards.map(card => card.id), actions: [
    ...(req.ctx.stage === "STANDBY" ? [{ type: "stage.awaken" } as const] : []), ...cards.map(card => ({ type: "card.create" as const, card })),
  ] };
}
