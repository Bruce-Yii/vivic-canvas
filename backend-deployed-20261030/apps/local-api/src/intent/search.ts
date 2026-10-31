import { randomUUID } from "node:crypto";
import { ActionEnvelopeSchema } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import type { SearchEvidence } from "../search/index.js";
import { publicHttpsUrl } from "../search/policy.js";
import { chineseNumber } from "./reminders.js";
import type { SearchSummary } from "./searchSummary.js";

/** Conservative, explicit query entry. Mixed destructive instructions stay in
 * the planner instead of quietly executing only their search clause. */
export const searchQuery = (text: string): string | null => {
  const raw = text.trim();
  if (/^(?:查看|查询当前|查询刚才)/.test(raw) || /[，,；;]\s*(?:再|并|然后)?\s*(?:删除|取消|放大|聚焦|创建|添加)/.test(raw)) return null;
  const find = raw.match(/^(?:请帮我|请|帮我)?\s*找(?:一下|一找)?\s*(.+)$/);
  if (find && /资料|文档|网页|网站|开源|官方|库/.test(find[1]!) && !/待办|便笺|便签|提醒|倒计时|然后|同时|并且|顺便|并(?:删除|创建|添加|聚焦)|再(?:删除|创建|添加)|不要|不用|[；;\n]/.test(find[1]!)) return find[1]!.trim();
  const match = raw.match(/^(?:请帮我|请|帮我)?\s*(?:搜索|搜一下|搜一搜|搜|查找|查一下|查一查|查查|查询|查)\s*(.+)$/);
  return match?.[1]?.trim() || null;
};

/** Without any model, a plainly informational question is looked up instead of
 * refused. Anything touching the canvas or mixing instructions is left alone. */
export const offlineSearchQuery = (text: string): string | null => {
  const raw = text.trim();
  if (raw.length < 2 || raw.length > 120) return null;
  if (/卡片|便笺|便签|笔记|待办|提醒|倒计时|计时|闹钟|删除|聚焦|放大|缩小|创建|添加|新建|画布|显示|隐藏|恢复|撤销|展开|收起|固定|移动|整理|然后|同时|顺便|并且|不要|不用|[；;\n]/.test(raw)) return null;
  if (!/新闻|最新|最近|近况|消息|动态|行情|股价|股市|大盘|收盘|汇率|油价|金价|价格|多少钱|票价|比分|赛程|赛果|上映|发布会?|是什么|是谁|什么是|怎么样|哪些|哪个|哪家|有什么|介绍一下|百科|官网|攻略|排名|榜单/.test(raw)) return null;
  const query = raw.replace(/^(?:请问|我想知道|想知道|告诉我|你知道)\s*/, "").replace(/[吗呢呀啊吧]?\s*[？?。!！]*$/, "").trim();
  return query.length >= 2 ? query : null;
};
const textOnly = (text: string, max: number) => text.replace(/<[^>]*>/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The tool's citations remain data. No webpage text is interpreted as actions
 * or forwarded to a model, and no claim of full-page reading is made. */
export const buildSearchEnvelope = (query: string, ctx: CanvasContext, results: SearchEvidence[], summary?: SearchSummary, fallbackNote?: string) => {
  const countMatch = query.match(/([一二两三四五六七八九十\d]+)\s*(?:个|款|种|家|条|篇)/);
  const count = Math.min(5, Math.max(1, (countMatch ? chineseNumber(countMatch[1]!) : null) ?? 3));
  const unique = new Set<string>();
  const rows = results.filter(result => {
    try {
      const url = publicHttpsUrl(result.url).href;
      if (unique.has(url) || !Number.isFinite(Date.parse(result.fetchedAt))) return false;
      unique.add(url); return true;
    } catch { return false; }
  }).slice(0, count);
  if (!rows.length) return null;
  const stamp = new Date().toISOString();
  const items = summary?.slice(0, count).map(item => ({ title: item.title, snippet: item.summary,
    sources: [...new Set(item.sourceIndices)].map(index => results[index]!).filter(Boolean), summarized: true }))
    ?? rows.map(row => ({ title: row.title, snippet: row.snippet, sources: [row], summarized: false }));
  const actions = items.map((item, index) => {
    const row = item.sources[0]!;
    const url = publicHttpsUrl(row.url);
    const excerpt = textOnly(item.snippet, 700);
    const firstSentence = excerpt.match(/^.*?[。！？]|^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? excerpt;
    return { type: "card.create" as const, card: {
      id: `search_${randomUUID()}`, type: "SearchResultCard" as const, variant: "minimal" as const,
      displayProps: { title: textOnly(item.title, 140) || url.hostname,
        summary: (item.summarized ? excerpt : firstSentence).slice(0, 240), sourceLabel: url.hostname },
      sourceData: { query, excerpt: textOnly(item.sources.map(source => source.snippet).join("\n"), 3500), summaryMethod: item.summarized ? "model-cited-evidence" : "provider-excerpt" },
      sources: item.sources.map(source => ({ title: textOnly(source.title, 500), url: publicHttpsUrl(source.url).href, fetchedAt: source.fetchedAt,
        provider: source.provider, readFullPage: false })),
      layout: { x: (index % 3) * 308, y: Math.floor(index / 3) * 180, width: 288, height: 180, pinned: false },
      metadata: { createdAt: stamp, updatedAt: stamp, aliases: [textOnly(item.title, 80)] },
    } };
  });
  return ActionEnvelopeSchema.parse({ schemaVersion: "0.6", requestId: `search_${randomUUID()}`,
    canvasId: ctx.canvasId, spokenText: fallbackNote ? `${fallbackNote}，整理了 ${items.length} 条结果` : `已整理 ${items.length} 条结果`,
    actions: [...(ctx.stage === "STANDBY" ? [{ type: "stage.awaken" }] : []), ...actions, { type: "canvas.fit" }],
  });
};
