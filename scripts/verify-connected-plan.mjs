#!/usr/bin/env node
// Uses the existing local proxy + in-memory connection. Never reads a provider
// key, records a microphone, dispatches a canvas action or opens audio output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const base = "http://localhost:5173";
const dir = new URL("../evidence/phase2-connected-silent/", import.meta.url);
const report = { checkedAt: new Date().toISOString(), audioPlayed: false,
  microphoneCaptured: false, actionsDispatched: false, cases: [] };
await mkdir(dir, { recursive: true });
const save = () => writeFile(new URL("live.json", dir), JSON.stringify(report, null, 2) + "\n");
async function request(path, body) {
  const started = performance.now();
  const multipart = body instanceof FormData;
  const res = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
    headers: { Origin: base, ...(!multipart && body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(100_000) });
  const bytes = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get("content-type") ?? "";
  return { http: res.status, elapsedMs: Math.round(performance.now() - started), mime, bytes,
    json: mime.includes("json") ? JSON.parse(bytes.toString("utf8")) : undefined };
}
async function check(name, run) {
  const result = { name, ok: false };
  try { await run(result); result.ok = true; }
  catch (error) { result.error = error instanceof Error ? error.message : "Verification failed"; }
  report.cases.push(result); await save();
  console.log(JSON.stringify({ name, ok: result.ok, http: result.http, elapsedMs: result.elapsedMs, error: result.error }));
}
const context = { canvasId: "silent-api-check", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [] };
const stamp = new Date().toISOString();
const semanticCards = [8, 10, 13].map((minutes, index) => ({ id: `silent-test-${minutes}`, type: "CountdownCard",
  displayProps: {}, sourceDataSummary: { startedAt: stamp, targetAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    reminderText: ["喝水", "休息", "开会"][index] }, layout: { x: index * 304, y: 0 } }));
const status = await request("/api/providers/status");
const provider = status.json?.providers?.find(item => item.name === "stepfun");
assert.equal(provider?.connected, true, "StepFun is not connected; reconnect through Control, then rerun.");
report.provider = { name: provider.name, model: provider.defaultModel, checkedAt: provider.checkedAt };

await check("real-model-three-reminders", async out => {
  const text = "请安排三个提醒：八分钟后喝水，十分钟后休息，十三分钟后开会。";
  const r = await request("/api/intent", { text, canvasContext: context });
  Object.assign(out, { http: r.http, elapsedMs: r.elapsedMs, input: text, response: r.json });
  assert.equal(r.http, 200); assert.equal(r.json.kind, "envelope"); assert.equal(r.json.usedProvider, "stepfun");
  const cards = r.json.envelope.actions.filter(action => action.type === "card.create").map(action => action.card);
  assert.equal(cards.length, 3);
  assert.deepEqual(cards.map(card => card.sourceData.reminderText), ["喝水", "休息", "开会"]);
  const durations = cards.map(card => (Date.parse(card.sourceData.targetAt) - Date.parse(card.sourceData.startedAt)) / 1000);
  out.durationsSeconds = durations; assert.deepEqual(durations, [480, 600, 780]);
});
await check("real-model-semantic-delete", async out => {
  const text = "删除那个十三分钟左右的倒计时，其他两个保留。";
  const r = await request("/api/intent", { text, canvasContext: { ...context, cards: semanticCards } });
  Object.assign(out, { http: r.http, elapsedMs: r.elapsedMs, input: text, testContext: semanticCards, response: r.json });
  assert.equal(r.http, 200); assert.equal(r.json.kind, "envelope"); assert.equal(r.json.usedProvider, "stepfun");
  const mutations = r.json.envelope.actions.filter(action => ["card.delete", "card.update", "card.create"].includes(action.type));
  assert.deepEqual(mutations, [{ type: "card.delete", targetId: "silent-test-13" }]);
});
await check("real-stepsearch", async out => {
  const query = "React Flow official documentation";
  const r = await request("/api/search", { query });
  Object.assign(out, { http: r.http, elapsedMs: r.elapsedMs, query, response: r.json });
  assert.equal(r.http, 200); assert.equal(r.json.ok, true); assert.ok(r.json.results.length > 0);
  assert.ok(r.json.results.every(row => row.provider === "stepfun/stepsearch-mcp" && row.title && row.snippet && new URL(row.url).protocol === "https:"));
});
let wav;
await check("real-tts-silent-decode", async out => {
  const input = { text: "十分钟后提醒我喝水。", voice: "wenrounvsheng", speed: 1 };
  const r = await request("/api/speech", input);
  Object.assign(out, { http: r.http, elapsedMs: r.elapsedMs, input, mime: r.mime, bytes: r.bytes.length,
    audioPlayed: false, ...(r.json ? { response: r.json } : {}) });
  assert.equal(r.http, 200); assert.match(r.mime, /^audio\/mpeg/); assert.ok(r.bytes.length > 0);
  // Decode entirely to a PCM pipe. No player or sound-device output exists.
  const decoded = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "mp3", "-i", "pipe:0",
    "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"], { input: r.bytes, timeout: 15_000, maxBuffer: 5 * 1024 * 1024 });
  assert.equal(decoded.status, 0, "MP3 decode failed"); const pcm = decoded.stdout; assert.ok(pcm.length > 0);
  wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  Object.assign(out, { decodedWithoutErrors: true, durationSeconds: pcm.length / 32000,
    mp3Sha256: createHash("sha256").update(r.bytes).digest("hex"), rawAudioPersisted: false });
});
await check("real-asr-synthetic-speech", async out => {
  assert.ok(wav, "No valid synthesized sample available; ASR was not requested.");
  const form = new FormData(); form.append("file", new Blob([wav], { type: "audio/wav" }), "synthetic-command.wav");
  const r = await request("/api/transcribe", form);
  Object.assign(out, { http: r.http, elapsedMs: r.elapsedMs, input: "Synthetic speech from this run's TTS, no microphone", response: r.json });
  assert.equal(r.http, 200); assert.equal(r.json.ok, true);
  const text = r.json.text.replace(/[\s。.!！]/gu, "");
  assert.ok(["十分钟后提醒我喝水", "10分钟后提醒我喝水"].includes(text), "Transcript differs from the known test sentence");
});
report.completedAt = new Date().toISOString();
report.ok = report.cases.every(result => result.ok);
report.scope = "Actual connected provider requests via the local proxy; synthetic canvas context and synthesized audio. No canvas dispatch, playback, microphone capture or credential access.";
await save();
process.exitCode = report.ok ? 0 : 1;
