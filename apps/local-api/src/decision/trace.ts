import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ROUTES } from "@vivic/contracts";
import type { IntentRequest, IntentResult, PipelineDeps } from "../intent/pipeline.js";
import { splitClauses } from "./split.js";
import { planDeterministic } from "../intent/plans.js";
import { hasExplicitCardReference, resolveTarget, targetedRoutes } from "./target.js";
import type { TargetResult } from "./target.js";
import { isBuiltinRoute, type DecisionRouteId, type RouteResult } from "./router.js";
import { immediateGreeting, literalContractRoute, literalRoute } from "./on.js";

/** The planner shares the observer's first RPC and target lookup. */
export interface PlannerRouteHint {
  result: RouteResult | null;
  target: Promise<TargetResult | undefined>;
  all?: Promise<DecisionTrace["decisions"]>;
}
/** Clause → contract → card ids. It answers "which clause produced what" without
 * granting anything: a plan only proves provenance after the host commits it. */
export interface ClausePlan { clause: number; contract: string; cardIds: string[]; source: "rules" | "planner" }
/** Cards actually built per clause. Types and counts only: never titles or text. */
export interface ClauseBuild { clause: number; cards: string[]; n: number }

const route = z.union([z.enum(Object.keys(ROUTES) as [keyof typeof ROUTES, ...Array<keyof typeof ROUTES>]),
  z.string().max(90).regex(/^ext\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/)]);
/** Why a target was chosen; optional for older traces and callers. */
const targetSource = z.enum(["title", "alias", "focus", "ordinal", "type", "spatial", "classifier", "frozen", "user_pick", "missing", "ambiguous"]);
const target = z.union([z.strictObject({ targetId: z.string().max(128), source: targetSource.optional() }),
  z.strictObject({ missing: z.literal(true), source: targetSource.optional() }), z.strictObject({ ambiguous: z.array(z.strictObject({
    id: z.string().max(128), label: z.string().max(500),
  })).max(40), source: targetSource.optional() })]);
const built = z.strictObject({ cards: z.array(z.string().max(80)).max(12), n: z.int().min(0).max(12) });
const decision = z.strictObject({ text: z.string().max(500), route: route.nullable(),
  probability: z.number().min(0).max(1), probabilities: z.record(z.string(), z.number().min(0).max(1)),
  none: z.boolean(), latencyMs: z.number().nonnegative(), failed: z.boolean(), target: target.optional(),
  built: built.optional(), source: z.enum(["rules", "decision"]).optional(),
  // `route` stays null when no classifier ran; this says where it came from:
  // rules, the 4B model, a skipped classifier, or the main planner's contract.
  routeSource: z.enum(["rules", "model", "skipped", "planner"]).optional() });
const plan = z.strictObject({ clause: z.int().min(0).max(2), contract: z.string().min(1).max(100),
  cardIds: z.array(z.string().max(128)).max(12), source: z.enum(["rules", "planner"]) });
export const DecisionTraceSchema = z.strictObject({
  id: z.string().max(128), mode: z.enum(["shadow", "on"]), status: z.enum(["pending", "complete", "failed"]),
  taskId: z.string().max(128).optional(),
  /** HTTP/task request id, so container logs and decision_log can be joined to trace.id. */
  requestId: z.string().max(128).optional(),
  clauses: z.array(z.string().max(500)).max(3), decisions: z.array(decision).max(3),
  route: route.nullable(), probability: z.number().min(0).max(1), target: target.optional(),
  latencyMs: z.number().nonnegative(), routeLatencyMs: z.number().nonnegative(),
  legacyElapsedMs: z.number().nonnegative(), shadowWaitMs: z.number().nonnegative(),
  failedCount: z.int().min(0).max(3), legacyKind: z.string().max(32),
  /** Provider that produced the authoritative result: rules, stepfun,
   * deepseek, gpt, rules-offline, search or decision. A bounded string keeps
   * traces written before the deepseek label readable. */
  legacyUsedProvider: z.string().max(32).optional(), legacyActionTypes: z.array(z.string().max(80)).max(32),
  legacyCardTypes: z.array(z.string().max(80)).max(32),
  plannerCalls: z.int().min(0).max(100).optional(),
  directClauses: z.int().min(0).max(3).optional(),
  /** Which routing policy produced this turn; absent means `full` (older traces). */
  policy: z.enum(["full", "main-only"]).optional(),
  /** First published feedback sentence, in ms from the planner stage start. Absent when none was sent. */
  firstFeedbackMs: z.number().nonnegative().optional(),
  /** Backward-compatible: absent unless this turn committed an envelope. */
  plans: z.array(plan).max(12).optional(),
});
export type DecisionTrace = z.infer<typeof DecisionTraceSchema>;

