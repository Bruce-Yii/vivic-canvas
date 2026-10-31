import { ActionEnvelopeSchema } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import type { IntentResult } from "../intent/pipeline.js";

export interface TargetCandidate { id: string; label: string }
export interface NumberedCandidate extends TargetCandidate { number: number }
export interface DeleteConfirmation {
  proposal: IntentResult;
  targetIds: string[];
  version: number | undefined;
  snapshot: string;
  question: string;
}

/** Internal planner fields must never cross the task manager's public boundary. */
export function publicIntentResult(result: IntentResult): IntentResult {
  const { kind, envelope, hostOperation, task, locale, message, suggestions, usedProvider, trace } = result;
  return { kind,
    ...(envelope === undefined ? {} : { envelope }), ...(hostOperation === undefined ? {} : { hostOperation }),
    ...(task === undefined ? {} : { task }), ...(locale === undefined ? {} : { locale }),
    ...(message === undefined ? {} : { message }), ...(suggestions === undefined ? {} : { suggestions }),
    ...(usedProvider === undefined ? {} : { usedProvider }), ...(trace === undefined ? {} : { trace }),
  };
}

/** An affirmative must occupy the whole utterance; corrections are never consent. */
export const confirmsDeletion = (text: string): boolean =>
  /^(?:确定|确认|确定删除|确认删除|是|是的|删吧|删除吧|好|好的|可以|同意|可以删除|同意删除)[。！!]?$/u.test(text.trim());

/** Narrow affirmative deletion grammar, used only to prepare a second-turn confirmation. */
export function standaloneDeletion(text: string): "one" | "all" | undefined {
  const input = text.trim().replace(/[。！!]$/u, "");
  if (/不|别|取消|停止|如果|要是|假如|除非|条件|当(?!前)|一旦|若|的话|只要|只在|等我|待我|先|是否|能否|可否|吗|么|解释|说明|介绍|意思|含义|是什么|怎么|如何|为什么|翻译|举例|然后|顺便|并|且|同时|接着|另外|再|以及|或者|还是|和|与|及|[，,；;、\r\n?？“”‘’"'「」『』《》【】()（）\u0060]/u.test(input)
    || /(?:之后|以前|之前|以后|后)(?:请|帮我)?(?:创建|新建|添加|保存|聚焦|高亮|显示|恢复|撤销|重做|移动|固定|暂停|继续|查|搜|提醒|删|清空)/u.test(input)) return undefined;
  const prefix = "(?:(?:请帮我|帮我|请)\\s*)?";
  if (new RegExp(`^${prefix}(?:(?:删除|删掉|移除|清空)(?:当前画布(?:上|中)?(?:的)?)?(?:所有|全部)(?:的?卡片)?|清空(?:当前|整个)?画布|把(?:所有|全部)(?:的)?卡片(?:全部|都)?(?:删除|删掉|移除|清空))$`, "u").test(input)) return "all";
  if (/所有|全部|全都|清空|整个|多张|几张|[两二三四五六七八九十\d]+张/u.test(input)) return undefined;
  return new RegExp(`^${prefix}(?:只)?(?:删除|删掉|删去|移除|删)\\s*\\S[\\s\\S]*$`, "u").test(input)
    || new RegExp(`^${prefix}(?:把|将)\\s*\\S[\\s\\S]*?(?:删除|删掉|删去|移除)$`, "u").test(input) ? "one" : undefined;
}

export function numberedCandidates(candidates: TargetCandidate[], context: CanvasContext): NumberedCandidate[] {
  const seen = new Set<string>();
  const numbered: NumberedCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.id !== "string" || typeof candidate.label !== "string" || !candidate.id.length
      || candidate.id.length > 128 || seen.has(candidate.id) || context.cards.filter(card => card.id === candidate.id).length !== 1) continue;
    seen.add(candidate.id);
    numbered.push({ number: numbered.length + 1, id: candidate.id, label: candidate.label.slice(0, 120) });
    if (numbered.length === 64) break;
  }
  return numbered;
}

const chineseOrdinal = (value: string): number | undefined => {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "两") return 2;
  const digits = "一二三四五六七八九";
  if (digits.includes(value) && value.length === 1) return digits.indexOf(value) + 1;
  const match = /^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(value);
  return match ? (match[1] ? digits.indexOf(match[1]) + 1 : 1) * 10 + (match[2] ? digits.indexOf(match[2]) + 1 : 0) : undefined;
};

/** Resolve against the frozen list, never today's ordering or an arbitrary new ID. */
export function selectedCandidate(text: string, candidates: NumberedCandidate[]): NumberedCandidate | undefined {
  const input = text.trim().replace(/[。！!]$/u, "");
  const ordinal = /^(?:第)?\s*([\d一二两三四五六七八九十]+)\s*(?:号|个|张|项)?$/u.exec(input);
  if (ordinal) return candidates.find(candidate => candidate.number === chineseOrdinal(ordinal[1]!));
  const named = candidates.filter(candidate => candidate.label === input);
  return named.length === 1 ? named[0] : undefined;
}

const snapshot = (context: CanvasContext): string => JSON.stringify([...context.cards].sort((a, b) => a.id.localeCompare(b.id)));

export function deletionTargets(proposal: IntentResult): string[] {
  return [...new Set(proposal.envelope?.actions.flatMap(action => action.type === "card.delete" ? [action.targetId]
    : action.type === "cards.delete" ? action.targetIds : []) ?? [])];
}

export function freezeDeletion(proposal: IntentResult, context: CanvasContext): DeleteConfirmation | undefined {
  const parsed = ActionEnvelopeSchema.safeParse(proposal.envelope);
  if (!parsed.success || parsed.data.canvasId !== context.canvasId || proposal.hostOperation) return undefined;
  if (parsed.data.actions.some(action => action.type === "cards.delete")
    && (context.totalCardCount ?? context.cards.length) > context.cards.length) return undefined;
  const targetIds = deletionTargets(proposal);
  if (!targetIds.length || targetIds.some(id => context.cards.filter(card => card.id === id).length !== 1)) return undefined;
  const card = context.cards.find(card => card.id === targetIds[0])!;
  const label = String(card.displayProps.title ?? card.displayProps.headline ?? card.aliases?.[0]
    ?? card.displayProps.text ?? card.sourceDataSummary.reminderText ?? card.type).slice(0, 65);
  const counts = parsed.data.actions.reduce((count, action) => {
    if (action.type === "card.create") count.create++;
    if (action.type === "card.update") count.update++;
    return count;
  }, { create: 0, update: 0 });
  const extras = [counts.create ? `新增${counts.create}张卡片` : "", counts.update ? `更新${counts.update}张卡片` : ""].filter(Boolean);
  const subject = targetIds.length === 1 ? `「${label}」` : `这${targetIds.length}张卡片`;
  return { proposal: structuredClone({ ...publicIntentResult(proposal), envelope: parsed.data }), targetIds,
    version: context.version, snapshot: snapshot(context),
    question: `确定删除${subject}${extras.length ? `，并${extras.join("、")}` : ""}吗？`,
  };
}

export const deletionStillCurrent = (confirmation: DeleteConfirmation, context: CanvasContext): boolean =>
  confirmation.version === context.version && confirmation.snapshot === snapshot(context)
  && confirmation.targetIds.every(id => context.cards.filter(card => card.id === id).length === 1);
