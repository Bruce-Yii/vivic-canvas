/**
 * Live check of the real chat → model → scene card path. Sends each test
 * utterance to a RUNNING Vivic web dev server's /api/intent (the Vite proxy
 * injects the local session token) and reports which card type came back.
 * Uses the user's connected model plan, so run it deliberately, not in CI:
 *
 *   node apps/local-api/node_modules/tsx/dist/cli.mjs scripts/verify-scene-cards-live.ts http://127.0.0.1:5179 [--connect-gpt] [--only <scene_id>|no-card]
 *
 * Never prints credentials; writes a summary to evidence/scene-cards/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { SCENE_CARD_TYPE } from "../packages/contracts/src/scenes";
import { CONFUSABLE_CASES, NO_CARD_CASES, SCENE_CASES } from "../apps/local-api/tests/sceneCases";

const base = (process.argv[2] ?? "http://127.0.0.1:5179").replace(/\/+$/, "");
const timeZone = "Asia/Shanghai";
const post = async (path: string, body: unknown, timeoutMs = 120_000) => {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  return response.json() as Promise<Record<string, unknown>>;
};

if (process.argv.includes("--connect-gpt")) {
  // Reuses the authorization this machine already granted to Vivic; never starts a new login.
  console.log("connect gpt:", JSON.stringify(await post("/api/gpt/connect", { source: "vivic" })).slice(0, 160));
  console.log("select gpt:", JSON.stringify(await post("/api/providers/select", { provider: "gpt" })).slice(0, 160));
}
const status = await (await fetch(`${base}/api/providers/status`)).json() as { activeProvider?: string; providers: Array<{ name: string; connected: boolean; defaultModel?: string }> };
const active = status.providers.find(provider => provider.name === status.activeProvider);
console.log(`active provider: ${status.activeProvider} connected=${active?.connected} model=${active?.defaultModel ?? "?"}`);
if (!active?.connected) { console.log("No connected model: the live AI path cannot be verified now."); process.exit(2); }

const canvasContext = { canvasId: "live-scene-check", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone, cards: [] };
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
const cases = [...SCENE_CASES.map(item => ({ group: "scene", scene: item.scene, input: item.input })), ...CONFUSABLE_CASES.map(item => ({ group: "confusable", ...item }))]
  .filter(item => !only || item.scene === only);
const noCardCases = !only || only === "no-card" ? NO_CARD_CASES : [];
const results = [];
for (const item of cases) {
  const started = Date.now();
  let result: Record<string, unknown>;
  try { result = await post("/api/intent", { text: item.input, canvasContext }); }
  catch (error) { result = { kind: "error", message: String(error).slice(0, 120) }; }
  const actions = ((result.envelope as { actions?: Array<{ type: string; card?: { type: string; sourceData?: { event?: unknown } } }> } | undefined)?.actions ?? []);
  const types = actions.filter(action => action.type === "card.create").map(action => action.card!.type);
  const expected = SCENE_CARD_TYPE[item.scene];
  const pass = types.length >= 1 && types.every(type => type === expected);
  results.push({ ...item, expected, got: types, kind: result.kind, provider: result.usedProvider, pass,
    message: typeof result.message === "string" ? result.message.slice(0, 120) : (result.envelope as { spokenText?: string } | undefined)?.spokenText, ms: Date.now() - started });
  console.log(`${pass ? "PASS" : "MISS"} ${item.group.padEnd(10)} ${item.scene.padEnd(20)} → ${types.join(",") || result.kind} (${Date.now() - started} ms)`);
}
// Plain chat and evidence-less requests must not invent a card.
for (const item of noCardCases) {
  const started = Date.now();
  const result = await post("/api/intent", { text: item.input, canvasContext }).catch(error => ({ kind: "error", message: String(error) }) as Record<string, unknown>);
  const actions = ((result.envelope as { actions?: Array<{ type: string }> } | undefined)?.actions ?? []);
  const created = actions.filter(action => action.type === "card.create").length;
  const pass = created === 0 && result.kind !== "error";
  results.push({ group: "no-card", scene: item.expect, input: item.input, expected: "no card", got: actions.map(action => action.type), kind: result.kind,
    provider: result.usedProvider, pass, message: typeof result.message === "string" ? result.message.slice(0, 120) : (result.envelope as { spokenText?: string } | undefined)?.spokenText, ms: Date.now() - started });
  console.log(`${pass ? "PASS" : "MISS"} no-card    ${item.input.padEnd(20)} → ${result.kind} ${created ? `(${created} card)` : ""}`);
}
const passed = results.filter(item => item.pass).length;
console.log(`\n${passed}/${results.length} produced exactly the registered card type.`);
mkdirSync("evidence/scene-cards", { recursive: true });
const file = `evidence/scene-cards/live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ base, provider: status.activeProvider, model: active.defaultModel, at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
console.log(`written ${file}`);
