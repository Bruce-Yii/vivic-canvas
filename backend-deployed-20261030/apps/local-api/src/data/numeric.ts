export interface NumericRow { label: string; value: number }
export type NumericIntent = { kind: "table" | "bar" | "line" | "pie"; rows: NumericRow[] } | { kind: "clarify"; message: string };
const instruction = /删除|清空|取消|撤销|恢复|聚焦|放大|缩小|切换|倒计时|提醒|待办|天气|然后|并且|同时|接着|再帮|再画|再建|再删|另外|以及|并(?:创建|生成|删除|清空|记录|显示)/;
export const isMixedInstruction = (text: string) => instruction.test(text);
const example = "表格需要你提供数据。请回复一组「名称 数值」，如「周一3，周二5，周三4」；也可完整输入「用表格记录：周一3，周二5，周三4」。";

/** The grammar could not extract user-provided data; a model may fill grounded slots. */
export function needsNumericSlotExtraction(text: string): boolean {
  const parsed = parseNumericIntent(text);
  return parsed?.kind === "clarify" && parsed.message === example && /\d/.test(text) && !isMixedInstruction(text);
}

/** One explicit, bounded data series only; never infer, aggregate or fabricate values. */
export function parseNumericIntent(text: string): NumericIntent | null {
  if (!/表格|柱状图|条形图|折线图|饼图|图表/.test(text)) return null;
  if (isMixedInstruction(text)) return { kind: "clarify", message: "这条指令包含多个操作，请拆成单项指令；本次没有执行任何部分。" };
  const raw = text.replace(/^(?:请帮我|请|帮我|给我)\s*/, "").replace(/[。！!]$/, "").trim();
  if (/^(?:(?:创建|新建|生成|建|做|做个|制作|添加)(?:一?[个张])?)?(?:空白|空的|空)?表格(?:卡片|卡)?$/.test(raw)) return { kind: "table", rows: [] };
  const table = raw.match(/^(?:用表格(?:记录|展示|表示)|(?:创建|新建|生成|做个|制作)(?:一?[个张])?表格|表格(?:记录)?|把(?:这组|这些)?数据(?:整理|做)成表格)\s*[：:]\s*(.+)$/s);
  const chart = raw.match(/^(?:把(?:这组|这些)?数据)?(?:画成|绘成|生成|创建|制作|画个|用)?(柱状图|条形图|折线图|饼图)(?:记录|展示|表示)?\s*[：:]\s*(.+)$/s);
  if (!table && !chart) return { kind: "clarify", message: example };
  const kinds = { 柱状图: "bar", 条形图: "bar", 折线图: "line", 饼图: "pie" } as const;
  const kind = table ? "table" : kinds[chart![1] as keyof typeof kinds];
  const body = table?.[1] ?? chart![2]!;
  const chunks = body.split(/[,，;；\n]/);
  if (chunks.length < 1 || chunks.length > 30 || chunks.some(value => !value.trim())) return { kind: "clarify", message: example };
  const rows: NumericRow[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    // Labels with digits require an explicit separator to avoid Q13 => Q1:3 guessing.
    const match = chunk.trim().match(/^([\p{L}\p{N}][\p{L}\p{M}\p{N} _\-]{0,59}?)\s*[:：=]\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))$/u)
      ?? chunk.trim().match(/^([\p{L}][\p{L}\p{M} _\-]{0,59}?)\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))$/u);
    if (!match) return { kind: "clarify", message: example };
    const label = match[1]!.trim();
    const value = Number(match[2]);
    const literal = match[2]!;
    const fractional = literal.split(".")[1] ?? "";
    // A round-trip check prevents silently rounding a user-supplied decimal.
    const canonical = literal.replace(/^\+/, "").replace(/^(-?)0+(?=\d)/, "$1")
      .replace(/^(-?)\./, (_value, sign: string) => `${sign}0.`).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    if (!label || seen.has(label) || !Number.isFinite(value) || Math.abs(value) > 1e12
      || fractional.length > 6 || (value !== 0 && String(value) !== canonical)) return { kind: "clarify", message: "数据标签须唯一，数值须明确且不超过一万亿、最多六位小数；本次没有生成卡片。" };
    // No unsupported units, percentages, missing values or multi-series coercion.
    seen.add(label); rows.push({ label, value });
  }
  if (kind === "pie" && (rows.some(row => row.value < 0) || !rows.some(row => row.value > 0))) {
    return { kind: "clarify", message: "饼图需要非负数值，且至少一项大于零。" };
  }
  return { kind, rows };
}
