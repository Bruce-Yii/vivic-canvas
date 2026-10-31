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
import { numberedChoiceQuestion } from "./confirmation.js";
import { isBuiltinRoute, type IntentRouter } from "./router.js";
import type { ClauseBuild, ClausePlan, PlannerRouteHint, DecisionTrace } from "./trace.js";

/** One sentence may carry several card intents. "off" keeps the pre-existing
 * rules / per-clause / whole-sentence paths; "plans" plans it once; "hybrid"
 * proposes the clauses an approved contract parses and plans only the rest. */
export type MultiCardMode = "off" | "plans" | "hybrid";
export function multiCardMode(value: string | undefined = process.env.VIVIC_MULTI_CARD_MODE): MultiCardMode {
  return value === "plans" || value === "hybrid" ? value : "off";
}

/** The host task wrapper (`taskV2`) always sends `taskContext`, so its presence
 * alone cannot mean "a follow-up". An initial task is the first fallback turn:
 * nothing has completed or been observed, no target/continuation has been frozen,
 * and the host did not scope an active-clause/subtask partition. Only the explicit
 * hybrid mode consumes this; off/plans and the host's receipt/confirmation state
 * are untouched. */
export function isInitialTask(req: IntentRequest): boolean {
  if (req.continuation || req.resolvedTargetId || req.resolvedTargets) return false;
  const value = req.taskContext;
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const empty = (item: unknown) => item === undefined || item === null || (Array.isArray(item) && item.length === 0);
  if (!empty(state.completed_steps) || !empty(state.observations)) return false;
  // `active_clause*`/`subtask` only exist after the host split or scoped this turn.
  if (["active_clause", "active_clauses", "active_clause_indexes", "subtask"].some(key => Object.hasOwn(state, key))) return false;
  // The initial fallback instruction is "只完成尚未执行的目标，不得重复已成功步骤。";
  // anything about continuing, supplementing or handling one clause is a follow-up.
  const instruction = state.instruction;
  if (typeof instruction === "string" && /继续|补充|只处理|当前子句|子任务/.test(instruction)) return false;
  return true;
}

interface OnDeps {
  router: IntentRouter;
  hint?: Promise<PlannerRouteHint | null>;
  telemetry: NonNullable<PipelineDeps["decisionTelemetry"]>;
  isCurrent?: () => boolean;
  /** Internal opt-in; HTTP JSON can never set it. The environment default is "off". */
  multiCard?: MultiCardMode;
  plan(request: IntentRequest, hint: Promise<PlannerRouteHint | null> | undefined, signal: AbortSignal): Promise<IntentResult>;
}
type Row = DecisionTrace["decisions"][number];
/** Reuse the approved contracts before paying for classification. This grants
 * no new route, target or execution permission; the normal builder still runs. */
export function literalRoute(text: string, context: IntentRequest["canvasContext"], router: IntentRouter): IntentRouteId | undefined {
  if (/不要|不用|别|如果|要是|什么意思|解释|不想|不需要|如何|怎么|是否|能否|[？?]|(?:吗|么)[。！!]?\s*$/.test(text)) return;
  const matches = Object.values(CARD_CONTRACTS).filter(contract => router.directRoutes?.has(contract.id as IntentRouteId)
    && contract.parse?.(text, context) != null);
  if (matches.length === 1) return matches[0]!.id as IntentRouteId;
}

type HybridOutcome =
  | { kind: "actions"; actions: Action[]; directClauses: number; provider?: IntentResult["usedProvider"]; say?: string; plans: ClausePlan[]; builds: ClauseBuild[] }
  | { kind: "whole" }
  | { kind: "result"; result: IntentResult };

interface HybridInput {
  req: IntentRequest;
  clauses: string[];
  rows: Row[];
  deps: OnDeps;
  signal: AbortSignal;
  check(): void;
  run<T>(work: () => Promise<T>): Promise<T>;
  plan(request: IntentRequest, hint: Promise<PlannerRouteHint | null>): Promise<IntentResult>;
}

/** M3 hybrid: every clause an approved literal contract fully parses becomes an
 * in-memory proposal (never a submission); the remaining clauses go to ONE
 * planner call as `plans[]`. The caller merges both segments by clause order,
 * validates the whole batch and returns a single envelope. Any uncertainty in
 * either segment returns one clarification and commits nothing. */
