import { z } from "zod";
import { createCardActions } from "./build.js";
import { defineCardContract } from "./types.js";

export const TodoSlotsSchema = z.strictObject({
  title: z.string().trim().min(1).max(80).optional(),
  items: z.array(z.string().trim().min(1).max(160)).min(1).max(30),
});

export const todoContract = defineCardContract({
  id: "todo",
  name: "待办清单",
  description: "创建包含1到30项的待办，可填写标题；条目只填写文字，编号和完成状态由程序生成。",
  examples: ["添加待办：买牛奶；交周报", "待办：订机票、订酒店"],
  cardType: "TodoCard",
  slots: TodoSlotsSchema,
  parse(text) {
    const input = text.trim();
    // Same literal list syntax as intent/rules, consuming multiline content too.
    const prefix = input.match(/^(?:加|添加|新增|创建|新建|列)(?:个|一条|几条|下)?\s*待办\s*[:：]?\s*/)
      ?? input.match(/^待办\s*[:：]\s*/);
    if (!prefix) return null;
    const body = input.slice(prefix[0].length);
    // Match separators outside quotations, retaining exact original item text.
    const unquoted = body.replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu, quote => " ".repeat(quote.length));
    if (/[“”‘’「」『』"]/u.test(unquoted)) return null;
    const parts: string[] = [];
    let start = 0;
    for (const separator of unquoted.matchAll(/[;；,，、\n]+|$/g)) {
      parts.push(body.slice(start, separator.index).trim());
      start = separator.index + separator[0].length;
    }
    const items = parts.filter(Boolean);
    if (items.some(item => /提醒|倒计时|然后|并且|顺便|同时|接着|另外|随后|如果|要是|除非|假如|否则|不要|不用|(?:别|无需)(?:创建|新建|添加|记|设|执行|删除|保存)|(?:再|并)(?:创建|新建|添加|设|删除|聚焦|显示|恢复|打开|关闭)|[。！？!?]\s*(?:显示|恢复|创建|新建|删除|取消)|(?:这张|那张|现有|已有).*(?:改成|改为|修改|删除)/.test(item)
      || /^(?:(?:请帮我|帮我|给我|请)\s*)?(?:先|再)?\s*(?:显示全部|全部显示|看全部|适应画布|恢复(?:原)?视图|退出聚焦|取消聚焦|整理(?:布局|画布)|自动排版|聚焦|高亮|清空|撤销|重做|暂停|继续|(?:删除|删掉|移除|移动|固定|修改|更新|展开|收起)(?:这|那|现有|已有|所有|全部|原|卡|便|待办|清单)|(?:把|将)(?:这|那|现有|已有))/.test(item))) return null;
    const parsed = TodoSlotsSchema.safeParse({ items });
    return parsed.success ? parsed.data : null;
  },
  build(slots, context, now) {
    return createCardActions({
      type: "TodoCard",
      displayProps: {
        ...(slots.title ? { title: slots.title } : {}),
        items: slots.items.map((text, index) => ({ id: `item-${index + 1}`, text, done: false })),
      },
      sourceData: {},
    }, { width: 288, height: 160 }, context, now);
  },
});
