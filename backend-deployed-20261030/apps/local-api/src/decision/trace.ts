import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ROUTES } from "@vivic/contracts";
import type { IntentRequest, IntentResult, PipelineDeps } from "../intent/pipeline.js";
import { splitClauses } from "./split.js";
import { resolveTarget } from "./target.js";
import type { TargetResult } from "./target.js";
import { isBuiltinRoute, type RouteResult } from "./router.js";

/** The planner shares the observer's first RPC and target lookup. */
export interface PlannerRouteHint {
  result: RouteResult | null;
  target: Promise<TargetResult | undefined>;
  all?: Promise<DecisionTrace["decisions"]>;
}

const route = z.union([z.enum(Object.keys(ROUTES) as [keyof typeof ROUTES, ...Array<keyof typeof ROUTES>]),
  z.string().max(90).regex(/^ext\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/)]);
const target = z.union([z.strictObject({ targetId: z.string().max(128) }),
  z.strictObject({ missing: z.literal(true) }), z.strictObject({ ambiguous: z.array(z.strictObject({
    id: z.string().max(128), label: z.string().max(500),
  })).max(40) })]);
const decision = z.strictObject({ text: z.string().max(500), route: route.nullable(),
  probability: z.number().min(0).max(1), probabilities: z.record(z.string(), z.number().min(0).max(1)),
  none: z.boolean(), latencyMs: z.number().nonnegative(), failed: z.boolean(), target: target.optional() });
export const DecisionTraceSchema = z.strictObject({
  id: z.string().max(128), mode: z.enum(["shadow", "on"]), status: z.enum(["pending", "complete", "failed"]),
  taskId: z.string().max(128).optional(),
  clauses: z.array(z.string().max(500)).max(3), decisions: z.array(decision).max(3),
  route: route.nullable(), probability: z.number().min(0).max(1), target: target.optional(),
  latencyMs: z.number().nonnegative(), routeLatencyMs: z.number().nonnegative(),
  legacyElapsedMs: z.number().nonnegative(), shadowWaitMs: z.number().nonnegative(),
  failedCount: z.int().min(0).max(3), legacyKind: z.string().max(32),
  legacyUsedProvider: z.string().max(32).optional(), legacyActionTypes: z.array(z.string().max(80)).max(32),
  legacyCardTypes: z.array(z.string().max(80)).max(32),
  plannerCalls: z.int().min(0).max(100).optional(),
  directClauses: z.int().min(0).max(3).optional(),
});
export type DecisionTrace = z.infer<typeof DecisionTraceSchema>;

/** Advisory only. The old execution path remains authoritative in shadow mode. */
export async function observeDecision(req: IntentRequest, deps: PipelineDeps, signal: AbortSignal | undefined,
  legacy: (hint?: Promise<PlannerRouteHint | null>) => Promise<IntentResult>): Promise<IntentResult> {
  if (!["shadow", "on"].includes(deps.router?.mode ?? "") || req.task?.receipt || req.task?.cancel) return legacy();
  const router = deps.router, clauses = splitClauses(req.text), id = `decision_${randomUUID()}`;
  if (!router || !clauses.length) return legacy();
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
    for (const text of clauses) {
      const clauseStarted = performance.now();
      try {
        const value = await router.routeUtterance(text, shadowContext, controller.signal);
        const targetPromise = value?.route && isBuiltinRoute(value.route) ? resolveTarget(text, shadowContext, value.route, router, controller.signal) : Promise.resolve(undefined);
        if (!output.length) publishHint({ result: value, target: targetPromise, all });
        const selected = await targetPromise;
        output.push(value ? { text, ...value, failed: false, ...(selected ? { target: selected } : {}) }
          : { text, route: null, probability: 0, probabilities: {}, none: true, latencyMs: Math.round(performance.now() - clauseStarted), failed: true });
        if (value?.route === "focus" && value.probability >= .8 && selected && "targetId" in selected) {
          shadowContext = { ...shadowContext, focusHistory: [...shadowContext.focusHistory, selected.targetId].slice(-20) };
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
    return { id, mode: router.mode === "on" ? "on" : "shadow", status: !rows ? "pending" : failures ? "failed" : "complete",
      ...(req.task?.id ? { taskId: req.task.id } : {}),
      clauses, decisions: rows ?? [], route: first?.route ?? null, probability: first?.probability ?? 0,
      ...(first?.target ? { target: first.target } : {}),
      latencyMs: decisionElapsedMs ?? Math.round(performance.now() - start), routeLatencyMs: first?.latencyMs ?? 0,
      legacyElapsedMs, shadowWaitMs, failedCount: failures, legacyKind: result.kind,
      ...(result.usedProvider ? { legacyUsedProvider: result.usedProvider } : {}),
      legacyActionTypes: [...actions.map(action => action.type), ...(result.hostOperation ? [result.hostOperation.kind] : [])],
      legacyCardTypes: actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []),
      ...(deps.decisionTelemetry ? { plannerCalls: deps.decisionTelemetry.plannerCalls, directClauses: deps.decisionTelemetry.directClauses } : {}),
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
