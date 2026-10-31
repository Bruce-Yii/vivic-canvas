/** Real StepFun Plan verification on authored fixtures. Credential only enters stdin/memory. No playback or microphone. */
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createApp } from "../apps/local-api/src/app.js";
import { CredentialStore } from "../apps/local-api/src/credentials.js";
import { validateConnection } from "../apps/local-api/src/stepfun.js";
import { SCENE_CASES, NO_CARD_CASES } from "../apps/local-api/tests/sceneCases.js";
import { SCENE_CARD_TYPE } from "../packages/contracts/src/scenes.js";
import { ActionEnvelopeSchema } from "../packages/contracts/src/actionEnvelope.js";
import { loadConfig } from "../apps/local-api/src/config.js";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// pnpm --filter exec starts inside apps/local-api. All evidence and decoder
// paths are workspace-relative, independent of the caller's working directory.
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const { serve } = createRequire(new URL("../apps/local-api/package.json", import.meta.url))("@hono/node-server");

if (process.stdin.isTTY) process.stdin.setRawMode(true);
const input = createInterface({ input: process.stdin, terminal: false });
console.log("Waiting for credential via stdin (not echoed).");
let key = "";
for await (const line of input) { key = line.trim(); input.close(); break; }
if (process.stdin.isTTY) process.stdin.setRawMode(false);
if (!key) throw new Error("Missing stdin credential");
const directory = process.argv.find(argument => argument.startsWith("--out="))?.slice(6) ?? ".cache/simple-assistant-live"; await mkdir(directory, { recursive: true });
const validated = await validateConnection(key, { baseUrl: "https://api.stepfun.com/step_plan/v1", timeoutMs: 30000 });
if (!validated.ok) { console.log(JSON.stringify({ connected: false, status: validated.status, code: validated.code })); process.exit(2); }
const credentials = new CredentialStore(); credentials.set({ apiKey: key, ...validated.value }); key = "";
const config = loadConfig({ PORT: "18886", VIVIC_MANAGED_DECISION: "off", VIVIC_ALLOWED_ORIGINS: "http://127.0.0.1:18796,http://localhost:18796,http://127.0.0.1:18886" });
let fixtureName = "none", responseNumber = 0;
const app = createApp({ config, credentials, mode: "online", fetchImpl: async (input, init) => {
  const response = await fetch(input, init);
  if (String(input).endsWith("/chat/completions") && fixtureName !== "none") {
    try {
      const data = await response.clone().json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
      const secret = credentials.getSecret()?.apiKey;
      const content = data.choices?.[0]?.message?.content;
      if (content) await writeFile(`${directory}/synthetic-${fixtureName}-${++responseNumber}.json`, JSON.stringify({ fixture: fixtureName, content: secret ? content.replaceAll(secret, "[redacted]") : content, finish: data.choices?.[0]?.finish_reason }, null, 2));
    } catch { /* Evidence collection never changes the provider result. */ }
  }
  return response;
} });
const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json", origin: "http://127.0.0.1:18796" };
const context = { canvasId: "synthetic-live-verification", version: 0, stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: "Asia/Shanghai", cards: [] };
const report: { at: string; model: string; live: boolean; microphone: boolean; playback: boolean; results: unknown[] } = { at: new Date().toISOString(), model: validated.value.defaultModel, live: true, microphone: false, playback: false, results: [] };
const save = () => writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
const post = (route: string, body: unknown) => app.fetch(new Request(`http://127.0.0.1:18886${route}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(100000) }));
try {
  console.log(JSON.stringify({ connected: true, model: validated.value.defaultModel }));
  const cases = [
    ...SCENE_CASES.map(item => ({ name: item.scene, text: item.input, expected: SCENE_CARD_TYPE[item.scene] })),
    { name: "note", text: "创建便笺，内容是：周五交付界面评审材料。", expected: "NoteCard" },
    { name: "timer", text: "倒计时25分钟", expected: "CountdownCard" },
    { name: "reminder", text: "十五分钟后提醒我喝水", expected: "CountdownCard" },
    ...NO_CARD_CASES.map((item, i) => ({ name: `no-card-${i}`, text: item.input, expected: null })),
    { name: "quoted-delete", text: "解释一下“删除全部卡片”是什么意思，不要执行。", expected: null },
  ];
  const only = process.argv.find(argument => argument.startsWith("--only="))?.slice(7);
  for (const sample of cases.filter(item => !only || only.split(",").includes(item.name))) {
    fixtureName = sample.name;
    const start = Date.now();
    try {
      const response = await post("/api/intent", { text: sample.text, canvasContext: context });
      const result = await response.json() as { kind: string; usedProvider?: string; envelope?: unknown; message?: string };
      const envelope = result.envelope ? ActionEnvelopeSchema.parse(result.envelope) : undefined;
      const types = envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []) ?? [];
      const pass = response.ok && (sample.expected ? types.length === 1 && types[0] === sample.expected
        : !types.length && result.kind !== "error" && (envelope?.actions.every(action => action.type === "subtitle.show") ?? true));
      const row = { name: sample.name, input: sample.text, pass, expected: sample.expected, types, kind: result.kind, provider: result.usedProvider, message: result.message, elapsedMs: Date.now() - start, envelope };
      report.results.push(row); console.log(JSON.stringify({ name: row.name, pass, types, kind: row.kind, ms: row.elapsedMs }));
    } catch { report.results.push({ name: sample.name, pass: false, error: "request-or-validation-failed", elapsedMs: Date.now() - start }); console.log(JSON.stringify({ name: sample.name, pass: false })); }
    await save();
  }
  if (!only || only.split(",").includes("speech")) {
    const response = await post("/api/speech", { text: "十五分钟后提醒我喝水。", voice: "wenrounvsheng" });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const valid = response.ok && bytes.length > 100 && (new TextDecoder().decode(bytes.slice(0, 3)) === "ID3" || bytes[0] === 255 && (bytes[1]! & 224) === 224);
    report.results.push({ name: "live-tts", pass: valid, status: response.status, bytes: bytes.length, sha256: valid ? createHash("sha256").update(bytes).digest("hex") : undefined });
    if (valid) await writeFile(`${directory}/speech.mp3`, bytes);
    console.log(JSON.stringify({ name: "live-tts", pass: valid, status: response.status })); await save();
    let fixture = process.argv.find(argument => argument.startsWith("--wav="))?.slice(6);
    if (valid && !fixture) {
      const convert = spawnSync(".cache/local-runtime-next/python/Scripts/python.exe", ["-c", "import sys; sys.path.insert(0,sys.argv[3]); import soundfile as sf,numpy as np; y,sr=sf.read(sys.argv[1]); y=y.mean(axis=1) if y.ndim>1 else y; n=round(len(y)*16000/sr); z=np.interp(np.arange(n)*sr/16000,np.arange(len(y)),y); sf.write(sys.argv[2],z,16000,subtype='PCM_16')", `${directory}/speech.mp3`, `${directory}/synthetic-command.wav`, ".cache/simple-assistant-live/decoder"], { windowsHide: true, stdio: "pipe" });
      if (convert.status === 0) fixture = `${directory}/synthetic-command.wav`;
      else report.results.push({ name: "asr-fixture", pass: false, error: "local-audio-decoder-unavailable" });
    }
    if (fixture) {
      const form = new FormData(); form.append("file", new Blob([await readFile(fixture)], { type: "audio/wav" }), "synthetic.wav");
      const asr = await app.fetch(new Request("http://127.0.0.1:18886/api/transcribe", { method: "POST", headers: { authorization: headers.authorization, origin: headers.origin }, body: form, signal: AbortSignal.timeout(40000) }));
      const result = await asr.json() as { ok?: boolean; text?: string; code?: string };
      const pass = asr.ok && result.ok === true && typeof result.text === "string" && result.text.includes("提醒") && result.text.includes("喝水");
      report.results.push({ name: "live-asr-synthetic", pass, status: asr.status, text: result.text, code: result.code });
      console.log(JSON.stringify({ name: "live-asr-synthetic", pass, status: asr.status })); await save();
    }
  }
  await save();
  console.log(JSON.stringify({ complete: true, passed: report.results.filter(row => (row as { pass?: boolean }).pass).length, total: report.results.length }));
  if (process.argv.includes("--serve")) {
    fixtureName = "none";
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 18886 });
    console.log("Loopback test API ready on 18886; credential remains in memory until stopped.");
    await new Promise<void>(resolve => { const stop = () => server.close(() => resolve()); process.once("SIGINT", stop); process.once("SIGTERM", stop); });
  }
} finally { await save(); app.dispose(); credentials.clear(); }
