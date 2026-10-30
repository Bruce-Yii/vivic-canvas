import { randomUUID } from "node:crypto";
import { ActionEnvelopeSchema } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import type { FetchEvidence } from "../search/client.js";

export function articleRequest(text: string): string | null {
  return text.trim().match(/^(?:请帮我|帮我|请)?\s*(?:读取|阅读|打开|查看)(?:这个网页|网页|链接)?\s*[:：]?\s*(https:\/\/\S+)$/)?.[1] ?? null;
}
export function articleEnvelope(ctx: CanvasContext, article: FetchEvidence) {
  const stamp = new Date().toISOString(), title = (article.title || new URL(article.url).hostname).slice(0, 140);
  return ActionEnvelopeSchema.parse({ schemaVersion: "0.6", canvasId: ctx.canvasId, requestId: `article_${randomUUID()}`,
    spokenText: article.truncated ? "已读取部分正文，内容超出长度限制；卡片显示正文摘录。" : "已读取网页正文，卡片显示正文摘录。",
    actions: [...(ctx.stage === "STANDBY" ? [{ type: "stage.awaken" }] : []), { type: "card.create", card: {
      id: `article_${randomUUID()}`, type: "SearchResultCard", variant: "minimal", displayProps: {
        title, summary: article.text.slice(0, 240), sourceLabel: new URL(article.url).hostname },
      sourceData: { provenance: "fetched-webpage", articleText: article.text, truncated: article.truncated, trust: "untrusted-web-data", format: article.format },
      sources: [{ title, url: article.url, fetchedAt: article.fetchedAt, provider: article.provider, readFullPage: article.readFullPage }],
      layout: { x: 0, y: 0, width: 320, height: 220, pinned: false }, metadata: { createdAt: stamp, updatedAt: stamp, aliases: [title.slice(0, 80)] },
    } }, { type: "canvas.fit" }] });
}
