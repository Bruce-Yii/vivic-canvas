import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ChartCardSchema, TableCardSchema, EvidenceRefSchema, type Action, type CardRecord } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import { isMixedInstruction } from "./numeric.js";
import { decodeProvenance, encodeProvenance, PROVENANCE_FIELD, type DataProvenance } from "./provenance.js";

type Card = CanvasContext["cards"][number];
type Result = { kind: "actions"; actions: Action[] } | { kind: "clarify"; message: string };
const clarify = (message: string): Result => ({ kind: "clarify", message });
const kinds = { 柱状图: "bar", 条形图: "bar", 折线图: "line", 饼图: "pie", 表格: "table" } as const;
const Sources = z.array(EvidenceRefSchema).max(15);

function ordinal(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value in digits) return digits[value]!;
  const ten = value.match(/^([一二三四五六]?)十([一二三四五六七八九]?)$/);
  return ten ? (ten[1] ? digits[ten[1]]! : 1) * 10 + (digits[ten[2]!] ?? 0) : null;
}

/** Optional enriched context works for in-process callers, without a wire schema change. */
function provenance(card: Card): DataProvenance | null {
  const enriched = card as Card & { sources?: unknown; sourceData?: unknown };
  if (enriched.sources !== undefined || enriched.sourceData !== undefined) {
    const sources = Sources.safeParse(enriched.sources);
    if (!sources.success || !enriched.sourceData || typeof enriched.sourceData !== "object" || Array.isArray(enriched.sourceData)) return null;
    const value = { sources: sources.data, sourceData: enriched.sourceData as Record<string, unknown> };
    return encodeProvenance(value) ? value : null;
  }
  const summary = card.sourceDataSummary;
  if (Object.hasOwn(summary, PROVENANCE_FIELD)) return decodeProvenance(summary[PROVENANCE_FIELD]);
  // Legacy adapter user-input cards have no external evidence. Keep their summary
  // explicitly as a summary, rather than pretending nested original data survived.
  if (summary.provenance === "user-input") {
    const sources = summary.sources === undefined ? { success: true as const, data: [] } : Sources.safeParse(summary.sources);
    if (!sources.success || sources.data.length) return null;
    const value = { sources: [], sourceData: { ...summary, provenanceCompleteness: "context-summary" } };
    return encodeProvenance(value) ? value : null;
  }
  return null;
}

