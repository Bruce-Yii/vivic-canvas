import { z } from "zod";
import { CardRecordSchema, ComparisonCardSchema, NoteCardSchema, TravelOffersCardSchema, TravelQuerySchema, cardFieldPolicyIssue, type CardRecord, type ComparisonCard } from "@vivic/contracts";
import { buildTravelCard, demoTravelProvider, queryTravel, type TravelProvider } from "../../../apps/local-api/src/providers/travel";

export const STORAGE_KEY = "vivic.travel-space.demo.v1";
export type NoteCard = z.infer<typeof NoteCardSchema>;
export const TripInputSchema = z.strictObject({
  origin: z.string().trim().min(1).max(40), destination: z.string().trim().min(1).max(40),
  days: z.int().min(1).max(7), budget: z.number().finite().min(100).max(100000),
  preference: z.enum(["慢慢走", "城市人文", "自然放松", "亲子友好"]),
  dateText: z.string().trim().min(1).max(40),
});
export type TripInput = z.infer<typeof TripInputSchema>;
export const DEFAULT_INPUT: TripInput = { origin: "上海", destination: "杭州", days: 3, budget: 2400, preference: "慢慢走", dateText: "日期待定" };
const DaySchema = NoteCardSchema.refine(card => card.sourceData?.travelDay === true);
export const TripSchema = z.strictObject({
  input: TripInputSchema, revision: z.int().min(1), createdAt: z.iso.datetime(),
  days: z.array(DaySchema).min(1).max(7), comparison: ComparisonCardSchema, offers: TravelOffersCardSchema,
}).refine(trip => trip.days.length === trip.input.days && trip.offers.displayProps.mode === "demo"
  && trip.offers.sourceData.provider === "vivic-demo"
  && trip.offers.displayProps.query.destination === trip.input.destination);
export type Trip = z.infer<typeof TripSchema>;
export type Scenario = "ok" | "empty" | "error";

function common(id: string, now: string) {
  return { id, variant: "standard", sources: [], layout: { x: 0, y: 0, width: 400, height: 360, pinned: false }, metadata: { createdAt: now, updatedAt: now } };
}
const activities: Record<TripInput["preference"], string[]> = {
  "慢慢走": ["找一条适合步行的街区，留时间认识这座城市", "给喜欢的咖啡馆或小店留一个下午", "把时间留给沿途风景，不赶下一站"],
  "城市人文": ["挑选一座感兴趣的博物馆，出发前核对开放与预约", "沿老街慢行，记录建筑与街区故事", "留一段时间给当地书店或文化空间"],
  "自然放松": ["选择一处公共绿地，按天气和体力调整步行", "在水边或树荫下休息，把节奏放慢", "预留半天自由活动，遇到好天气再决定方向"],
  "亲子友好": ["选择一处适合家人步行的公共空间，安排途中休息", "留出午休时间，下午只安排一个感兴趣的体验", "让家人共同选择今天的活动，预留返程余量"],
};

/** Sample alternatives contain no price, availability, ratings or booking links. */
const spaceDemoProvider = (scenario: Scenario): TravelProvider => ({ async query(query, signal) {
  if (scenario === "error") throw new Error("intentional demo error");
  const base = await demoTravelProvider.query(query, signal);
  if (!base || typeof base !== "object") throw new Error("invalid demo result");
  return { ...base, status: scenario === "empty" ? "empty" : "ok", items: scenario === "empty" ? [] : [
    { id: "demo-walk", kind: "hotel", title: `${query.destination} · 演示 A / 城市漫步型住宿`, subtitle: "虚构住宿画像：把步行便利放在前面。没有真实酒店、价格或库存。", tags: ["DEMO", "步行偏好", "不可预订"] },
    { id: "demo-rest", kind: "hotel", title: `${query.destination} · 演示 B / 安静休息型住宿`, subtitle: "虚构住宿画像：把休息空间放在前面。请在正式查询后再决定。", tags: ["DEMO", "安静偏好", "不可预订"] },
    { id: "demo-family", kind: "hotel", title: `${query.destination} · 演示 C / 结伴出行型住宿`, subtitle: "虚构住宿画像：把同行沟通放在前面。不代表任何真实设施或服务。", tags: ["DEMO", "结伴偏好", "不可预订"] },
  ] };
} });