/** Which approved route the rules just committed, read from the outcome only.
 *  Used solely for main-only provenance when no classifier row exists; a mixed
 *  or unrecognized batch derives nothing. */
const derivedRuleRoute = (result: IntentResult): DecisionRouteId | undefined => {
  const envelope = result.envelope;
  if (!envelope || (result.usedProvider ?? "") !== "rules") return undefined;
  const actions = envelope.actions;
  const created = [...new Set(actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []))];
  const byCard: Record<string, DecisionRouteId> = { TodoCard: "todo", NoteCard: "note", CountdownCard: "countdown",
    AnswerCard: "answer", WeeklyScheduleCard: "generate" };
  if (created.length === 1 && byCard[created[0]!]) return byCard[created[0]!];
  // A single element mutation is one route; a scene card (any other type) is generate.
  if (!created.length) {
    const mutations = [...new Set(actions.flatMap(action => action.type === "card.update" ? ["edit"]
      : action.type === "card.focus" ? ["focus"] : action.type === "card.delete" ? ["delete"]
        : action.type === "card.highlight" ? ["highlight"] : action.type === "canvas.fit" ? ["overview"]
          : action.type === "canvas.restore" ? ["restore"] : []))];
    const only = mutations[0];
    if (mutations.length === 1 && only) return only as DecisionRouteId;
    if (actions.every(action => action.type === "subtitle.show" || action.type === "subtitle.hide")) return "answer";
  }
  const hostRoute: Partial<Record<string, DecisionRouteId>> = { "card.move": "arrange", "card.pin": "arrange",
    "card.surface": "arrange", "canvas.arrange": "arrange", "canvas.organize.preview": "arrange",
    "countdown.pause": "edit", "countdown.resume": "edit", "history.undo": "undo", "history.redo": "undo" };
  const host = result.hostOperation?.kind;
  return host ? hostRoute[host] : undefined;
};

