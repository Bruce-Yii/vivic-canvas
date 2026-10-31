/** Run inside the API container. Uses only a newly-created evaluation account. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';

export function makeFixtureCards(canvas, stamp) {
  return canvas.cards.map(c => {
    const card = { id: c.id, type: c.type === 'AnswerCard' ? 'NewsCard' : c.type,
      variant: 'minimal', displayProps: {}, sourceData: { title: c.title, evaluationOnly: true },
      sources: [{ kind: 'service', title: '固定评测数据（非实时信息）', provider: 'evaluation-fixture', fetchedAt: stamp, readFullPage: false }],
      layout: { x: c.x, y: c.y, width: 264, height: 160, pinned: false, surface: 'display' },
      metadata: { createdAt: stamp, updatedAt: stamp, aliases: [c.title], section: '评测固定数据' } };
    switch (card.type) {
      case 'TodoCard': card.displayProps = { title: c.title, items: c.items.map((text, i) => ({ id: `${c.id}_${i}`, text, done: false })) }; break;
      case 'NoteCard': card.displayProps = { text: c.text }; break;
      case 'CountdownCard': card.sourceData = { targetAt: new Date(Date.parse(stamp) + 18 * 60000).toISOString(), startedAt: stamp,
        pausedAt: stamp, reminderText: c.title }; break;
      case 'WeatherCard': card.displayProps = { tempC: 20, conditionIcon: 'cloud' }; break;
      case 'NewsCard': card.displayProps = { headline: c.title, summary: c.points.join('；'), keyPoints: c.points,
        source: '固定评测数据', summaryBy: 'user' }; break;
      default: throw Error('Unsupported fixture renderer');
    }
    return card;
  });
}

export function contextFor(record, version) {
  return { canvasId: record.id, version, stage: 'WORKSPACE', viewport: record.viewport,
    focusHistory: record.focusHistory, timeZone: 'Asia/Shanghai', totalCardCount: record.cardOrder.length,
    cards: record.cardOrder.map(id => {
      const c = record.cardsById[id];
      return { id, type: c.type, aliases: c.metadata.aliases || [], displayProps: c.displayProps,
        sourceDataSummary: c.sourceData, surface: c.layout.surface || 'display',
        layout: { x: c.layout.x, y: c.layout.y, width: c.layout.width, height: c.layout.height, pinned: c.layout.pinned } };
    }) };
}

export function legacyShape(result) {
  return { kind: result.kind, usedProvider: result.usedProvider || null,
    actionTypes: result.envelope?.actions.map(a => a.type) || [],
    cardTypes: result.envelope?.actions.filter(a => a.type === 'card.create').map(a => a.card.type) || [],
    hostOperation: result.hostOperation?.kind || null, taskStatus: result.task?.status || null };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quantile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
function transport(url, method, headers, serialized) {
  return new Promise((resolveRequest, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.request(url, { method, headers, timeout: 105000 }, response => {
      const chunks = [];let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) request.destroy(Error('Evaluation response exceeded limit'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolveRequest({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(Error('Evaluation request timed out')));
    request.on('error', reject);
    request.end(serialized);
  });
}

async function main() {
  const argv = process.argv.slice(2), value = flag => argv[argv.indexOf(flag) + 1];
  for (const flag of ['--credentials', '--dataset', '--output']) if (!argv.includes(flag)) throw Error('Missing ' + flag);
  const credentials = JSON.parse(readFileSync(value('--credentials'), 'utf8'));
  if (!credentials.evaluation || !/^decision-eval-/.test(credentials.username) || !credentials.accountId || !credentials.spaceId) {
    throw Error('Refusing a non-evaluation account');
  }
  const dataset = JSON.parse(readFileSync(value('--dataset'), 'utf8'));
  const output = value('--output');
  const { CardRecordSchema, resumeReminderSource } = await import('@vivic/contracts');
  const apiRoot = process.env.VIVIC_REPLAY_API_ROOT || '/app/apps/local-api/src';
  const { executeHostedEnvelope } = await import(pathToFileURL(resolve(apiRoot, 'space/executor.ts')).href);
  const { redactDecisionText } = await import(pathToFileURL(resolve(apiRoot, 'decision/logging.ts')).href);
  const runId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const stamp = new Date().toISOString();
  const fixtures = makeFixtureCards(dataset.canvas, stamp).map(c => CardRecordSchema.parse(c));

  class Client {
    constructor(name, base) { this.name = name; this.base = base.replace(/\/$/, ''); this.entry = null; }
    async api(route, method = 'GET', body) {
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await transport(this.base + route, method,
          { cookie: credentials.cookie, origin: credentials.origin, host: new URL(credentials.origin).host,
            'content-type': 'application/json', accept: 'application/json' }, serialized);
        if (response.status === 429) { await sleep(2500 * (attempt + 1)); continue; }
        if (response.status < 200 || response.status >= 300) throw Error(`Evaluation HTTP ${response.status} on ${this.name}:${route}`);
        return JSON.parse(response.body);
      }
      throw Error('Evaluation rate limit did not clear');
    }
    async initialize() {
      const session = await this.api('/api/space/session');
      if (session.user?.id !== credentials.accountId || session.user?.username !== credentials.username) throw Error('Evaluation identity mismatch');
      this.entry = await this.api('/api/space/owner/canvases/' + credentials.spaceId);
      const providers = await this.api('/api/providers/status');
      this.providersConnected = Boolean(providers.providers?.some(p => p.connected) || providers.platform?.connected);
    }
    async save(record, suffix) {
      if (record.id !== credentials.spaceId) throw Error('Refusing a different Space');
      this.entry = await this.api('/api/space/owner/canvases/' + credentials.spaceId, 'PUT', {
        record: { ...record, version: this.entry.record.version + 1, updatedAt: new Date().toISOString() },
        expectedVersion: this.entry.serverVersion, requestId: `eval_${runId}_${this.name}_${suffix}`,
      });
    }
    async reset(caseId, empty = false) {
      const cards = empty ? [] : structuredClone(fixtures);
      await this.save({ ...this.entry.record, title: '路由评测专用（非用户空间）',
        cardsById: Object.fromEntries(cards.map(c => [c.id, c])), cardOrder: cards.map(c => c.id),
        focusHistory: empty ? [] : [dataset.canvas.focused] }, 'seed_' + caseId);
    }
    async apply(result, suffix) {
      const record = structuredClone(this.entry.record);
      if (result.envelope) {
        const content = executeHostedEnvelope({ title: record.title, document: { cards: record.cardOrder.map(id => record.cardsById[id]) } },
          result.envelope, new Date().toISOString());
        record.cardsById = Object.fromEntries(content.document.cards.map(c => [c.id, c]));
        record.cardOrder = content.document.cards.map(c => c.id);
        const focus = result.envelope.actions.findLast(a => a.type === 'card.focus');
        if (focus) record.focusHistory = [...record.focusHistory, focus.targetId].slice(-20);
        await this.save(record, 'commit_' + suffix);
        return { success: true, createdCardIds: result.envelope.actions.filter(a => a.type === 'card.create').map(a => a.card.id) };
      }
      const operation = result.hostOperation;
      if (!operation) return { success: true, createdCardIds: [] };
      const card = record.cardsById[operation.targetId];
      if (operation.kind === 'card.pin' && card) card.layout.pinned = operation.pinned;
      else if (operation.kind === 'card.surface' && card) card.layout.surface = operation.surface;
      else if (operation.kind === 'countdown.pause' && card?.type === 'CountdownCard') card.sourceData.pausedAt = new Date().toISOString();
      else if (operation.kind === 'countdown.resume' && card?.type === 'CountdownCard') card.sourceData = resumeReminderSource(card, Date.now());
      else if (['history.undo', 'history.redo', 'canvas.arrange'].includes(operation.kind)) {
        await this.api(`/api/space/spaces/${credentials.spaceId}/commands`, 'POST', {
          requestId: `eval_${runId}_${this.name}_op_${suffix}`, expectedVersion: this.entry.serverVersion, command: { type: operation.kind },
        });
        this.entry = await this.api('/api/space/owner/canvases/' + credentials.spaceId);
        return { success: true, createdCardIds: [] };
      } else return { success: false, reason: 'ui-only-or-unsupported-in-headless-replay', createdCardIds: [] };
      await this.save(record, 'operation_' + suffix);
      return { success: true, createdCardIds: [] };
    }
    async one(testCase) {
      await this.reset(testCase.id);
      const task = { id: `eval_${runId}_${this.name}_${testCase.id}` };
      const started = performance.now();
      const result = await this.api('/api/intent', 'POST', { text: testCase.text,
        canvasContext: contextFor(this.entry.record, this.entry.serverVersion), task });
      const totalMs = Math.round(performance.now() - started);
      let execution = { success: false, reason: 'no-action-proposal', createdCardIds: [] };
      if (result.envelope || result.hostOperation) {
        try { execution = await this.apply(result, testCase.id); }
        catch { execution = { success: false, reason: 'proposal-commit-rejected', createdCardIds: [] }; }
      }
      if (result.task?.executionId) {
        await this.api('/api/intent', 'POST', { text: testCase.text, canvasContext: contextFor(this.entry.record, this.entry.serverVersion),
          task: { id: task.id, receipt: { executionId: result.task.executionId,
            status: execution.success ? 'succeeded' : 'failed', createdCardIds: execution.createdCardIds,
            ...(!execution.success ? { error: execution.reason } : {}) } } });
      }
      let trace = result.trace || null;
      if (this.name === 'shadow' && trace) {
        for (let attempt = 0; attempt < 15; attempt++) {
          if (trace.status !== 'pending') break;
          await sleep(1800);
          const logs = await this.api('/api/space/decision-log?limit=200');
          trace = logs.entries.find(x => x.trace.id === trace.id)?.trace || trace;
        }
      }
      await this.reset('clear_' + testCase.id, true);
      return { id: testCase.id, expected: testCase.route, totalMs, legacy: legacyShape(result),
        ...(argv.includes('--case') && result.kind === 'error' ? { errorHint: redactDecisionText(result.message || '').slice(0, 200) } : {}),
        execution: { success: execution.success, reason: execution.reason || null, createdCards: execution.createdCardIds.length }, trace };
    }
  }

  const off = new Client('off', credentials.baselineURL), shadow = new Client('shadow', credentials.origin);
  await off.initialize(); await shadow.initialize();
  const selected = argv.includes('--case') ? [dataset.cases.find(c => c.id === value('--case'))].map(c => {
    if (!c) throw Error('Unknown replay case');return c;
  }) : argv.includes('--smoke')
    ? ['chat-01', 'countdown-01', 'todo-01', 'focus-01', 'multi-03'].map(id => {
      const c = dataset.cases.find(c => c.id === id); if (!c) throw Error('Missing smoke case'); return c;
    }) : dataset.cases;
  const rows = [];
  let failure = null;
  try {
    for (const testCase of selected) {
      const started = Date.now();
      let baseline, observed;
      if (argv.includes('--sequential')) { baseline = await off.one(testCase); await sleep(2500); observed = await shadow.one(testCase); }
      else [baseline, observed] = await Promise.all([off.one(testCase), shadow.one(testCase)]);
      rows.push({ id: testCase.id, expected: testCase.route, off: baseline, shadow: observed,
        sameLegacyShape: JSON.stringify(baseline.legacy) === JSON.stringify(observed.legacy) });
      const partial = { complete: false, rows, providersConnected: { off: off.providersConnected, shadow: shadow.providersConnected } };
      writeFileSync(output, JSON.stringify(partial, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ completed: rows.length, total: selected.length, id: testCase.id,
        route: observed.trace?.route || null, expected: testCase.route, failed: observed.trace?.failedCount ?? null }));
      await sleep(Math.max(0, 2500 - (Date.now() - started)));
    }
  } catch (error) { failure = error.message; }
  finally {
    await Promise.allSettled([off.reset('final', true), shadow.reset('final', true)]);
  }
  const traces = rows.map(x => x.shadow.trace).filter(Boolean);
  const routeTimes = traces.filter(x => x.status !== 'pending').map(x => x.routeLatencyMs);
  const decisionTimes = traces.filter(x => x.status !== 'pending').map(x => x.latencyMs);
  const delta = rows.map(x => x.shadow.totalMs - x.off.totalMs);
  const missingTraces = rows.filter(x => !x.shadow.trace).length;
  const pendingTraces = traces.filter(x => x.status === 'pending').length;
  const comparable = rows.filter(x => x.sameLegacyShape && !['search', 'answer', 'generate'].includes(x.expected)
    && ['rules', 'rules-offline'].includes(x.off.legacy.usedProvider)
    && ['rules', 'rules-offline'].includes(x.shadow.legacy.usedProvider));
  const localDelta = comparable.map(x => x.shadow.totalMs - x.off.totalMs);
  const report = { complete: !failure && rows.length === selected.length && !missingTraces && !pendingTraces,
    failure, count: rows.length, missingTraces, pendingTraces,
    routeAccuracy: rows.length ? rows.filter(x => x.shadow.trace?.route === x.expected).length / rows.length : null,
    routeP50Ms: quantile(routeTimes, .5), routeP95Ms: quantile(routeTimes, .95),
    decisionP50Ms: quantile(decisionTimes, .5), decisionP95Ms: quantile(decisionTimes, .95),
    extraResponseP50Ms: quantile(delta, .5), extraResponseP95Ms: quantile(delta, .95),
    deterministicTimingSamples: comparable.length,
    deterministicExtraP50Ms: quantile(localDelta, .5), deterministicExtraP95Ms: quantile(localDelta, .95),
    explicitShadowWaitP95Ms: quantile(traces.map(x => x.shadowWaitMs), .95),
    serviceFailures: traces.reduce((sum, x) => sum + x.failedCount, 0),
    legacyShapeMatches: rows.filter(x => x.sameLegacyShape).length,
    providersConnected: { off: off.providersConnected, shadow: shadow.providersConnected },
    realLlmCompared: off.providersConnected && shadow.providersConnected,
    replayScope: 'API/data persistence and response-shape checks; no browser visual validation. Unconnected model paths are not real LLM quality measurements.',
    isolatedTestSpaceCleared: off.entry.record.cardOrder.length === 0 && shadow.entry.record.cardOrder.length === 0,
    fixtureAdaptation: 'Abstract AnswerCard is rendered as the existing NewsCard; no invented renderer was added.', rows };
  writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, rows: undefined }));
  if (!report.complete || !report.isolatedTestSpaceCleared) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('Replay failed: ' + error.message); process.exitCode = 1; });
}
