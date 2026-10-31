/** Explicit synthetic evaluation only; never reads canvas or account data. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DecisionManager } from "../../apps/local-api/src/decision/manager.js";
import { acceptedDecision, DECISION_ACTIONS } from "../../apps/local-api/src/decision/intent.js";
const directory = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(path.join(directory, "evaluation-cases.json"), "utf8")) as { text: string; expected: string }[];
const manager = new DecisionManager(), started = performance.now();
const rows: object[] = [];
try {
  manager.enable();
  while (manager.status().phase === "loading") await new Promise(resolve => setTimeout(resolve, 250));
  if (manager.status().phase !== "ready") throw new Error("Kev is not ready; prepare the fixed runtime first");
  const loadedMs = performance.now() - started;
  let correct = 0, accepted = 0, acceptedCorrect = 0; const times: number[] = [];
  for (const item of cases) {
    const before = performance.now(), probabilities = await manager.score(item.text), ms = performance.now() - before;
    if (!probabilities) throw new Error("Decision runtime failed during evaluation");
    const predicted = DECISION_ACTIONS[probabilities.indexOf(Math.max(...probabilities))];
    const decision = acceptedDecision(item.text, probabilities);
    if (predicted === item.expected) correct++;
    if (decision) { accepted++; if (decision === item.expected) acceptedCorrect++; }
    rows.push({ ...item, predicted, accepted: decision, ms, probabilities }); times.push(ms);
  }
  times.sort((a, b) => a - b);
  const report = { source: "fixed synthetic Chinese templates; not independent user acceptance", cases: rows.length,
    loadedMs, rawCorrect: correct, rawAccuracy: correct / rows.length, accepted, acceptedCorrect,
    acceptedPrecision: accepted ? acceptedCorrect / accepted : null, coverage: accepted / rows.length,
    p95Ms: times[Math.floor(times.length * .95)], status: manager.status(), rows };
  const out = path.join(directory, "../../evidence/next-plan", `kev-evaluation-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: out, ...report, rows: undefined }, null, 2));
  if (accepted !== acceptedCorrect) process.exitCode = 1;
} finally { manager.stop(); }
