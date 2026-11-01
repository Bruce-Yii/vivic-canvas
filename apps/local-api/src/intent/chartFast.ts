import type { Action } from "@vivic/contracts";
import { buildSceneActions } from "../scenes/index.js";
import type { CanvasContext } from "../schemas.js";

/**
 * Exact chart grammar: "柱状图/折线图/饼图" + at least two "name number"
 * pairs. This is a deterministic fast path, not an intent guess: the user
 * already named the chart and supplied every point, so no model turn is
 * needed and the old table path must not intercept it.
 */
export function chartFastPath(text: string, ctx: CanvasContext, now = Date.now()): Action[] | null {
  const kindMatch = /(柱状图|柱形图|折线图|饼图)/u.exec(text);
  if (!kindMatch) return null;
  const chartKind = kindMatch[1] === "折线图" ? "line" : kindMatch[1] === "饼图" ? "pie" : "bar";
  const points: Array<{ x: string; y: number }> = [];
  const point = /([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9]{0,11})\s*[:：]?\s*(\d+(?:\.\d+)?)/gu;
  for (const match of text.matchAll(point)) {
    const label = match[1]!.trim();
    if (/柱状|柱形|折线|饼图|做成|几个数|数据|图表/u.test(label)) continue;
    points.push({ x: label, y: Number(match[2]) });
  }
  if (points.length < 2 || points.length > 100) return null;
  const built = buildSceneActions([{ scene_id: "data_visualization", data: { chartKind, points } }],
    { text, ctx, now });
  return built.ok ? built.actions : null;
}
