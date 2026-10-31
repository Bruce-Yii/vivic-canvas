import { parseTodoSlots } from "../cards/todo.js";

/** A right-hand clause may only start a new operation; otherwise the
 * punctuation is content ("记一下。明天也要交") or a follow-up phrase
 * ("设个倒计时，然后十分钟后叫我"). */
const OPERATION = /^(?:(?:请|帮我|给我|麻烦|劳驾)\s*)?(?:把|将|创建|新建|添加|新增|设|设置|定|倒计时|开始|启动|加|记|写|生成|聚焦|放大|打开|高亮|删除|清空|显示|恢复|撤销|重做|移动|固定|取消|暂停|继续|查|搜|提醒|整理|自动排版|来|搞|弄|建|列|传送到|切换到|播放|停止)/u;
const FOLLOW_UP = /^(?:过|等).*(?:叫我|喊我|提醒我)/u;
// "给购物清单追加牛奶" edits a card but does not start with a verb.
const EDIT = /^给.{1,20}(?:追加|添加|删除|删掉|修改|改成|移到|挪到|固定|取消|打开|关闭|聚焦|高亮|放大|缩小)/u;
// A note may contain "然后明天交周报" (one note), but "然后明天北京天气"
// or "然后讲个笑话" is a second request. Explicit reminders are operations.
const SECOND_REQUEST = /提醒我|天气|新闻|汇率|股价|比分|航班|电影|附近|推荐|搜索|查一下|查查|讲个|说个|笑话|故事|翻译|计算|总结|解释/u;
const startsOperation = (text: string): boolean =>
  OPERATION.test(text) || FOLLOW_UP.test(text) || EDIT.test(text) || SECOND_REQUEST.test(text);

const SEPARATOR = /^(?:然后|顺便|并且|同时|接着|另外|，再|；|。|！|!|再|[，,])/u;
const CONJUNCTION = /^(?:然后|顺便|并且|同时|接着|另外)$/u;
const SENTENCE_END = /^(?:。|！|!)$/u;

/** Punctuation at a clause boundary belongs to the boundary, not to either
 * clause. Content punctuation inside a single clause is preserved because the
 * splitter returns the original string when no boundary is found. */
const trimClause = (text: string): string =>
  text.replace(/^[，,；;。！!\s]+/u, "").replace(/[，,；;。！!\s]+$/u, "").trim();

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
    const match = SEPARATOR.exec(original.slice(i));
    if (!match) continue;
    const left = trimClause(original.slice(start, i));
    const right = original.slice(i + match[0].length).replace(/^[，,\s]+/u, "").trim();
    if (left.length < 2 || right.length < 2) continue;
    const separator = match[0];
    // A semicolon can separate items inside one card. Only an explicit next
    // operation starts a new clause; the full list remains one contract.
    if (/^[；;]$/u.test(separator) && !startsOperation(right)) continue;
    // "I must remember X, add it to todo" names one task, not two actions.
    if (/^[，,]$/u.test(separator) && /^(?:我)?(?:要|得|需要|想)?记得/.test(left)
      && /^(?:请|帮我)?(?:加|添加|加入|记).*(?:待办|清单)/.test(right)) continue;
    // A countdown followed by 提醒我 is one timer request, not a second clause.
    if (/^[，,]$/u.test(separator) && right.startsWith("提醒") && /倒计时|计时器|分钟|小时|秒/.test(left)) continue;
    // Leave a conjunction to its own separator so it is consumed with the
    // clause ("…，顺便提醒我…" → "提醒我…", not "顺便提醒我…").
    if (/^[，,]$/u.test(separator) && /^(?:然后|顺便|并且|同时|接着|另外|再)/u.test(right)) continue;
    // A comma, full stop, exclamation mark, or 再 only separates when an
    // independent operation follows; otherwise it is note/list content or a
    // lexical use such as 再见/再快一点.
    if ((/^[，,]$/u.test(separator) || separator === "，再" || separator === "再"
      || SENTENCE_END.test(separator) || CONJUNCTION.test(separator))
      && !startsOperation(right)) continue;
    parts.push(left); start = i + match[0].length; i = start - 1;
  }
  const remainder = trimClause(original.slice(start));
  return parts.length && remainder.length >= 2 ? [...parts, remainder] : [original];
}