/** Exact, single-target conversions. Data always come from current displayProps. */
export function transformDataIntent(text: string, ctx: CanvasContext): Result | null {
  const raw = text.trim().replace(/^(?:请帮我|请|帮我)\s*/, "").replace(/[。！!]$/, "").trim();
  const match = raw.match(/^(?:把|将)(.+?)(?:画成|绘成|转成|转换成|改成|改为)(柱状图|条形图|折线图|饼图|表格)$/);
  if (!match) return null;
  if (isMixedInstruction(raw.replace(/(?:当前)?聚焦的/g, "")) || /[；;\n]|然后|顺便|同时|并且/.test(raw)) return clarify("请一次转换一张数据卡，删除等其他操作请另发指令；本次没有执行任何部分。");
  const target = match[1]!.trim().replace(/(?:的)?数据$/, "");
  const to = kinds[match[2] as keyof typeof kinds];
  let pool = ctx.cards.filter(card => card.type === "TableCard" || card.type === "ChartCard");
  let selected: Card | undefined;
  const named = target.match(/^[「“](.+?)[」”]$/);
  if (named) {
    const matches = pool.filter(card => card.id === named[1] || card.aliases?.includes(named[1]!));
    if (matches.length === 1) selected = matches[0];
  } else {
    const description = target.match(/^(?:(这张|那张|这个|当前(?:聚焦的)?|刚才的|聚焦的|它|这份)|第([一二两三四五六七八九十\d]+)(?:张|个|份))?(表格|图表|柱状图|条形图|折线图|饼图)?$/);
    if (!description || !target) return clarify("请明确要转换的表格或图表，可指定「第2张表格」或先聚焦一张卡片。");
    const type = description[3];
    if (type === "表格") pool = pool.filter(card => card.type === "TableCard");
    else if (type) pool = pool.filter(card => card.type === "ChartCard"
      && (type === "图表" || card.displayProps.chartKind === kinds[type as keyof typeof kinds]));
    if (description[2]) {
      const index = ordinal(description[2]);
      if (index !== null && index >= 1) selected = pool[index - 1];
    } else if (pool.length === 1) selected = pool[0];
    else if (description[1]) {
      // The last entry is the latest focus; never fall back to an older card.
      const latest = ctx.focusHistory.at(-1);
      const matches = pool.filter(card => card.id === latest);
      if (matches.length === 1) selected = matches[0];
    }
  }
  if (!selected || ctx.cards.filter(card => card.id === selected!.id).length !== 1) {
    return clarify("没有唯一明确的数据卡目标，请先聚焦一张表格或图表，或指定第几张；本次没有生成卡片。");
  }
  if ((selected as Card & { contextSummary?: { truncatedFields: string[] } }).contextSummary?.truncatedFields.some(key => ["rows", "columns", "points"].includes(key))) {
    return clarify("当前数据仅有摘要，无法可靠转换完整数据；请从原卡片操作或缩小数据后重试。");
  }
  let points: Array<{ x: string | number; y: number }>;
  let axes: { xLabel?: string; yLabel?: string };
  if (selected.type === "TableCard") {
    const parsed = TableCardSchema.shape.displayProps.safeParse(selected.displayProps);
    if (!parsed.success || parsed.data.columns.length !== 2 || !parsed.data.rows.length
      || parsed.data.rows.some(row => row.length !== 2 || !(typeof row[0] === "string" && row[0].trim() || typeof row[0] === "number" && Number.isFinite(row[0]))
        || typeof row[1] !== "number" || !Number.isFinite(row[1]))) {
      return clarify("表格需明确包含两列：名称和有限数值，且每行完整；多列、空值或数值文本需要先明确整理。");
    }
    points = parsed.data.rows.map(row => ({ x: row[0] as string | number, y: row[1] as number }));
    axes = { ...(parsed.data.columns[0] && parsed.data.columns[0].length <= 60 ? { xLabel: parsed.data.columns[0] } : {}),
      ...(parsed.data.columns[1] && parsed.data.columns[1].length <= 60 ? { yLabel: parsed.data.columns[1] } : {}) };
  } else {
    const parsed = ChartCardSchema.shape.displayProps.safeParse(selected.displayProps);
    if (!parsed.success || parsed.data.points.some(point => typeof point.x === "string" && !point.x.trim())) return clarify("图表没有完整可用的数值点，不能推测或补齐数据。");
    points = parsed.data.points; axes = { ...(parsed.data.xLabel !== undefined ? { xLabel: parsed.data.xLabel } : {}),
      ...(parsed.data.yLabel !== undefined ? { yLabel: parsed.data.yLabel } : {}) };
  }
  if (points.some(point => typeof point.x === "string" && point.x.length > 300) || new Set(points.map(point => String(point.x))).size !== points.length) {
    return clarify("数据标签须完整、唯一且不超过 300 字符；本次没有合并或截断原始数据。");
  }
  if (to === "pie" && (points.some(point => point.y < 0) || !points.some(point => point.y > 0))) return clarify("饼图需要非负数值且至少一项大于零；原数据未取绝对值，也未修改。");
  const stamp = new Date().toISOString();
  const dataTransform = { fromCardId: selected.id, fromCardType: selected.type, to, at: stamp, request: text };
  if (selected.type === "ChartCard" && to !== "table") {
    // Updating the same chart retains its original sources and full sourceData
    // in the canvas, even when the compact context does not carry either one.
    return { kind: "actions", actions: [{ type: "card.update", targetId: selected.id,
      displayProps: { chartKind: to, points, ...axes }, sourceData: { dataTransform } }] };
  }
  const original = provenance(selected);
  if (!original) return clarify("当前上下文缺少原卡片的完整来源记录，请保留或补充来源后再转换；不会创建丢失出处的图表。");
  const sourceData = { ...original.sourceData, dataTransform };
  const receipt = encodeProvenance({ sources: original.sources, sourceData });
  if (!receipt) return clarify("原始来源记录过大或格式不完整，本次未转换卡片。");
  const common = { id: `data_${randomUUID()}`, variant: "minimal" as const, sources: original.sources,
    sourceData: { ...sourceData, [PROVENANCE_FIELD]: receipt },
    layout: { x: selected.layout.x + 32, y: selected.layout.y + 32, width: 320, height: 240, pinned: false },
    metadata: { createdAt: stamp, updatedAt: stamp, aliases: selected.aliases } };
  const card: CardRecord = to === "table"
    ? { ...common, type: "TableCard", displayProps: { columns: [axes.xLabel ?? "名称", axes.yLabel ?? "数值"], rows: points.map(point => [point.x, point.y]) } }
    : { ...common, type: "ChartCard", displayProps: { chartKind: to, points, ...axes } };
  return { kind: "actions", actions: [{ type: "card.create", card }] };
}
