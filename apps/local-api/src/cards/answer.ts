import { z } from "zod";
import { NewsCardSchema, SCENE_CARD_SIZES } from "@vivic/contracts";
import { createCardActions } from "./build.js";
import { defineCardContract } from "./types.js";

const display = NewsCardSchema.shape.displayProps.shape;
export const AnswerSlotsSchema = z.strictObject({
  headline: display.headline,
  summary: display.summary,
  keyPoints: display.keyPoints,
  url: display.url,
});

export const answerContract = defineCardContract({
  id: "answer",
  name: "回答卡",
  description: "用标题、简要回答和最多5个要点回答知识问题；有经校验的来源时可填 url，AI 回答不声称是新闻原文摘要。",
  examples: ["介绍一下 Google", "解释什么是光合作用"],
  cardType: "NewsCard",
  slots: AnswerSlotsSchema,
  // Reuse the renderer, not news_summary's requirement for a supplied article.
  // URL provenance is checked by the planner; no fetched evidence is invented here.
  build(slots, context, now) {
    return createCardActions({
      type: "NewsCard",
      displayProps: { ...slots, summaryBy: "ai" },
      sourceData: { contract: "answer" },
    }, SCENE_CARD_SIZES.news_summary, context, now, "standard");
  },
});