export async function generateTrip(raw: unknown, options: { signal?: AbortSignal; scenario?: Scenario; previous?: Trip | null; delayMs?: number } = {}): Promise<Trip> {
  const input = TripInputSchema.parse(raw);
  const { signal } = options;
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new DOMException("已取消", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, options.delayMs ?? 700);
    signal?.addEventListener("abort", cancel, { once: true });
  });
  signal?.throwIfAborted();
  const query = TravelQuerySchema.parse({ kind: "hotel", origin: input.origin, destination: input.destination, dateText: input.dateText,
    ...(input.days > 1 ? { nights: input.days - 1 } : {}) });
  const found = await queryTravel(spaceDemoProvider(options.scenario ?? "ok"), query, signal);
  if (!found.ok) throw new Error(found.message);
  signal?.throwIfAborted();
  const now = new Date().toISOString();
  const revision = (options.previous?.revision ?? 0) + 1;
  const previous = options.previous?.input.destination === input.destination ? options.previous : null;
  const offers = buildTravelCard(found.result);
  offers.displayProps.selectedIds = previous?.offers.displayProps.selectedIds.filter(id => offers.displayProps.items.some(item => item.id === id)) ?? [];
  offers.displayProps.notes = previous?.offers.displayProps.notes ?? "";
  const days = Array.from({ length: input.days }, (_, i) => NoteCardSchema.parse({
    ...common(`day-${crypto.randomUUID()}`, now), type: "NoteCard", sourceData: { travelDay: true, mode: "demo" },
    displayProps: { text: `第 ${i + 1} 天 · ${i === 0 ? "抵达与初见" : i === input.days - 1 ? "慢慢告别" : "走进城市"}`,
      bullets: [i === 0 ? `从${input.origin}前往${input.destination}，交通方式与时间待确认` : "从容早餐，按当天状态决定出门时间",
        activities[input.preference][(i + revision - 1) % 3], i === input.days - 1 ? "整理行李与返程安排，预留交通余量" : "自由晚餐，记录今天想留下的瞬间"] },
  }));
  const comparison = ComparisonCardSchema.parse({ ...common(`compare-${crypto.randomUUID()}`, now), type: "ComparisonCard", sourceData: { mode: "demo", provenance: "planning-template" }, displayProps: {
    title: "这趟旅行，想用什么节奏？", options: [{ id: "slow", name: "留白慢游", note: "给偶遇留空间" }, { id: "explore", name: "丰富探索", note: "每天一个探索主题" }],
    criteria: [{ id: "pace", name: "节奏", values: ["每天 1 个主要体验", "每天 2 个主要体验"] }, { id: "rest", name: "休息", values: ["下午留白", "穿插短休"] }, { id: "flex", name: "适合偏好", values: ["放松、亲子", "人文、探索"] }],
    recommendation: "两种方式都是规划模板。点击方案名记录偏好；具体地点、开放时间和交通需要出行前确认。",
    ...(previous?.comparison.displayProps.chosenId ? { chosenId: previous.comparison.displayProps.chosenId } : {}),
  } });
  return TripSchema.parse({ input, revision, createdAt: now, days, comparison, offers });
}

/** Standalone host has its own validated update boundary, no main owner/channel. */
export function updateTripCard(trip: Trip, id: string, patch: { displayProps?: Record<string, unknown>; sourceData?: Record<string, unknown> }): Trip | null {
  if (patch.sourceData) return null;
  const current: CardRecord | undefined = [trip.offers, trip.comparison, ...trip.days].find(card => card.id === id);
  if (!current || !patch.displayProps) return null;
  const allowed = current.type === "TravelOffersCard" ? ["selectedIds", "notes"] : current.type === "ComparisonCard" ? ["chosenId"] : ["text", "bullets"];
  if (Object.keys(patch.displayProps).some(key => !allowed.includes(key))) return null;
  const parsed = CardRecordSchema.safeParse({ ...current, displayProps: { ...current.displayProps, ...patch.displayProps } });
  if (!parsed.success || cardFieldPolicyIssue(current, parsed.data, "user")) return null;
  const candidate = { ...trip,
    offers: id === trip.offers.id ? parsed.data : trip.offers,
    comparison: id === trip.comparison.id ? parsed.data : trip.comparison,
    days: trip.days.map(card => card.id === id ? parsed.data : card),
  };
  const checked = TripSchema.safeParse(candidate);
  return checked.success ? checked.data : null;
}

export const budgetAllocation = (total: number) => {
  const lodging = Math.round(total * .4), transport = Math.round(total * .25), food = Math.round(total * .2);
  return [{ name: "住宿", amount: lodging }, { name: "交通", amount: transport }, { name: "餐饮", amount: food }, { name: "体验与机动", amount: total - lodging - transport - food }];
};
export function readTrip(storage: Pick<Storage, "getItem">): { trip: Trip | null; warning?: string } {
  try {
    const saved = storage.getItem(STORAGE_KEY);
    if (!saved) return { trip: null };
    const parsed = TripSchema.safeParse(JSON.parse(saved));
    return parsed.success ? { trip: parsed.data } : { trip: null, warning: "本机保存的旅行数据无法恢复，请重新规划。" };
  } catch { return { trip: null, warning: "浏览器暂不能读取本机保存，仍可继续体验。" }; }
}
export function writeTrip(storage: Pick<Storage, "setItem" | "removeItem">, trip: Trip | null): boolean {
  try { if (trip) storage.setItem(STORAGE_KEY, JSON.stringify(TripSchema.parse(trip))); else storage.removeItem(STORAGE_KEY); return true; } catch { return false; }
}
export type { ComparisonCard };
