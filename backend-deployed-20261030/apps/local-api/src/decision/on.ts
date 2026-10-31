import { randomUUID } from "node:crypto";
import { ActionEnvelopeSchema, type Action, type IntentRouteId } from "@vivic/contracts";
import { CARD_CONTRACTS } from "../cards/index.js";
import type { CardBuildContext } from "../cards/types.js";
import { newCardLayout } from "../cards/build.js";
import { createBudget } from "../intent/budget.js";
import { INTENT_BUDGET_MS } from "../config.js";
import type { IntentRequest, IntentResult, PipelineDeps } from "../intent/pipeline.js";
import { normalizeBatchCamera, actionExecutionIssue } from "../intent/validation.js";
import { normalizeOutputChannels, applyOutputChannels } from "../intent/channels.js";
import { scheduledReminderIntent } from "../intent/scheduledReminders.js";
import { looksLikeDateCountdown } from "../scenes/index.js";
import { splitClauses } from "./split.js";
import { resolveTarget } from "./target.js";
import { isBuiltinRoute, type IntentRouter } from "./router.js";
import type { PlannerRouteHint, DecisionTrace } from "./trace.js";

interface OnDeps {
  router: IntentRouter;
  hint?: Promise<PlannerRouteHint | null>;
  telemetry: NonNullable<PipelineDeps["decisionTelemetry"]>;
  isCurrent?: () => boolean;
  plan(request: IntentRequest, hint: Promise<PlannerRouteHint | null> | undefined, signal: AbortSignal): Promise<IntentResult>;
}
type Row = DecisionTrace["decisions"][number];
/** Approved routes may build proposals; the real owner/task executor still commits them. */
export async function runDecisionOn(req: IntentRequest, deps: OnDeps, signal?: AbortSignal): Promise<IntentResult> {
  const budget = createBudget(INTENT_BUDGET_MS, [signal]);
  const check = () => { budget.signal.throwIfAborted(); if (deps.isCurrent && !deps.isCurrent()) throw new Error("connection_changed"); };
  const fallback = (request = req, hint = deps.hint) => budget.run(() => deps.plan(request, hint, budget.signal));
  try {
    check();
    // Images use the trusted current-attachment path, never a text-only label.
    if (req.attachments?.length) return await fallback();
    if (req.continuation || req.resolvedTargetId || req.resolvedTargets) {
      const text = req.continuation ? `${req.continuation.utterance}\n用户补充：${req.text}` : req.text;
      const value = await budget.run(() => deps.router.routeUtterance(text, req.canvasContext, budget.signal));
      const target = req.resolvedTargetId ? Promise.resolve({ targetId: req.resolvedTargetId })
        : value?.route && isBuiltinRoute(value.route) ? resolveTarget(text, req.canvasContext, value.route, deps.router, budget.signal) : Promise.resolve(undefined);
      return await fallback(req, Promise.resolve({ result: value, target }));
    }
    const hint = await budget.run(() => deps.hint ?? Promise.resolve(null));
    const clauses = splitClauses(req.text);
    let ruleFallback = false;
    let rows: Row[];
    if (!hint?.result) {
      // A router outage must not disable already-supported literal local tasks.
      // Only uniquely parsed contracts in the explicit allow-list qualify.
      const parsed = clauses.map(text => Object.values(CARD_CONTRACTS).filter(contract => deps.router.directRoutes?.has(contract.id as IntentRouteId)
        && contract.parse?.(text, req.canvasContext) != null));
      if (parsed.some(matches => matches.length !== 1)) return await fallback();
      rows = clauses.map((text, index) => ({ text, route: parsed[index]![0]!.id as Row["route"], probability: 1,
        probabilities: {}, none: false, latencyMs: 0, failed: false }));
      ruleFallback = true;
    } else rows = hint.all ? await budget.run(() => hint.all!) : clauses.length === 1
      ? [{ text: clauses[0]!, ...hint.result, failed: false }] : [];
    check();
    const protectedText = /不要|不用|别|如果|要是|什么意思|解释|不想|不需要/.test(req.text);
    if (!protectedText) {
      const index = rows.findIndex(row => row.probability >= .8 && row.target && "ambiguous" in row.target);
      const target = rows[index]?.target;
      if (target && "ambiguous" in target) return { kind: "clarify", usedProvider: "decision",
        message: `你要操作哪一张？${target.ambiguous.slice(0, 5).map((card, i) => `${i + 1}. ${card.label}`).join(" ")}`.slice(0, 180),
        targetCandidates: target.ambiguous, targetClause: index };
    }
    if (rows.length !== clauses.length || rows.some(row => row.failed || !row.route || row.probability < .8
      || row.none || !isBuiltinRoute(row.route) || !deps.router.directRoutes?.has(row.route) || !Object.hasOwn(CARD_CONTRACTS, row.route))) return await fallback();
    // Never let a classifier turn an explanation, condition or negation into execution.
    if (protectedText) return await fallback();
    let context: CardBuildContext = { ...req.canvasContext, cards: [...req.canvasContext.cards], focusHistory: [...req.canvasContext.focusHistory] };
    const actions: Action[] = [];
    let directClauses = 0;
    let usedProvider: IntentResult["usedProvider"] = ruleFallback ? "rules-offline" : "decision";
    for (const row of rows) {
      check();
      const contract = CARD_CONTRACTS[row.route!];
      let built: Action[];
      // Preserve the existing verified scheduled-reminder adapter as a parser.
      const schedule = row.route === "countdown" ? scheduledReminderIntent(row.text, context) : null;
      if (schedule) {
        if (!schedule.actions) return { kind: "clarify", message: schedule.message, usedProvider: "decision" };
        built = schedule.actions; directClauses++;
      } else {
        const slots = row.route === "countdown" && looksLikeDateCountdown(row.text) ? null : contract.parse?.(row.text, context);
        if (slots !== null && slots !== undefined) {
          const value = await budget.run(async () => contract.build(slots, context, new Date()));
          if (!Array.isArray(value)) return { kind: "clarify", message: "本次包含需要单独处理的操作，请分开发送。", usedProvider: "decision" };
          built = value; directClauses++;
        } else {
          const partHint: PlannerRouteHint = { result: { ...row, route: row.route as IntentRouteId }, target: Promise.resolve(row.target) };
          const partRequest: IntentRequest = rows.length === 1 ? req : { ...req, text: row.text, canvasContext: context,
            taskContext: { original_goal: req.text, active_clause: row.text, instruction: "只处理当前子句，其他子句由宿主合并，不得重复或遗漏。" } };
          const planned = await fallback(partRequest, Promise.resolve(partHint));
          check();
          if (!planned.envelope) return planned.hostOperation ? { kind: "clarify", message: "这些操作需要分别处理，本次没有执行任何部分。", usedProvider: "decision" } : planned;
          usedProvider = planned.usedProvider ?? usedProvider;
          built = planned.envelope.actions;
        }
      }
      for (const action of built) {
        const placed = action.type === "card.create" ? { ...action, card: { ...action.card,
          layout: { ...action.card.layout, ...newCardLayout(action.card.layout.width, action.card.layout.height, context) } } } : action;
        actions.push(placed);
        if (action.type === "stage.awaken") context.stage = "WORKSPACE";
        if (placed.type === "card.create") context.cards.push({ id: placed.card.id, type: placed.card.type, aliases: placed.card.metadata.aliases,
          displayProps: placed.card.displayProps, sourceDataSummary: placed.card.sourceData, layout: placed.card.layout });
        if (action.type === "card.focus") context.focusHistory = [...context.focusHistory, action.targetId].slice(-20);
      }
    }
    check();
    const merged = normalizeBatchCamera(actions).filter((action, i, all) => action.type !== "stage.awaken" || all.findIndex(a => a.type === "stage.awaken") === i);
    // Each card came from a host contract or the existing grounded slot planner.
    const prebuilt = new Set(merged.flatMap(action => action.type === "card.create" ? [action.card.id] : []));
    const issue = actionExecutionIssue(merged.filter(action => action.type !== "subtitle.show" && action.type !== "subtitle.hide"), req.canvasContext, prebuilt);
    if (issue) return { kind: "clarify", message: "本次提案未通过校验，请补充或分开提出要求。", usedProvider: "decision" };
    const subtitle = merged.findLast(action => action.type === "subtitle.show");
    const channels = normalizeOutputChannels({ text: subtitle?.type === "subtitle.show" ? subtitle.text : undefined },
      rows.length > 1 ? "已处理这几项要求。" : "已处理。" );
    const envelope = ActionEnvelopeSchema.safeParse({ schemaVersion: "0.6", requestId: `direct_${randomUUID()}`,
      canvasId: req.canvasContext.canvasId, ...applyOutputChannels(merged, channels) });
    if (!envelope.success) return { kind: "clarify", message: "这句话包含的操作过多或参数不完整，请分开发送。", usedProvider: "decision" };
    if (!ruleFallback) deps.telemetry.directClauses += directClauses;
    return { kind: "envelope", envelope: envelope.data, usedProvider };
  } catch {
    return { kind: "error", message: budget.signal.reason?.name === "TimeoutError" ? "本次请求超时，未执行任何动作。" : "请求已取消或连接已变更，未执行任何动作。", usedProvider: "decision" };
  } finally { budget.dispose(); }
}