async function hybridProposal(input: HybridInput): Promise<HybridOutcome> {
  const { req, clauses, rows, deps, check, run } = input;
  const context: CardBuildContext = { ...req.canvasContext, cards: [...req.canvasContext.cards], focusHistory: [...req.canvasContext.focusHistory] };
  const ruleByClause = new Map<number, Action[]>();
  const plans: ClausePlan[] = [];
  const remaining: number[] = [];
  // Trace telemetry only: card types and counts per clause, never card text.
  const clauseBuild = (index: number, actions: Action[]): ClauseBuild => {
    const cards = actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []);
    return { clause: index, cards, n: cards.length };
  };
  const ruleBuilds = () => clauses.map((_, index) => clauseBuild(index, ruleByClause.get(index) ?? []));
  for (const [index, text] of clauses.entries()) {
    check();
    const row = rows[index];
    const route = row?.route;
    // Only a confident, approved route owning a unique literal parse may propose.
    const contract = route && isBuiltinRoute(route) && deps.router.directRoutes?.has(route) && Object.hasOwn(CARD_CONTRACTS, route)
      ? CARD_CONTRACTS[route] : undefined;
    // Threshold 0.8: only a clause whose approved route is at least this
    // confident may be built by rules; everything else is planned.
    if (!row || !contract || row.failed || row.none || row.probability < .8) { remaining.push(index); continue; }
    let built: Action[];
    // Preserve the existing verified scheduled-reminder adapter as a parser.
    const schedule = row.route === "countdown" ? scheduledReminderIntent(text, context) : null;
    if (schedule) {
      // An incomplete scheduled reminder is a rule-level question, not a planner guess.
      if (!schedule.actions) return { kind: "result", result: { kind: "clarify", message: schedule.message, usedProvider: "decision" } };
      built = schedule.actions;
    } else {
      const slots = row.route === "countdown" && looksLikeDateCountdown(text) ? null : contract.parse?.(text, context);
      if (slots === null || slots === undefined) { remaining.push(index); continue; }
      const value = await run(async () => contract.build(slots, context, new Date()));
      if (!Array.isArray(value)) return { kind: "result", result: { kind: "clarify", message: "本次包含需要单独处理的操作，请分开发送。", usedProvider: "decision" } };
      built = value;
    }
    if (!built.length) { remaining.push(index); continue; }
    const placed: Action[] = [];
    for (const action of built) {
      const next = action.type === "card.create" ? { ...action, card: { ...action.card,
        layout: { ...action.card.layout, ...newCardLayout(action.card.layout.width, action.card.layout.height, context) } } } : action;
      placed.push(next);
      if (action.type === "stage.awaken") context.stage = "WORKSPACE";
      if (next.type === "card.create") context.cards.push({ id: next.card.id, type: next.card.type, aliases: next.card.metadata.aliases,
        displayProps: next.card.displayProps, sourceDataSummary: next.card.sourceData, layout: next.card.layout });
      if (action.type === "card.focus") context.focusHistory = [...context.focusHistory, action.targetId].slice(-20);
    }
    ruleByClause.set(index, placed);
    plans.push({ clause: index, contract: contract.id, source: "rules",
      cardIds: placed.flatMap(action => action.type === "card.create" ? [action.card.id] : []) });
  }
  // directClauses counts clauses the rules actually built, not rows that merely
  // parsed: the per-clause path uses the same definition.
  if (!remaining.length) return { kind: "actions", actions: [...ruleByClause.values()].flat(), directClauses: ruleByClause.size, plans, builds: ruleBuilds() };
  // Nothing is literal: keep the existing single whole-sentence planner path.
  if (remaining.length === clauses.length) return { kind: "whole" };
  const remainingText = remaining.map(index => clauses[index]!).join("，");
  const remainingRows = remaining.map(index => rows[index]!);
  const [only] = remainingRows;
  // The observer resolved this clause against the pre-proposal canvas; a rule
  // clause may have just created the card it names ("记个便签，然后聚焦它").
  const target = only && only.route && isBuiltinRoute(only.route)
    ? input.run(() => resolveTarget(remainingText, context, only.route as IntentRouteId, deps.router, input.signal))
    : Promise.resolve(only?.target);
  const hint: PlannerRouteHint = remaining.length === 1 && only
    ? { result: { ...only, route: only.route as IntentRouteId }, target }
    : { result: null, target: Promise.resolve(undefined), all: Promise.resolve(remainingRows) };
  const request: IntentRequest = { ...req, text: remainingText, canvasContext: context, taskContext: {
    original_goal: req.text, active_clauses: remaining.map(index => clauses[index]!), active_clause_indexes: remaining,
    instruction: "只处理 active_clauses 列出的子句；其他子句已由宿主按规则处理，不得重复或遗漏。" } };
  const reported = deps.telemetry.plans?.length ?? 0;
  const planned = await input.plan(request, Promise.resolve(hint));
  check();
  if (planned.kind !== "envelope" || !planned.envelope) {
    // A host operation cannot join a rule segment: asking for it costs one turn.
    if (planned.hostOperation) return { kind: "result", result: { kind: "clarify",
      message: "这些操作需要分别处理，本次没有执行任何部分。", usedProvider: "decision" } };
    const clause = planned.targetClause;
    if (planned.kind === "clarify") return { kind: "result", result: planned.targetCandidates && typeof clause === "number"
      ? { ...planned, targetClause: remaining[clause] ?? clause } : planned };
    // A plain-text or offline answer cannot satisfy a clause that needs a card.
    if (planned.kind === "error") return { kind: "result", result: planned };
    return { kind: "result", result: { kind: "clarify",
      message: "这句话还有一项没能形成完整方案，本次没有执行任何部分；请补充或分开提出要求。", usedProvider: "decision" } };
  }
  // A verified lookup answers a different question than the literal segment, and
  // a channel-only answer has no proposal at all: neither may ride along.
  const uncovered = { kind: "result" as const, result: { kind: "clarify" as const,
    message: "这句话有一项没有形成完整方案，请分开或补充说明。", usedProvider: "decision" as const } };
  if (planned.usedProvider === "search") return uncovered;
  // Clause 1:1 coverage for the model segment, including a single remaining
  // clause. One plan per active clause; duplicates, extras, missing clauses or
  // an out-of-subset index invalidate the whole batch.
  const plannerPlans = (deps.telemetry.plans ?? []).slice(reported).filter(plan => plan.source === "planner");
  if (remaining.length > 1) {
    const covered = new Set(plannerPlans.map(plan => plan.clause));
    if (plannerPlans.length !== remaining.length || covered.size !== remaining.length
      || !remaining.every(index => covered.has(index)) || plannerPlans.some(plan => !remaining.includes(plan.clause))) return uncovered;
  } else if (plannerPlans.length !== 1 || plannerPlans[0]!.clause !== remaining[0]) return uncovered;
  // Merge in user order. Rule clauses contribute their own proposal; model
  // actions are attributed back to the clause plan that produced them, so
  // [planner, rule, planner] keeps 0 → 1 → 2 instead of hoisting both planner
  // segments to the first remaining clause. Batch-wide effects are separate.
  const batchTypes = new Set<Action["type"]>(["stage.awaken", "canvas.fit", "canvas.restore",
    "subtitle.show", "subtitle.hide", "ambient.setPreset"]);
  const modelByClause = new Map<number, Action[]>();
  const batchActions: Action[] = [];
  if (remaining.length === 1) {
    modelByClause.set(remaining[0]!, [...planned.envelope.actions]);
  } else {
    const ownerByCardId = new Map<string, number>();
    for (const entry of plannerPlans) for (const cardId of entry.cardIds) ownerByCardId.set(cardId, entry.clause);
    const contractOfAction: Partial<Record<Action["type"], string>> = {
      "card.focus": "focus", "card.highlight": "highlight", "card.delete": "delete", "card.update": "edit" };
    let current: number | undefined;
    for (const action of planned.envelope.actions) {
      if (batchTypes.has(action.type)) { batchActions.push(action); continue; }
      let clause: number | undefined;
      if (action.type === "card.create") clause = ownerByCardId.get(action.card.id);
      else {
        const contract = contractOfAction[action.type];
        const matches = contract ? plannerPlans.filter(entry => entry.contract === contract) : [];
        clause = matches.length === 1 ? matches[0]!.clause : current;
      }
      // A create outside every plan, or an effect with no owning clause, would
      // silently reorder the batch; ask instead of guessing.
      if (clause === undefined || !remaining.includes(clause)) return uncovered;
      current = clause;
      modelByClause.set(clause, [...(modelByClause.get(clause) ?? []), action]);
    }
  }
  const actions: Action[] = [];
  for (let index = 0; index < clauses.length; index++) {
    actions.push(...(ruleByClause.get(index) ?? []));
    actions.push(...(modelByClause.get(index) ?? []));
  }
  actions.push(...batchActions);
  return { kind: "actions", actions, directClauses: ruleByClause.size, provider: planned.usedProvider,
    say: planned.envelope.spokenText, plans,
    builds: clauses.map((_, index) => clauseBuild(index, [...(ruleByClause.get(index) ?? []), ...(modelByClause.get(index) ?? [])])) };
}

