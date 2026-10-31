/** Isolated real online-session/provider checks. Only synthetic inputs; no camera/audio playback. */
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createOnlineHandler } from "../apps/local-api/src/online/sessions.js";
import { createOnlineSessionApp } from "../apps/local-api/src/online/appFactory.js";
import { ActionEnvelopeSchema } from "../packages/contracts/src/actionEnvelope.js";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const input = createInterface({ input: process.stdin, terminal: false });
console.log("Waiting for credential via stdin (not echoed).");
let key = "";
for await (const line of input) { key = line.trim(); input.close(); break; }
if (process.stdin.isTTY) process.stdin.setRawMode(false);
if (!key) throw Error("Missing stdin credential");
const directory = process.argv.find(argument => argument.startsWith("--out="))?.slice(6) ?? ".cache/full-acceptance-20261024/online-live";
await mkdir(directory, { recursive: true });
const origin = "https://vivic-live-verification.example";
const server = createOnlineHandler({ origin, createSessionApp: createOnlineSessionApp });
const results: Array<Record<string, unknown>> = [];
const request = (route: string, cookie = "", body?: unknown, method = body === undefined ? "GET" : "POST", requestOrigin = origin) =>
  server.fetch(new Request(origin + route, { method, headers: { origin: requestOrigin, cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) }));
const save = () => writeFile(`${directory}/report.json`, JSON.stringify({ at: new Date().toISOString(), live: true, publicDeployment: false, microphone: false, playback: false, results }, null, 2));
const record = async (row: Record<string, unknown>) => { results.push(row); console.log(JSON.stringify(row)); await save(); };
const context = { canvasId: "synthetic-online-features", version: 0, stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: "Asia/Shanghai", cards: [] };
try {
  const a = await request("/api/online/session", "", {}), b = await request("/api/online/session", "", {});
  const cookieA = a.headers.get("set-cookie")?.split(";")[0] ?? "", cookieB = b.headers.get("set-cookie")?.split(";")[0] ?? "";
  if (!a.ok || !b.ok || !cookieA || !cookieB || cookieA === cookieB) throw Error("Isolated session creation failed");
  const connected = await request("/api/credentials/stepfun/validate", cookieA, { apiKey: key });
  const connection = await connected.json() as { connected?: boolean; defaultModel?: string };
  await record({ name: "real-online-key-validation", pass: connected.ok && connection.connected === true, status: connected.status, model: connection.defaultModel });
  if (!connection.connected) throw Error("Provider connection failed");
  const isolatedText = await (await request("/api/providers/status", cookieB)).text();
  const isolated = JSON.parse(isolatedText);
  await record({ name: "real-key-session-isolation", pass: isolated.providers.every((p: { connected: boolean }) => !p.connected) && !isolatedText.includes(key) });
  const forbidden = await request("/api/intent", cookieA, { text: "你好", canvasContext: context }, "POST", "https://untrusted.example");
  await record({ name: "cross-origin-rejected", pass: forbidden.status === 403, status: forbidden.status });
  const cases = [
    { name: "current-weather", text: "上海,上海市天气", type: "WeatherCard" },
    { name: "stepsearch", text: "搜索 React Flow 官方文档", type: "SearchResultCard" },
    // The React Flow page is ~654 KiB; keep the product's 256 KiB limit and
    // verify its rejection separately instead of increasing the limit to pass.
    { name: "oversized-public-article", text: "阅读网页 https://reactflow.dev/learn", type: null },
    { name: "public-article", text: "阅读网页 https://www.rfc-editor.org/rfc/rfc3986.txt", type: "SearchResultCard" },
    { name: "numeric-table", text: "用表格记录：周一3，周二5，周三4", type: "TableCard" },
    { name: "numeric-chart", text: "用柱状图记录：周一3，周二5，周三4", type: "ChartCard" },
  ];
  for (const sample of cases) {
    const start = Date.now();
    try {
      const res = await request("/api/intent", cookieA, { text: sample.text, canvasContext: context });
      const data = await res.json() as { kind: string; envelope?: unknown; message?: string; usedProvider?: string };
      const envelope = data.envelope ? ActionEnvelopeSchema.parse(data.envelope) : undefined;
      const cards = envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card] : []) ?? [];
      const providers = [...new Set(cards.flatMap(card => card.sources.map(source => source.provider)))];
      const matches = cards.filter(card => card.type === sample.type);
      const liveSource = !["current-weather", "stepsearch", "public-article"].includes(sample.name) || providers.length > 0;
      const pass = sample.type ? res.ok && matches.length > 0 && liveSource
        : res.ok && data.kind === "error" && !cards.length && Boolean(data.message?.includes("超过大小限制"));
      await record({ name: sample.name, pass, status: res.status, kind: data.kind,
        cardTypes: cards.map(card => card.type), sources: providers, provider: data.usedProvider,
        ...(data.message ? { message: data.message.replaceAll(key, "[redacted]").slice(0, 400) } : {}), elapsedMs: Date.now() - start });
    } catch { await record({ name: sample.name, pass: false, error: "request-or-validation-failed", elapsedMs: Date.now() - start }); }
  }
  const stream = await request("/api/intent/stream", cookieA, { text: "创建便笺，内容是：在线会话实测。", canvasContext: context });
  const sse = await stream.text();
  await record({ name: "live-stream-complete", pass: stream.ok && /text\/event-stream/.test(stream.headers.get("content-type") ?? "") && sse.includes('"kind":"envelope"') && !sse.includes(key), status: stream.status });
  const disconnected = await request("/api/credentials/stepfun/disconnect", cookieA, {});
  const after = await (await request("/api/providers/status", cookieA)).json() as { providers: Array<{ connected: boolean }> };
  await record({ name: "disconnect-forgets-key", pass: disconnected.ok && after.providers.every(provider => !provider.connected) });
  await request("/api/online/session", cookieA, undefined, "DELETE");
  const stale = await request("/api/providers/status", cookieA);
  await record({ name: "closed-session-rejected", pass: stale.status === 401, status: stale.status });
} finally { key = ""; await server.dispose(); await save(); }
console.log(JSON.stringify({ completed: true, passed: results.filter(row => row.pass).length, total: results.length }));
process.exitCode = results.every(row => row.pass) ? 0 : 1;
