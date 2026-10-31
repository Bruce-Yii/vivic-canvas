import { z } from "zod";
import { createCardActions } from "./build.js";
import { defineCardContract } from "./types.js";

export const NoteSlotsSchema = z.union([
  z.strictObject({ text: z.string().trim().min(1).max(500) }),
  z.strictObject({ bullets: z.array(z.string().trim().min(1).max(180)).min(1).max(5) }),
]);

export const noteContract = defineCardContract({
  id: "note",
  name: "便笺",
  description: "保存原文 text，或1到5条 bullets；二者只选一种，不改写或截断用户的内容。引用中的命令只作为原文保存；额外执行指令须交由父层统一处理。",
  examples: ["记一下明天交周报", "便签：门禁卡放在抽屉里", "新建便笺，内容是周五下午复盘"],
  cardType: "NoteCard",
  slots: NoteSlotsSchema,
  parse(text) {
    const input = text.trim().replace(/^(?:请帮我|帮我|请)\s*/, "");
    const prefix = input.match(/^(?:(?:创建|新建|添加|记下|记|记录)(?:一?[张个条])?(?:便笺|便签|笔记)|(?:便笺|便签|笔记)(?=\s*[:：]))/)
      ?? input.match(/^(?:记一下|记下来|记下|记录一下)/);
    if (!prefix) return null;
    // Strip the prefix once, so a missing body cannot backtrack into punctuation.
    const body = input.slice(prefix[0].length).trim()
      .replace(/^(?:[，,]\s*内容(?:是|为)\s*[:：]?|内容(?:是|为)\s*[:：]?|[:：，,])\s*/, "");
    if (!/[\p{L}\p{N}\p{S}]/u.test(body)) return null;
    // Inspect only unquoted text; never change the body we store. This also
    // keeps an actual command after a quoted negation visible to the guard.
    const unquoted = body.replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`/gu, "引文");
    if (/[“”‘’「」『』"]|如果|要是|除非|假如|否则/u.test(unquoted)) return null;
    if (/(?:然后|随后|顺便|同时|接着|另外|并且|并|再|[，,；;\n。])\s*(?:(?:请帮我|帮我|给我|请)\s*)?(?:再|先|也)?\s*(?:把|将|创建|新建|添加|新增|设|倒计时|提醒|记一下|记下来|记个|生成|聚焦|高亮|删除|删掉|移除|清空|显示|恢复|撤销|重做|移动|固定|取消|暂停|继续|修改|改(?:一下|下|成|为)|打开|关闭|搜索|查一下|保存)/u.test(unquoted)) return null;
    if (/^(?:(?:请帮我|帮我|请)\s*)?(?:把|将)(?:这|那|原|已有|现有).*?(?:卡|便签|便笺|待办).*?(?:改|修改|删除|移动|固定)/u.test(unquoted)) return null;
    if (/(?:不要|别|不用|无需)\s*(?:记|保存|创建|新建|添加|设|倒计时|显示|恢复|删除|执行)/u.test(unquoted)) return null;
    const parsed = NoteSlotsSchema.safeParse({ text: body });
    return parsed.success ? parsed.data : null;
  },
  build(slots, context, now) {
    return createCardActions({ type: "NoteCard", displayProps: slots, sourceData: {} },
      { width: 320, height: 120 }, context, now);
  },
});
