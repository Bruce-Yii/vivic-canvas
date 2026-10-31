import { parseTodoSlots } from "../cards/todo.js";

/** Split only independent clauses; quoted content and conditional/negative requests stay intact. */
export function splitClauses(text: string): string[] {
  const original = text.trim();
  if (!original || /不要|别|如果|要是/.test(original)) return original ? [original] : [];
  // Explicit literal list grammar owns its contents, including verbs such as
  // “写周报”. Its parser refuses subsequent card/host operations and conditions.
  if (parseTodoSlots(original) != null) return [original];
  const quoteEnds: Record<string, string> = { "“": "”", "‘": "’", '"': '"', "'": "'", "「": "」", "『": "』" };
  const parts: string[] = [];
  let start = 0, quote = "";
  for (let i = 0; i < original.length && parts.length < 2; i++) {
    const character = original[i]!;
    if (quote) { if (character === quote) quote = ""; continue; }
    if (quoteEnds[character]) { quote = quoteEnds[character]!; continue; }
    const match = /^(?:然后|顺便|并且|同时|接着|另外|，再|；|再|[，,])/.exec(original.slice(i));
    if (!match) continue;
    const left = original.slice(start, i).replace(/[，,；;\s]+$/, "").trim();
    const right = original.slice(i + match[0].length).replace(/^[，,\s]+/, "").trim();
    if (left.length < 2 || right.length < 2) continue;
    // A semicolon can separate items inside one card. Only an explicit next
    // operation starts a new clause; the full list remains one contract.
    if (/^[；;]$/.test(match[0]) && !/^(?:(?:请|帮我|给我)\s*)?(?:把|创建|新建|设|倒计时|开始|启动|加|记|写|生成|聚焦|放大|打开|高亮|删除|清空|显示|恢复|撤销|重做|移动|固定|取消|暂停|继续|查|搜|提醒)/.test(right)) continue;
    // "I must remember X, add it to todo" names one task, not two actions.
    if (/^[，,]$/.test(match[0]) && /^(?:我)?(?:要|得|需要|想)?记得/.test(left)
      && /^(?:请|帮我)?(?:加|添加|加入|记).*(?:待办|清单)/.test(right)) continue;
    if ((/再$/.test(match[0]) || /^[，,]$/.test(match[0])) && !/^(?:(?:请|帮我|给我)\s*)?(?:把|创建|新建|设|倒计时|开始|启动|加|记|写|生成|聚焦|放大|打开|高亮|删除|清空|显示|恢复|撤销|重做|移动|固定|取消|暂停|继续|查|搜|提醒|(?:过|等).*(?:叫我|喊我|提醒我))/.test(right)) continue;
    if (/^[，,]$/.test(match[0]) && (/^提醒/.test(right) && /倒计时|计时器|分钟|小时|秒/.test(left)
      || !/创建|新建|设|倒计时|加|记|写|生成|聚焦|放大|打开|高亮|删除|清空|显示|恢复|撤销|重做|移动|固定|取消|暂停|继续|查|搜|提醒/.test(left))) continue;
    parts.push(left); start = i + match[0].length; i = start - 1;
  }
  const remainder = original.slice(start).replace(/^[，,\s]+/, "").trim();
  return parts.length && remainder.length >= 2 ? [...parts, remainder] : [original];
}