/** Approved routes may build proposals; the real owner/task executor still commits them. */
export async function runDecisionOn(req: IntentRequest, deps: OnDeps, signal?: AbortSignal): Promise<IntentResult> {
  const budget = createBudget(INTENT_BUDGET_MS, [signal]);
  const check = () => { budget.signal.throwIfAborted(); if (deps.isCurrent && !deps.isCurrent()) throw new Error("connection_changed"); };
  const fallback = (request = req, hint = deps.hint) => budget.run(() => deps.plan(request, hint, budget.signal));
  const mode = deps.multiCard ?? multiCardMode();
  // `main-only` never consults a classifier: the observer publishes rule rows
  // plus explicit skipped rows, and the main planner owns the rest.
  const mainOnly = deps.router.policy === "main-only";
  try {
    check();
    // Images use the trusted current-attachment path, never a text-only label.
    if (req.attachments?.length) return await fallback();
    if (req.continuation || req.resolvedTargetId || req.resolvedTargets) {
      const text = req.continuation ? `${req.continuation.utterance}\n用户补充：${req.text}` : req.text;
      const value = await budget.run(() => deps.router.routeUtterance(text, req.canvasContext, budget.signal));
      const target = req.resolvedTargetId ? Promise.resolve({ targetId: req.resolvedTargetId, source: "frozen" as const })
        : value?.route && isBuiltinRoute(value.route) ? resolveTarget(text, req.canvasContext, value.route, deps.router, budget.signal) : Promise.resolve(undefined);
      return await fallback(req, Promise.resolve({ result: value, target }));
    }
    const hint = await budget.run(() => deps.hint ?? Promise.resolve(null));
    const clauses = splitClauses(req.text);
    let ruleFallback = false;
    let rows: Row[];
    if (!hint?.result) {
      if (mainOnly) {
        // No classifier row exists by design. Rule clauses keep their literal
        // route; every other clause stays unresolved for the planner (which
        // must cover it) instead of being guessed here.
        rows = hint?.all ? await budget.run(() => hint.all!) : clauses.map(text => ({ text, route: null,
          probability: 0, probabilities: {}, none: true, latencyMs: 0, failed: false, routeSource: "skipped" as const }));
      } else {
        // A router outage must not disable already-supported literal local tasks.
        // Only uniquely parsed contracts in the explicit allow-list qualify.
        const parsed = clauses.map(text => Object.values(CARD_CONTRACTS).filter(contract => deps.router.directRoutes?.has(contract.id as IntentRouteId)
          && contract.parse?.(text, req.canvasContext) != null));
        if (parsed.some(matches => matches.length !== 1)) return await fallback();
        rows = clauses.map((text, index) => ({ text, route: parsed[index]![0]!.id as Row["route"], probability: 1,
          probabilities: {}, none: false, latencyMs: 0, failed: false }));
        ruleFallback = true;
      }
    } else rows = hint.all ? await budget.run(() => hint.all!) : clauses.length === 1
      ? [{ text: clauses[0]!, ...hint.result, failed: false }] : [];
    check();
    const protectedText = /不要|不用|别|如果|要是|什么意思|解释|不想|不需要|如何|怎么|是否|能否|[？?]|(?:吗|么)[。！!]?\s*$/.test(req.text);
    if (!protectedText) {
      // Threshold 0.8: an ambiguous target is surfaced as a question only from a
      // confident row. A weaker target hint is left to the planner instead of
      // interrupting the user with candidates the classifier was unsure about.
      const index = rows.findIndex(row => row.probability >= .8 && row.target && "ambiguous" in row.target);
      const target = rows[index]?.target;
      if (target && "ambiguous" in target) {
        // The question text and the clickable payload must be the same candidates,
        // including the length cap, so no chip can appear without its line.
        const choice = numberedChoiceQuestion("你要操作哪一张？", target.ambiguous.map((card, i) => ({ ...card, number: i + 1 })));
        return { kind: "clarify", usedProvider: "decision",
          message: choice.message, targetCandidates: choice.candidates, targetClause: index };
      }
    }
    if (rows.length !== clauses.length) return await fallback();
    // Never let a classifier turn an explanation, condition or negation into execution.
    if (protectedText) return await fallback();
    // M1: one plans[] call for the whole sentence, even when every clause is literal.
    if (mode === "plans" && clauses.length > 1 && !req.taskContext) return await fallback();
    // directRows threshold 0.8: the legacy per-clause path may use rules only
    // when every clause is a confident (>= .8), approved, uniquely parsed row.
    // One weaker row sends the whole sentence to the planner (hybrid instead
    // keeps the confident clauses local).
    const directRows = rows.every(row => !row.failed && row.route && row.probability >= .8
      && !row.none && isBuiltinRoute(row.route) && deps.router.directRoutes?.has(row.route) && Object.hasOwn(CARD_CONTRACTS, row.route));
    let context: CardBuildContext = { ...req.canvasContext, cards: [...req.canvasContext.cards], focusHistory: [...req.canvasContext.focusHistory] };
    let actions: Action[] = [];
    let directClauses = 0;
    let say: string | undefined;
    let rulePlans: ClausePlan[] = [];
    let builds: ClauseBuild[] = [];
    let usedProvider: IntentResult["usedProvider"] = ruleFallback ? "rules-offline" : rows.every(row => row.source === "rules") ? "rules"
      // main-only has no classifier decision to attribute; the planner label wins.
      : mainOnly ? undefined : "decision";
    // M3 also covers the production initial turn: the task wrapper injects
    // taskContext for every on-mode request, but an initial task has no prior
    // step, so its clauses may still propose locally before the one planner call.
    // Follow-ups (completed steps, observation, continuation or frozen target)
    // stay on the existing path.
    if (mode === "hybrid" && clauses.length > 1 && (!req.taskContext || isInitialTask(req))) {
      // M3: literal clauses propose first, the remaining subset costs one planner call.
      const outcome = await hybridProposal({ req, clauses, rows, deps, signal: budget.signal, check, run: budget.run, plan: (request, partHint) => fallback(request, partHint) });
      if (outcome.kind === "whole") return await fallback();
      if (outcome.kind === "result") return outcome.result;
      actions = outcome.actions; directClauses = outcome.directClauses; builds = outcome.builds;
      usedProvider = outcome.provider ?? usedProvider; say = outcome.say; rulePlans = outcome.plans;
    } else {
      if (!directRows) return await fallback();
      for (const [index, row] of rows.entries()) {
        check();
        const contract = CARD_CONTRACTS[row.route!];
        let built: Action[];
        let builtByRules = false;
        // Preserve the existing verified scheduled-reminder adapter as a parser.
        const schedule = row.route === "countdown" ? scheduledReminderIntent(row.text, context) : null;
        if (schedule) {
          if (!schedule.actions) return { kind: "clarify", message: schedule.message, usedProvider: "decision" };
          built = schedule.actions;
          // Same definition as hybridProposal's ruleByClause.size: only a clause
          // whose actions rules actually produced counts as a direct clause.
          if (built.length) directClauses++;
          builtByRules = built.length > 0;
        } else {
          const slots = row.route === "countdown" && looksLikeDateCountdown(row.text) ? null : contract.parse?.(row.text, context);
          if (slots !== null && slots !== undefined) {
            const value = await budget.run(async () => contract.build(slots, context, new Date()));
            if (!Array.isArray(value)) return { kind: "clarify", message: "本次包含需要单独处理的操作，请分开发送。", usedProvider: "decision" };
            built = value;
            if (built.length) directClauses++;
            builtByRules = built.length > 0;
          } else {
            const partHint: PlannerRouteHint = { result: { ...row, route: row.route as IntentRouteId }, target: Promise.resolve(row.target) };
            const partRequest: IntentRequest = rows.length === 1 ? req : { ...req, text: row.text, canvasContext: context,
              taskContext: { original_goal: req.text, active_clause: row.text,
                // The host task wrapper scopes one clause; the planner reports
                // clause 0 for it. Keep the original split index so provenance
                // lands on the user's clause, not the one-clause subset.
                ...(mode !== "off" ? { active_clause_indexes: [index] } : {}),
                instruction: "只处理当前子句，其他子句由宿主合并，不得重复或遗漏。" } };
            const planned = await fallback(partRequest, Promise.resolve(partHint));
            check();
            if (!planned.envelope) return planned.hostOperation ? { kind: "clarify", message: "这些操作需要分别处理，本次没有执行任何部分。", usedProvider: "decision" } : planned;
            usedProvider = planned.usedProvider ?? usedProvider;
            built = planned.envelope.actions;
          }
        }
        // A follow-up keeps this per-clause path even when hybrid is selected; a
        // locally built clause is still a rule proposal and belongs in the trace
        // next to the planner's plans.
        if (builtByRules && mode === "hybrid") {
          rulePlans.push({ clause: index, contract: row.route!, source: "rules",
            cardIds: built.flatMap(action => action.type === "card.create" ? [action.card.id] : []) });
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
        const builtCards = built.flatMap(action => action.type === "card.create" ? [action.card.type] : []);
        builds.push({ clause: index, cards: builtCards, n: builtCards.length });
      }
    }
    check();
    const merged = normalizeBatchCamera(actions).filter((action, i, all) => action.type !== "stage.awaken" || all.findIndex(a => a.type === "stage.awaken") === i);
    // Each card came from a host contract or the existing grounded slot planner.
    const prebuilt = new Set(merged.flatMap(action => action.type === "card.create" ? [action.card.id] : []));
    const issue = actionExecutionIssue(merged.filter(action => action.type !== "subtitle.show" && action.type !== "subtitle.hide"), req.canvasContext, prebuilt);
    if (issue) return { kind: "clarify", message: "本次提案未通过校验，请补充或分开提出要求。", usedProvider: "decision" };
    const subtitle = merged.findLast(action => action.type === "subtitle.show");
    const channels = normalizeOutputChannels({ text: subtitle?.type === "subtitle.show" ? subtitle.text : undefined, ...(say ? { say } : {}) },
      clauses.length > 1 ? "已处理这几项要求。" : "已处理。" );
    const envelope = ActionEnvelopeSchema.safeParse({ schemaVersion: "0.6", requestId: `direct_${randomUUID()}`,
      canvasId: req.canvasContext.canvasId, ...applyOutputChannels(merged, channels) });
    if (!envelope.success) return { kind: "clarify", message: "这句话包含的操作过多或参数不完整，请分开发送。", usedProvider: "decision" };
    if (!ruleFallback) deps.telemetry.directClauses += directClauses;
    // Rule and planner segments share one provenance list: user clause order,
    // no duplicates, and each plan only after the whole batch commits.
    if (mode !== "off" && (rulePlans.length || deps.telemetry.plans?.length)) {
      const seen = new Set<string>();
      deps.telemetry.plans = [...(deps.telemetry.plans ?? []), ...rulePlans]
        .filter(plan => {
          const key = `${plan.source}\u0000${plan.clause}\u0000${plan.contract}\u0000${plan.cardIds.join(",")}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => a.clause - b.clause);
    }
    // Only a validated, committed proposal may claim which cards each clause built.
    if (builds.length) deps.telemetry.built = builds;
    return { kind: "envelope", envelope: envelope.data, usedProvider };
  } catch {
    return { kind: "error", message: budget.signal.reason?.name === "TimeoutError" ? "本次请求超时，未执行任何动作。" : "请求已取消或连接已变更，未执行任何动作。", usedProvider: "decision" };
  } finally { budget.dispose(); }
}