/** Advisory only. The old execution path remains authoritative in shadow mode. */
export async function observeDecision(req: IntentRequest, deps: PipelineDeps, signal: AbortSignal | undefined,
  legacy: (hint?: Promise<PlannerRouteHint | null>) => Promise<IntentResult>): Promise<IntentResult> {
  if (!["shadow", "on"].includes(deps.router?.mode ?? "") || req.task?.receipt || req.task?.cancel) return legacy();
  const router = deps.router, clauses = splitClauses(req.text), id = `decision_${randomUUID()}`;
  if (!router || !clauses.length) return legacy();
  // `main-only` never calls the 4B. The observer still publishes rule rows and
  // explicit "skipped" rows so the plan/execution path sees the same clause
  // shape, and telemetry can tell a skipped classifier apart from a failure.
  const mainOnly = router.policy === "main-only";
  const greeting = router.mode === "on" && immediateGreeting(req);
  const start = performance.now(), controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  let rows: DecisionTrace["decisions"] | undefined;
  let decisionElapsedMs: number | undefined;
  let publishHint!: (hint: PlannerRouteHint | null) => void;
  const hint = new Promise<PlannerRouteHint | null>(resolve => { publishHint = resolve; });
  let publishAll!: (rows: DecisionTrace["decisions"]) => void;
  const all = new Promise<DecisionTrace["decisions"]>(resolve => { publishAll = resolve; });
  const pending = (async () => {
    const output: DecisionTrace["decisions"] = [];
    let shadowContext = req.canvasContext;
    // A focus clause sets the working card for a follow-up that names none.
    let inheritedTargetId: string | undefined;
    // A deterministic numbered list or weekly-plan request needs no classifier:
    // publish rule rows for every clause so the trace keeps route provenance and
    // the proposal path commits all clauses in one batch.
    const deterministic = !req.attachments?.length && !req.continuation
      ? await planDeterministic(req.text, req.canvasContext) : null;
    if (deterministic && deterministic.routes.length === clauses.length) {
      for (const [index, text] of clauses.entries()) {
        const route = deterministic.routes[index]!;
        output.push({ text, route, probability: 1, probabilities: { [route]: 1 }, none: false, latencyMs: 0,
          failed: false, source: "rules", routeSource: "rules" });
      }
      rows = output;
      publishAll(output);
      const route = deterministic.routes[0]!;
      publishHint({ result: { route, probability: 1, probabilities: { [route]: 1 }, none: false, latencyMs: 0 },
        target: Promise.resolve(undefined), all: Promise.resolve(output) });
      decisionElapsedMs = Math.round(performance.now() - start);
      return output;
    }
    for (const [index, text] of clauses.entries()) {
      const clauseStarted = performance.now();
      try {
        if (router.mode === "on") controller.signal.throwIfAborted();
        const exact = greeting ? "chat" : router.mode === "on" && !req.attachments?.length && !req.continuation && !req.resolvedTargetId && !req.resolvedTargets
          ? mainOnly ? literalContractRoute(text, shadowContext) : literalRoute(text, shadowContext, router) : undefined;
        const value = exact ? { route: exact, probability: 1, probabilities: { [exact]: 1 }, none: false,
          latencyMs: performance.now() - clauseStarted }
          : mainOnly ? { route: null, probability: 0, probabilities: {}, none: true,
            latencyMs: Math.round(performance.now() - clauseStarted) }
          : await router.routeUtterance(text, shadowContext, controller.signal);
        // Main-only has no model target: the plan resolves it deterministically
        // from the user's words, and ambiguity still asks the user.
        const inherited = inheritedTargetId && value?.route && isBuiltinRoute(value.route) && targetedRoutes.has(value.route) && value.route !== "focus"
          && !hasExplicitCardReference(text, shadowContext)
          ? Promise.resolve({ targetId: inheritedTargetId, source: "focus" as const }) : undefined;
        const targetPromise = mainOnly ? Promise.resolve(undefined) : inherited
          ?? (value?.route && isBuiltinRoute(value.route) ? resolveTarget(text, shadowContext, value.route, router, controller.signal) : Promise.resolve(undefined));
        if (!output.length) publishHint({ result: value, target: targetPromise, all });
        const selected = await targetPromise;
        // The host may have frozen a candidate the user already picked; the trace
        // should say so instead of implying the classifier chose it.
        const frozen = req.resolvedTargets?.[String(index)];
        const target = frozen ? { targetId: frozen, source: "user_pick" as const }
          : clauses.length === 1 && req.resolvedTargetId ? { targetId: req.resolvedTargetId, source: "frozen" as const } : selected;
        output.push(value ? { text, ...value, ...(exact ? { source: "rules" as const } : mainOnly ? {} : { source: "decision" as const }),
          failed: false, ...(target ? { target } : {}),
          ...(greeting || mainOnly ? { routeSource: exact ? "rules" as const : "skipped" as const } : {}) }
          : { text, route: null, probability: 0, probabilities: {}, none: true, latencyMs: Math.round(performance.now() - clauseStarted),
            failed: true, ...(mainOnly ? { routeSource: "skipped" as const } : {}) });
        if (value?.route === "focus" && value.probability >= .8 && target && "targetId" in target) {
          inheritedTargetId = target.targetId;
          shadowContext = { ...shadowContext, focusHistory: [...shadowContext.focusHistory, target.targetId].slice(-20) };
        }
      } catch {
        if (!output.length) publishHint(null);
        output.push({ text, route: null, probability: 0, probabilities: {}, none: true, latencyMs: Math.round(performance.now() - clauseStarted), failed: true });
      }
    }
    rows = output;
    publishAll(output);
    decisionElapsedMs = Math.round(performance.now() - start);
    return output;
  })();
  let result: IntentResult;
  try { result = await legacy(hint); }
  catch (error) {
    controller.abort(); signal?.removeEventListener("abort", abort);
    throw error;
  }
  const legacyElapsedMs = Math.round(performance.now() - start);
  const waitStarted = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Leave 50ms of the 300ms public budget for serialization and transport.
    if (!rows) await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, 250); })]);
  } finally {
    if (timer) clearTimeout(timer);
    // A completed SSE stream aborts its transport controller. Do not cancel the
    // detached read-only observation after an otherwise successful response.
    signal?.removeEventListener("abort", abort);
  }
  const shadowWaitMs = Math.round(performance.now() - waitStarted);
  const build = (): DecisionTrace => {
    const first = rows?.[0], failures = rows?.filter(row => row.failed).length ?? 0;
    const actions = result.envelope?.actions ?? [];
    // Provenance is only truthful for a committed proposal: drop plans whose
    // cards did not reach the returned envelope.
    const created = new Set(actions.flatMap(action => action.type === "card.create" ? [action.card.id] : []));
    const seenPlans = new Set<string>();
    const plans = result.envelope ? deps.decisionTelemetry?.plans
      ?.filter(entry => entry.cardIds.every(cardId => created.has(cardId)))
      // The host task wrapper may report the same segment twice across retries;
      // one clause/source/contract/card set is one plan.
      .filter(entry => {
        const key = `${entry.source}\u0000${entry.clause}\u0000${entry.contract}\u0000${entry.cardIds.join(",")}`;
        if (seenPlans.has(key)) return false;
        seenPlans.add(key);
        return true;
      })
      .sort((a, b) => a.clause - b.clause) : undefined;
    // Built cards are only reported by on-mode after the batch passed validation.
    const builds = new Map((deps.decisionTelemetry?.built ?? []).map(entry => [entry.clause, entry]));
    const decisions = rows?.map((row, index) => {
      // Main-only: a committed plan's contract is the only routing evidence.
      const planned = mainOnly && row.routeSource === "skipped" ? plans?.find(entry => entry.clause === index) : undefined;
      const next = planned ? { ...row, routeSource: "planner" as const } : row;
      const entry = builds.get(index);
      return entry ? { ...next, built: { cards: entry.cards, n: entry.n } } : next;
    }) ?? [];
    // Main-only rules may answer a sentence the classifier would have labelled
    // (a plain rule envelope or host operation). Provenance must not read
    // "no route" when the rules actually produced one: derive it from what was
    // committed, and only for a single-clause turn where it is unambiguous.
    const derived = mainOnly && decisions.length === 1 && !decisions[0]!.route ? derivedRuleRoute(result) : undefined;
    const routed = derived ? [{ ...decisions[0]!, route: derived, probability: 1,
      probabilities: { [derived]: 1 }, none: false, routeSource: "rules" as const }] : decisions;
    return { id, mode: router.mode === "on" ? "on" : "shadow", status: !rows ? "pending" : failures ? "failed" : "complete",
      ...(req.task?.id ? { taskId: req.task.id } : {}),
      ...(req.requestId ? { requestId: req.requestId } : {}),
      clauses, decisions: routed, route: routed[0]?.route ?? null, probability: routed[0]?.probability ?? 0,
      ...(routed[0]?.target ? { target: routed[0].target } : {}),
      latencyMs: decisionElapsedMs ?? Math.round(performance.now() - start), routeLatencyMs: first?.latencyMs ?? 0,
      legacyElapsedMs, shadowWaitMs, failedCount: failures, legacyKind: result.kind,
      ...(result.usedProvider ? { legacyUsedProvider: result.usedProvider } : {}),
      legacyActionTypes: [...actions.map(action => action.type), ...(result.hostOperation ? [result.hostOperation.kind] : [])],
      legacyCardTypes: actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []),
      ...(deps.decisionTelemetry ? { plannerCalls: deps.decisionTelemetry.plannerCalls, directClauses: deps.decisionTelemetry.directClauses } : {}),
      ...(mainOnly ? { policy: "main-only" as const } : {}),
      ...(deps.decisionTelemetry?.firstFeedbackMs !== undefined ? { firstFeedbackMs: deps.decisionTelemetry.firstFeedbackMs } : {}),
      ...(plans?.length ? { plans } : {}),
    };
  };
  const returned = build();
  const record = (trace: DecisionTrace) => {
    setImmediate(() => {
      try { void Promise.resolve(deps.onDecisionTrace?.(req, trace, result)).catch(() => {}); }
      catch { /* observer failure is noncritical */ }
    });
  };
  record(returned);
  if (!rows) void pending.then(() => record(build())).catch(() => {});
  const valid = DecisionTraceSchema.safeParse(returned);
  return valid.success ? { ...result, trace: valid.data } : result;
}
