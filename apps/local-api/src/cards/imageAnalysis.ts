import { NewsCardSchema, SCENE_CARD_SIZES } from "@vivic/contracts";
import { z } from "zod";
import { createCardActions } from "./build.js";
import { defineCardContract, type BuiltinCardContract } from "./types.js";

const display = NewsCardSchema.shape.displayProps.shape;
const slots = z.strictObject({
  headline: display.headline,
  summary: display.summary,
  keyPoints: display.keyPoints,
});

export const imageAnalysisContract: BuiltinCardContract = defineCardContract({
  id: "image_analysis",
  name: "图片分析",
  description: "仅分析用户本次明确发送的图片，填写一句结论、摘要和最多五条要点；看不清时澄清，不猜测。图片引用由宿主提供。",
  examples: ["分析这张图片", "总结这张图里的内容"],
  cardType: "NewsCard",
  slots,
  build(value, ctx, now) {
    if (!ctx.trustedImageRef || !/^media:image_[a-f0-9]{64}$/.test(ctx.trustedImageRef)) {
      throw new Error("图片分析需要本次请求已留存的可信图片。");
    }
    return createCardActions({
      type: "NewsCard", sourceData: {},
      displayProps: { ...value, image: ctx.trustedImageRef, summaryBy: "ai" },
    }, SCENE_CARD_SIZES.news_summary, ctx, now, "standard");
  },
});
