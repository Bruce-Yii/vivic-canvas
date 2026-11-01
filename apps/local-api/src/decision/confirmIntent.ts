import { z } from "zod";
import type { StepfunCredential } from "../credentials.js";
import { chatJson, type ChatMessage, type StepfunDeps } from "../stepfun.js";

/**
 * Semantic deletion confirmation.
 *
 * The host still owns the safety gate (freeze proposal → ask → re-check canvas),
 * but whether the user's reply means "yes / no / unclear" is a language
 * question, not a keyword list. One small JSON-mode model call decides it;
 * the deterministic grammar in confirmation.ts is only an offline fallback.
 */
export type ConfirmationDecision = "confirm" | "cancel" | "unclear";

const DecisionSchema = z.strictObject({ decision: z.enum(["confirm", "cancel", "unclear"]) });

const SYSTEM = [
  "你是删除确认判定器。只输出 JSON：{\"decision\":\"confirm\"|\"cancel\"|\"unclear\"}。",
  "判定规则：",
  "1. confirm：用户明确同意删除刚才问的那张/那些卡（如「嗯」「行吧」「可以」「删吧」「对，删掉」）。",
  "2. cancel：用户拒绝、取消、暂缓、改主意，或要求改删别的东西（如「先别」「算了」「等一下」「不要这张」「改成删待办」）。",
  "3. unclear：含糊、只是提问、补充信息、复述目标、或无法确定是否同意（如「这张是哪个」「为什么」「嗯？」）。",
  "不要执行任何操作；不要输出 JSON 之外的文字。",
].join("\n");

export async function classifyDeletionConfirmation(
  credential: StepfunCredential,
  transport: StepfunDeps,
  question: string,
  reply: string,
  signal?: AbortSignal,
): Promise<ConfirmationDecision | undefined> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: JSON.stringify({ question, reply }) },
  ];
  const result = await chatJson(credential, messages, { ...transport, signal }, { maxTokens: 64 });
  if (!result.ok) return undefined;
  const parsed = DecisionSchema.safeParse(result.value);
  return parsed.success ? parsed.data.decision : undefined;
}
