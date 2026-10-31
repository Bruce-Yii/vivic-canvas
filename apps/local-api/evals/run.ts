import { pathToFileURL } from "node:url";
import { SCENE_CARD_TYPE, type CardRecord } from "@vivic/contracts";
import { buildSystemPrompt, buildUserPrompt } from "../src/intent/prompt.js";
import { buildScenePrompt, sceneContext } from "../src/scenes/index.js";
import { buildAllSceneActions } from "../src/scenes/extensions.js";
import { chatJson } from "../src/stepfun.js";
import { emptyContext } from "../tests/helpers.js";
import { GOLDEN_CASES, GOLDEN_NOW, GOLDEN_ZONE, type GoldenCase } from "./golden.js";

const at = (value: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, key) => v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined, value);
export const matchesGolden = (card: CardRecord | undefined, golden: GoldenCase): boolean => card?.type === SCENE_CARD_TYPE[golden.scene]
  && Object.entries(golden.fields ?? {}).every(([path, expected]) => JSON.stringify(at(card, path)) === JSON.stringify(expected));

export async function evaluateIntents(options: { live?: boolean; limit?: number } = {}) {
  const cases = GOLDEN_CASES.slice(0, options.limit ?? GOLDEN_CASES.length);
  const key = options.live ? process.env.VIVIC_EVAL_API_KEY : undefined;
  const baseUrl = process.env.VIVIC_EVAL_BASE_URL, model = process.env.VIVIC_EVAL_MODEL;
  if (options.live && (!key || !baseUrl || !model)) throw new Error("--live requires VIVIC_EVAL_API_KEY, VIVIC_EVAL_BASE_URL and VIVIC_EVAL_MODEL");
  const rows: Array<{ id: string; pass: boolean; elapsedMs: number }> = [];
  for (const golden of cases) {
    const started = performance.now();
    const req = { text: golden.input, ctx: { ...emptyContext(), timeZone: GOLDEN_ZONE }, now: GOLDEN_NOW };
    let rawCards: unknown[] = [{ scene_id: golden.scene, data: golden.payload }];
    if (options.live) {
      const user = JSON.stringify({ ...JSON.parse(buildUserPrompt(golden.input, req.ctx)), now: new Date(GOLDEN_NOW).toISOString(), ...sceneContext(req) });
      const result = await chatJson({ apiKey: key!, models: [model!], defaultModel: model!, checkedAt: "eval" }, [
        { role: "system", content: buildSystemPrompt() + buildScenePrompt() }, { role: "user", content: user },
      ], { baseUrl: baseUrl! }, { maxTokens: 4096 });
      const value = result.ok && result.value && typeof result.value === "object" ? result.value as Record<string, unknown> : null;
      if (golden.expect === "clarify") {
        rows.push({ id: golden.id, pass: Boolean(value && typeof value.clarify === "string" && !value.cards && !value.actions), elapsedMs: Math.round(performance.now() - started) });
        continue;
      }
      if (!value || !Array.isArray(value.cards) || value.clarify) { rows.push({ id: golden.id, pass: false, elapsedMs: Math.round(performance.now() - started) }); continue; }
      rawCards = value.cards;
    }
    const built = await buildAllSceneActions(rawCards, req, []);
    const pass = golden.expect === "clarify" ? !built.ok : built.ok && built.cards.length === 1 && matchesGolden(built.cards[0], golden);
    rows.push({ id: golden.id, pass, elapsedMs: Math.round(performance.now() - started) });
  }
  const latencies = rows.map(row => row.elapsedMs).sort((a, b) => a - b);
  return { mode: options.live ? "live-model" : "offline-expected-payload-replay", total: rows.length, passed: rows.filter(row => row.pass).length,
    failedIds: rows.filter(row => !row.pass).map(row => row.id), p50Ms: latencies[Math.floor(latencies.length * 0.5)] ?? 0,
    p95Ms: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0,
    systemPromptCharacters: buildSystemPrompt().length + buildScenePrompt().length,
    limitation: options.live ? "固定评测时钟；按场景、契约、字段校验，不代表视觉或真实服务质量。" : "仅验证golden提取结果经过真实校验/builder；不衡量模型理解或模型延迟。" };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const live = process.argv.includes("--live");
  const limitArg = process.argv.find(arg => arg.startsWith("--limit="));
  evaluateIntents({ live, ...(limitArg ? { limit: Number(limitArg.split("=")[1]) } : {}) }).then(report => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.passed !== report.total) process.exitCode = 1;
  }).catch(() => { process.stderr.write("评测失败；live模式须显式提供评测专用环境变量，未输出凭据或模型原文。\n"); process.exitCode = 1; });
}
