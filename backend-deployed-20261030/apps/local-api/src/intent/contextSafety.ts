import type { CanvasContext } from "../schemas.js";

/** A bounded context is a search aid, never authority for whole-canvas order or cardinality. */
export function incompleteCanvasIssue(text: string, ctx: CanvasContext): string | null {
  const total = (ctx as CanvasContext & { totalCardCount?: number }).totalCardCount;
  if (!total || total <= ctx.cards.length) return null;
  if (/^(?:请帮我|帮我|请)?\s*(?:创建|新建|新增|生成|记录|整理|做一张|做个).{0,12}(?:待办|便笺|便签|笔记|清单|卡片|计划|方案|路线图|时间线|通知)/.test(text)
    && !/(?:同时|然后|顺便|并且|并).{0,12}(?:删除|清空|修改|替换|聚焦|放大)/.test(text)) return null;
  const actsOnExisting = /删除|移除|清空|改成|改为|更新|修改|替换|追加|补充|标记|勾选|取消|展开|折叠|收起|聚焦|放大|高亮|暂停|继续|移动|复制|转换|转成|当.*待办.*完成/.test(text);
  if (!actsOnExisting) return null;
  if (/所有|全部|整个|整张画布|全都|一并|清空/.test(text)
    || /第\s*[\d一二两三四五六七八九十百]+\s*(?:张|个|份)(?:便笺|便签|笔记|卡片|表格|图表|待办|提醒|倒计时)?|(?:最)?左边|(?:最)?右边|左侧|右侧|最上|最下|第一张|最后一张|最新|最旧|刚才的/.test(text)) {
    return "画布卡片较多，当前只读取了部分上下文，无法可靠按顺序或批量修改。请先聚焦目标卡片，或明确卡片名称。";
  }
  const named = ctx.cards.some(card => text.includes(card.id) || card.aliases?.some(alias => alias.length >= 2 && text.includes(alias)));
  const latestFocus = ctx.focusHistory.at(-1);
  const focused = Boolean(latestFocus && ctx.cards.some(card => card.id === latestFocus)
    && /当前|聚焦|这张|这个|它|那张/.test(text));
  if (!named && !focused) return "当前只读取了部分画布，不能据此认定只有一张匹配卡片。请先聚焦目标卡片，或明确卡片名称。";
  return null;
}
