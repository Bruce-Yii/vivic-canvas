/**
 * Live F acceptance runner; writing/checking this file does not contact a service.
 * Run in the replay-eval container/TS-loader environment, for example:
 *   pnpm --filter @vivic/local-api exec tsx ../../scripts/replay-f-eval.mjs \
 *     --credentials /private/evaluation.json --package /private/fitness-log.vivicard --output /reports/f.json
 * Credentials use replay-eval's {evaluation:true, username, accountId, spaceId, origin, cookie}.
 * The selected main model must ALREADY be connected through the normal account API.
 * No key loading, login, provider connection, deployment or model simulation occurs here.
 */
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contextFor } from './replay-eval.mjs';

const MAX_RESPONSE = 8 * 1024 * 1024;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const same = (left, right) => canonical(left) === canonical(right);
const logicalRecord = ({ version: _version, updatedAt: _at, ...record }) => record;
const quantile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
const refKey = ref => `${ref.id}@${ref.version}#${ref.hash}`;
const refOf = def => ({ id: def.manifest.id, version: def.manifest.version, hash: def.hash });
const terminal = task => task && ['completed', 'cancelled', 'failed'].includes(task.status);
const createdCards = result => result?.envelope?.actions?.filter(action => action.type === 'card.create').map(action => action.card) ?? [];
const check = (row, name, pass, observed = null) => { row.checks.push({ name, pass: Boolean(pass), observed }); return Boolean(pass); };
function todayShanghai(at = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(at).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function argsFor(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--credentials', '--package', '--output'].includes(flag) || args[flag] || !argv[i + 1] || argv[i + 1].startsWith('--'))
      throw Error('Use --credentials PRIVATE.json --package FILE.vivicard --output REPORT.json');
    args[flag] = resolve(argv[++i]);
  }
  for (const flag of ['--credentials', '--package', '--output']) if (!args[flag]) throw Error('Missing ' + flag);
  return args;
}
function guardFiles(args) {
  const credential = lstatSync(args['--credentials']);
  if (!credential.isFile() || credential.isSymbolicLink() || credential.size > 65536) throw Error('Credentials must be a small private regular JSON file');
  if (process.platform !== 'win32' && ((credential.mode & 0o077) || process.getuid && credential.uid !== process.getuid()))
    throw Error('Credentials must belong to the runner and have no group/other permissions');
  // Windows file privacy is managed by the invoking parent's ACLs.
  if (!args['--package'].toLowerCase().endsWith('.vivicard') || statSync(args['--package']).size > 1_048_576) throw Error('Expected a .vivicard ZIP of at most 1MiB');
  accessSync(dirname(args['--output']), constants.W_OK);
  const protectedPaths = [args['--credentials'], args['--package'], fileURLToPath(import.meta.url), fileURLToPath(new URL('./replay-eval.mjs', import.meta.url))];
  if (protectedPaths.some(file => resolve(file) === args['--output'])) throw Error('Output must not overwrite an input or replay tool');
  let output;
  try { output = lstatSync(args['--output']); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (output && (!output.isFile() || output.isSymbolicLink() || protectedPaths.some(file => {
    const input = statSync(file); return input.dev === output.dev && input.ino === output.ino || realpathSync(file) === realpathSync(args['--output']);
  }))) throw Error('Output must be a distinct regular report file');
}
function credentialsFrom(file) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value.evaluation !== true || typeof value.username !== 'string' || !/^decision-eval-[a-z0-9_.-]+$/.test(value.username)
    || !['accountId', 'spaceId', 'origin', 'cookie'].every(key => typeof value[key] === 'string' && value[key].length > 0))
    throw Error('Refusing non-evaluation credentials');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value.spaceId) || !/^__Host-vivic_space=[A-Za-z0-9_-]{43}$/.test(value.cookie))
    throw Error('Evaluation Space or device cookie is invalid');
  const origin = new URL(value.origin);
  if (origin.origin !== value.origin || origin.username || origin.password || !(origin.protocol === 'https:'
    || origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw Error('Expected one HTTPS origin or loopback origin');
  return { evaluation: true, username: value.username, accountId: value.accountId, spaceId: value.spaceId,
    origin: value.origin, cookie: value.cookie, ...(typeof value.deviceId === 'string' ? { deviceId: value.deviceId } : {}) };
}
async function loadRuntime() {
  const root = process.env.VIVIC_REPLAY_API_ROOT || '/app/apps/local-api/src';
  const fromApi = createRequire(resolve(root, '../package.json'));
  const [contracts, packages, executor, schemas] = await Promise.all([
    import(pathToFileURL(fromApi.resolve('@vivic/contracts')).href),
    import(pathToFileURL(fromApi.resolve('@vivic/card-runtime')).href),
    import(pathToFileURL(resolve(root, 'space/executor.ts')).href),
    import(pathToFileURL(resolve(root, 'schemas.ts')).href),
  ]);
  return { ...contracts, ...packages, IntentResponseSchema: schemas.IntentResponseSchema, executeHostedEnvelope: executor.executeHostedEnvelope };
}
async function boundedBody(response, entry) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks = [];
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      entry.responseBytes += part.value.byteLength;
      if (entry.responseBytes > MAX_RESPONSE) throw Error('Evaluation response exceeded 8MiB');
      chunks.push(part.value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

class Client {
  constructor(credentials, report, runtime, runId) {
    this.credentials = credentials; this.report = report; this.runtime = runtime; this.runId = runId;
    this.pending = new Map(); this.entry = null; this.sequence = 0;
  }
  async exchange(route, method, body, phase, accept, consume) {
    const entry = { phase, method, route, status: null, responseBytes: 0, latencyMs: null };
    this.report.http.push(entry); const start = performance.now();
    try {
      // Never replay writes, including after a timeout. Read the normal commit receipt instead.
      const response = await fetch(this.credentials.origin + route, { method, redirect: 'error', signal: AbortSignal.timeout(110_000),
        headers: { cookie: this.credentials.cookie, origin: this.credentials.origin, accept,
          ...(body === undefined || body instanceof FormData ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
      entry.status = response.status; entry.contentType = response.headers.get('content-type');
      return await consume(response, entry);
    } catch (error) { entry.error = error.message; throw error; }
    finally { entry.latencyMs = Math.round(performance.now() - start); }
  }
  async jsonResponse(route, method = 'GET', body, phase = 'read') {
    return this.exchange(route, method, body, phase, 'application/json', async (response, entry) => {
      const bytes = await boundedBody(response, entry), text = new TextDecoder().decode(bytes);
      let data;
      try { data = text ? JSON.parse(text) : null; }
      catch { entry.invalidResponse = text; throw Error('Evaluation endpoint did not return JSON'); }
      if (!response.ok) entry.response = data;
      return { status: response.status, ok: response.ok, data };
    });
  }
  async api(route, method = 'GET', body, phase = 'read') {
    const response = await this.jsonResponse(route, method, body, phase);
    if (!response.ok) throw Error(`Evaluation HTTP ${response.status} on ${route}`);
    return response.data;
  }
  async owner(phase = 'owner-read') {
    const entry = await this.api(`/api/space/owner/canvases/${this.credentials.spaceId}`, 'GET', undefined, phase);
    if (entry.record?.id !== this.credentials.spaceId || !Number.isInteger(entry.serverVersion)) throw Error('Owner identity/version mismatch');
    this.entry = entry; return entry;
  }
  async catalog(phase = 'catalog-read') {
    const value = await this.api('/api/space/cards', 'GET', undefined, phase);
    if (!Array.isArray(value.definitions)) throw Error('Invalid installed package list');
    return value.definitions;
  }
  async save(record, suffix) {
    if (record.id !== this.credentials.spaceId || this.entry.record.id !== record.id) throw Error('Refusing a different Space');
    const requestId = `feval_${this.runId}_${++this.sequence}_${suffix}`;
    const body = { record: { ...record, version: this.entry.record.version + 1, updatedAt: new Date().toISOString() },
      expectedVersion: this.entry.serverVersion, requestId };
    let returned = null, writeError = null;
    try { returned = await this.api(`/api/space/owner/canvases/${record.id}`, 'PUT', body, suffix); }
    catch (error) { writeError = error.message; }
    const receipt = await this.api(`/api/space/spaces/${record.id}/commands/${encodeURIComponent(requestId)}`, 'GET', undefined, suffix + '-storage-receipt');
    const fresh = await this.owner(suffix + '-readback');
    if (receipt.receipt?.requestId !== requestId || receipt.receipt.status !== 'succeeded'
      || receipt.receipt.version !== fresh.serverVersion || !same(logicalRecord(fresh.record), logicalRecord(body.record)))
      throw Error('Owner write is not confirmed by its storage receipt and complete readback');
    return { requestId, storageReceipt: receipt.receipt, owner: fresh, recoveredAfterWriteError: writeError, returned };
  }
  trackResult(taskId, result) {
    if (result?.task?.id === taskId && terminal(result.task)) this.pending.delete(taskId);
  }
  async stream(text, row) {
    const taskId = `feval_${this.runId}_${row.id}`;
    row.taskId = taskId; row.startedAt = new Date().toISOString(); row.todayShanghaiStart = todayShanghai(); row.events = [];
    this.pending.set(taskId, { text, caseId: row.id });
    const start = performance.now();
    const result = await this.exchange('/api/intent/stream', 'POST', { text, canvasContext: contextFor(this.entry.record, this.entry.serverVersion), task: { id: taskId } },
      row.id, 'text/event-stream', async (response, entry) => {
        if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
          entry.response = new TextDecoder().decode(await boundedBody(response, entry)); throw Error('Intent did not return a successful SSE stream');
        }
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', resultCount = 0, last;
        const dispatch = block => {
          const event = { event: 'message', elapsedMs: Math.round(performance.now() - start) }, data = [];
          for (const line of block.split(/\r?\n/)) {
            if (!line || line.startsWith(':')) continue;
            const colon = line.indexOf(':'), key = colon < 0 ? line : line.slice(0, colon), value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (key === 'event') event.event = value;
            if (key === 'data') data.push(value);
          }
          if (!data.length) return;
          try { event.data = JSON.parse(data.join('\n')); } catch { event.raw = data.join('\n'); }
          row.events.push(event);
          if (event.event === 'result') {
            resultCount++; last = event.data; row.result = last;
          }
        };
        try {
          for (;;) {
            const part = await reader.read(); if (part.done) break;
            entry.responseBytes += part.value.byteLength;
            if (entry.responseBytes > MAX_RESPONSE) throw Error('Evaluation SSE exceeded 8MiB');
            buffer += decoder.decode(part.value, { stream: true });
            for (;;) {
              const split = /\r?\n\r?\n/.exec(buffer); if (!split) break;
              dispatch(buffer.slice(0, split.index)); buffer = buffer.slice(split.index + split[0].length);
            }
          }
          buffer += decoder.decode(); if (buffer.trim()) dispatch(buffer);
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
        if (resultCount !== 1 || !last) throw Error('Expected exactly one complete SSE result');
        return this.runtime.IntentResponseSchema.parse(last);
      });
    row.result = result; this.trackResult(taskId, result); row.responseLatencyMs = Math.round(performance.now() - start);
    row.todayShanghaiEnd = todayShanghai(); row.finishedResponseAt = new Date().toISOString();
    check(row, 'sse-accepted', row.events.some(event => event.event === 'accepted'));
    return result;
  }
  async resolveTrace(row, attempts = 8) {
    row.initialTrace ??= row.result?.trace ?? null;
    let trace = row.trace ?? row.initialTrace;
    for (let attempt = 0; attempt <= attempts; attempt++) {
      const logs = await this.api('/api/space/decision-log?limit=200', 'GET', undefined, row.id + '-trace');
      const found = logs.entries?.find(item => trace?.id ? item.trace?.id === trace.id : item.trace?.taskId === row.taskId);
      if (found) { trace = found.trace; row.decisionLog = found; row.traceSource = 'decision-log'; }
      else if (trace) row.traceSource ??= 'result';
      if (trace && trace.status !== 'pending' || attempt === attempts) break;
      await sleep(1500);
    }
    row.trace = trace ?? null;
    row.calls = { planner: Number.isInteger(trace?.plannerCalls) ? trace.plannerCalls : null,
      directClauses: Number.isInteger(trace?.directClauses) ? trace.directClauses : null, usedProvider: row.result?.usedProvider ?? null };
    return trace;
  }
  async cancel(taskId, phase = 'cancel') {
    const pending = this.pending.get(taskId); if (!pending) return null;
    await this.owner(phase + '-owner');
    const result = await this.api('/api/intent', 'POST', { text: pending.text, canvasContext: contextFor(this.entry.record, this.entry.serverVersion),
      task: { id: taskId, cancel: true } }, phase);
    this.trackResult(taskId, result);
    if (result.task?.id !== taskId || result.task.status !== 'cancelled') throw Error('Pending proposal cancellation was not confirmed');
    return result;
  }
  async applyPositive(row, card) {
    const result = row.result, record = structuredClone(this.entry.record);
    const content = this.runtime.executeHostedEnvelope({ title: record.title, document: { cards: record.cardOrder.map(id => record.cardsById[id]) } }, result.envelope, new Date().toISOString());
    record.cardsById = Object.fromEntries(content.document.cards.map(value => [value.id, value])); record.cardOrder = content.document.cards.map(value => value.id);
    const focus = result.envelope.actions.findLast(action => action.type === 'card.focus');
    if (focus) record.focusHistory = [...record.focusHistory, focus.targetId].slice(-20);
    record.processedRequestIds = [...record.processedRequestIds ?? [], result.envelope.requestId].slice(-500);
    const saved = await this.save(record, row.id + '-commit');
    row.execution = { committed: true, requestId: saved.requestId, storageReceipt: saved.storageReceipt,
      recoveredAfterWriteError: saved.recoveredAfterWriteError, createdCardIds: [card.id], ownerAfterCommit: saved.owner };
    // Only a confirmed owner write is acknowledged. Never acknowledge a rejected/unknown proposal.
    row.receiptResponse = await this.api('/api/intent', 'POST', { text: row.text, canvasContext: contextFor(this.entry.record, this.entry.serverVersion),
      task: { id: row.taskId, receipt: { executionId: result.task.executionId, status: 'succeeded', createdCardIds: [card.id] } } }, row.id + '-execution-receipt');
    this.trackResult(row.taskId, row.receiptResponse);
    check(row, 'real-execution-receipt-completed', row.receiptResponse.task?.id === row.taskId && row.receiptResponse.task.status === 'completed', row.receiptResponse.task ?? null);
  }
}

async function main() {
  const args = argsFor(process.argv.slice(2)); guardFiles(args);
  const runId = Date.now().toString(36) + '_' + randomUUID().slice(0, 8), secrets = [];
  const report = { protocolVersion: 'vivic-f-eval-v1', runId, startedAt: new Date().toISOString(), complete: false, passed: false,
    syntheticDataOnly: true, scope: 'Live HTTP/SSE, factual accuracy, routing and normal owner persistence; no browser/UI visual validation.',
    checks: [], package: null, steps: [], cases: [], http: [], cleanup: { attempted: false, verified: false, errors: [] } };
  const publicCopy = value => JSON.parse(JSON.stringify(value, (key, item) => {
    if (/^(?:cookie|set-cookie|authorization|password|apiKey|accessToken|refreshToken)$/i.test(key)) return '[redacted]';
    if (typeof item !== 'string') return item;
    for (const secret of secrets) if (secret) item = item.split(secret).join('[redacted]');
    return item.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|vvc_[A-Za-z0-9_-]{12,})\b/g, '[redacted]');
  }));
  const persist = () => writeFileSync(args['--output'], JSON.stringify(publicCopy(report), null, 2), { mode: 0o600 });
  let client, runtime, definition, packageBytes, original, initialCatalog, admitted = false, installAttempted = false, packageWasInstalled = false;
  const step = async (name, work) => {
    const row = { name, status: 'running' }; report.steps.push(row);
    try { Object.assign(row, await work()); row.status = 'passed'; }
    catch (error) { row.status = 'failed'; row.error = error.message; throw error; }
    finally { persist(); }
  };
  try {
    const credentials = credentialsFrom(args['--credentials']); secrets.push(credentials.cookie, credentials.cookie.split('=')[1]);
    runtime = await loadRuntime();
    packageBytes = new Uint8Array(readFileSync(args['--package']));
    definition = await runtime.readPackageZip(packageBytes);
    if (definition.manifest.formatVersion !== '0.2' || !['trainingDate', 'bodyPart', 'minutes'].every(key => definition.dataSchema.properties?.[key]))
      throw Error('This runner requires a validated v0.2 fitness record package with trainingDate/bodyPart/minutes facts');
    report.package = { filename: basename(args['--package']), ...refOf(definition), manifest: definition.manifest, demoExamples: definition.examples };
    client = new Client(credentials, report, runtime, runId);
    const session = await client.api('/api/space/session', 'GET', undefined, 'preflight-identity');
    if (session.authenticated !== true || session.user?.id !== credentials.accountId || session.user?.username !== credentials.username
      || credentials.deviceId && session.device?.id !== credentials.deviceId) throw Error('Evaluation identity mismatch; refusing any mutation');
    check(report, 'evaluation-identity-matched', true);
    original = structuredClone((await client.owner('preflight-owner')).record);
    if (original.cardOrder.length || Object.keys(original.cardsById).length) throw Error('Refusing a nonempty initial evaluation Space');
    const assets = await client.api(`/api/space/spaces/${credentials.spaceId}/assets`, 'GET', undefined, 'preflight-assets');
    if (!Array.isArray(assets.assets) || assets.assets.length) throw Error('Refusing an evaluation Space with preexisting assets');
    check(report, 'initial-space-and-assets-empty', true);
    const providers = await client.api('/api/providers/status', 'GET', undefined, 'preflight-provider');
    const selected = providers.providers?.find(provider => provider.name === providers.activeProvider);
    const connected = selected?.connected === true || providers.activeProvider === 'gpt' && Array.isArray(providers.degradations) && providers.degradations.length === 0;
    report.provider = { active: providers.activeProvider ?? null, connected, defaultModel: selected?.defaultModel ?? null };
    if (!connected) throw Error('Main model is not connected; parent must connect it through the normal API first');
    initialCatalog = await client.catalog('preflight-catalog');
    for (const row of initialCatalog) {
      const checked = await runtime.revalidateDefinition(row.definition);
      if (row.key !== refKey(refOf(checked)) || typeof row.enabled !== 'boolean') throw Error('Initial package catalog is inconsistent');
    }
    const targetKey = refKey(refOf(definition)); packageWasInstalled = initialCatalog.some(row => row.key === targetKey);
    const version = value => value.split('.').map(BigInt);
    const higher = (left, right) => { const a = version(left), b = version(right); for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
    if (initialCatalog.some(row => row.enabled && row.definition.manifest.id === definition.manifest.id && higher(row.definition.manifest.version, definition.manifest.version)))
      throw Error('A higher enabled version would shadow the supplied package; refusing to alter other versions');
    admitted = true; report.initialOwner = original; report.package.previouslyInstalled = packageWasInstalled;
    const path = `/api/space/cards/${encodeURIComponent(definition.manifest.id)}`, hashQuery = `?hash=${definition.hash}`;
    await step('install-and-list-exact-hash', async () => {
      installAttempted = true;
      const form = new FormData(); form.append('file', new File([packageBytes], basename(args['--package']), { type: 'application/zip' }));
      const installed = await client.api('/api/space/cards', 'POST', form, 'package-install');
      const list = await client.catalog('package-list');
      const target = list.find(row => row.key === targetKey);
      if (installed.record?.key !== targetKey || !target || target.definition.hash !== definition.hash) throw Error('Uploaded/listed package hash mismatch');
      if (!target.enabled) await client.api(path, 'PATCH', { hash: definition.hash, enabled: true }, 'package-enable-for-evaluation');
      const enabled = (await client.catalog()).find(row => row.key === targetKey)?.enabled === true;
      if (!enabled) throw Error('Package did not become enabled');
      return { key: targetKey, hash: definition.hash, enabled, deduplicated: installed.deduplicated === true };
    });
    await step('export-real-zip-with-same-hash', async () => {
      return client.exchange(path + '/package' + hashQuery, 'GET', undefined, 'package-export', 'application/zip', async (response, entry) => {
        const bytes = await boundedBody(response, entry);
        if (!response.ok || !response.headers.get('content-type')?.startsWith('application/zip') || bytes[0] !== 80 || bytes[1] !== 75) throw Error('Package export was not a successful ZIP response');
        const checked = await runtime.readPackageZip(bytes);
        if (checked.hash !== definition.hash || !same(refOf(checked), refOf(definition))) throw Error('Exported ZIP package identity/hash mismatch');
        return { bytes: bytes.length, hash: checked.hash, manifest: checked.manifest };
      });
    });

    async function runCase(id, text, expected) {
      const row = { id, text, expected, checks: [], status: 'running', execution: { committed: false } }; report.cases.push(row);
      const start = performance.now();
      try {
        const before = structuredClone((await client.owner(id + '-before')).record); row.ownerBefore = before;
        const result = await client.stream(text, row); row.cards = createdCards(result);
        const trace = await client.resolveTrace(row);
        check(row, 'trace-complete-on', trace?.status === 'complete' && trace.mode === 'on', trace ?? null);
        if (expected.kind === 'record') {
          const dates = [...new Set([row.todayShanghaiStart, row.todayShanghaiEnd])], cards = createdCards(result), card = cards[0];
          row.observedFacts = card?.displayProps?.data ?? null;
          check(row, 'extension-route', trace?.route === `ext.${definition.manifest.id}`, trace?.route ?? null);
          check(row, 'real-main-model-call-recorded', Number.isInteger(trace?.plannerCalls) && trace.plannerCalls > 0 && ['stepfun', 'gpt'].includes(result.usedProvider), row.calls);
          check(row, 'extension-has-no-new-direct-execution-grant', trace?.directClauses === 0, trace?.directClauses ?? null);
          check(row, 'single-fresh-extension-card', cards.length === 1 && card?.type === 'ExtensionCard' && !before.cardsById[card?.id], cards.map(value => ({ id: value.id, type: value.type })));
          check(row, 'exact-installed-definition', same(card?.displayProps?.def, refOf(definition)), card?.displayProps?.def ?? null);
          check(row, 'today-in-shanghai', dates.includes(card?.displayProps?.data?.trainingDate), { actual: card?.displayProps?.data?.trainingDate ?? null, dates });
          check(row, 'exact-user-facts-not-demo-or-coercion', card?.displayProps?.data?.bodyPart === '背' && card?.displayProps?.data?.minutes === expected.minutes,
            { actual: row.observedFacts, expectedMinutes: expected.minutes, expectedBodyPart: '背' });
          check(row, 'only-explicit-display-defaults', same(card?.displayProps?.config, runtime.schemaDefaults(definition.configSchema))
            && same(card?.displayProps?.state, runtime.schemaDefaults(definition.stateSchema)), { config: card?.displayProps?.config, state: card?.displayProps?.state });
          check(row, 'no-invented-source-facts', card && same(card.sourceData, {}) && same(card.sources, []));
          const allowed = ['card.create', 'card.focus', 'card.highlight', 'stage.awaken', 'subtitle.show', 'subtitle.hide', 'canvas.fit', 'canvas.restore'];
          check(row, 'no-unrequested-mutation-or-host-operation', !result.hostOperation && result.envelope?.canvasId === credentials.spaceId
            && result.envelope.actions.every(action => allowed.includes(action.type)));
          check(row, 'real-pending-execution-id', result.task?.id === row.taskId && result.task.status === 'awaiting_execution' && typeof result.task.executionId === 'string');
          if (card) {
            const parsed = runtime.ExtensionCardSchema.safeParse(card); check(row, 'card-schema', parsed.success);
            if (parsed.success) { try { runtime.validateInstance(definition, parsed.data.displayProps); check(row, 'instance-schema', true); } catch { check(row, 'instance-schema', false); } }
          }
          if (row.checks.every(item => item.pass)) {
            await client.applyPositive(row, card);
            check(row, 'previous-records-preserved', before.cardOrder.every(cardId => same(client.entry.record.cardsById[cardId], before.cardsById[cardId])));
            check(row, 'one-new-record-persisted', client.entry.record.cardOrder.length === before.cardOrder.length + 1
              && same(client.entry.record.cardsById[card.id]?.displayProps, card.displayProps));
          }
        } else if (expected.kind === 'clarify') {
          row.observedFacts = createdCards(result).map(card => card.displayProps?.data ?? card.displayProps);
          check(row, 'clarification-not-error-or-coerced-record', result.kind === 'clarify' && (!result.task || result.task.status === 'awaiting_clarification'),
            { kind: result.kind, task: result.task ?? null, message: result.message ?? null });
          check(row, 'no-new-extension-or-other-write-proposal', createdCards(result).length === 0 && !result.hostOperation
            && !(result.envelope?.actions.some(action => !['subtitle.show', 'subtitle.hide'].includes(action.type))));
        } else {
          check(row, 'disabled-catalog-verified', (await client.catalog(id + '-catalog')).find(item => item.key === targetKey)?.enabled === false);
          check(row, 'disabled-template-not-classified', trace?.route !== `ext.${definition.manifest.id}`, trace?.route ?? null);
          check(row, 'disabled-template-not-proposed', !createdCards(result).some(card => card.type === 'ExtensionCard' && card.displayProps.def.id === definition.manifest.id));
          check(row, 'site-remains-usable', result.kind !== 'error', { kind: result.kind, message: result.message ?? null });
        }
        if (client.pending.has(row.taskId)) row.cancellation = await client.cancel(row.taskId, id + '-discard-unexecuted-proposal');
        const after = (await client.owner(id + '-after')).record; row.ownerAfter = after;
        if (!row.execution.committed) check(row, 'space-unchanged-without-confirmed-execution', same(logicalRecord(before), logicalRecord(after)));
        await client.resolveTrace(row, 0);
      } catch (error) {
        row.error = error.message;
        if (row.taskId && client.pending.has(row.taskId)) {
          try { row.cancellation = await client.cancel(row.taskId, id + '-cancel-after-failure'); }
          catch (cancelError) { row.cancelError = cancelError.message; }
        }
      } finally {
        row.totalLatencyMs = Math.round(performance.now() - start);
        row.status = !row.error && row.checks.length > 0 && row.checks.every(item => item.pass) ? 'passed' : 'failed'; persist();
      }
      return row;
    }
    const first = await runCase('record-40', '今天练了40分钟背', { kind: 'record', minutes: 40 });
    const general = '再记一次背部锻炼，今天做了35分钟';
    if (first.execution.committed) {
      const row = await runCase('generalize-35', general, { kind: 'record', minutes: 35 });
      row.notInManifestExamples = !(definition.manifest.examples ?? []).includes(general);
      check(row, 'generalization-is-not-an-exact-manifest-example', row.notInManifestExamples);
      row.status = !row.error && row.checks.every(item => item.pass) ? 'passed' : 'failed'; persist();
      const deletion = await client.jsonResponse(path + hashQuery, 'DELETE', undefined, 'referenced-delete');
      report.steps.push({ name: 'referenced-delete-is-409', status: deletion.status === 409 && deletion.data?.code === 'definition-in-use' ? 'passed' : 'failed', response: deletion }); persist();
    } else {
      report.cases.push({ id: 'generalize-35', text: general, status: 'skipped', reason: 'First real record was not committed; no record or success receipt fabricated.' });
      report.steps.push({ name: 'referenced-delete-is-409', status: 'skipped', reason: 'No confirmed card reference exists.' });
    }
    await runCase('missing-minutes', '今天练背', { kind: 'clarify', reason: 'No duration supplied for a new record; previous records are not evidence.' });
    await runCase('out-of-range-900', '今天背部训练900分钟', { kind: 'clarify', minutes: 900, reason: 'Above schema maximum; substituting any other duration is a failure.' });
    await step('disable-package', async () => {
      const response = await client.api(path, 'PATCH', { hash: definition.hash, enabled: false }, 'disable-package');
      if ((await client.catalog()).find(row => row.key === targetKey)?.enabled !== false) throw Error('Disable was not reflected in the catalog');
      return { response };
    });
    await runCase('disabled-template', '今天练了40分钟背', { kind: 'disabled' });
    await step('re-enable-package', async () => {
      const response = await client.api(path, 'PATCH', { hash: definition.hash, enabled: true }, 're-enable-package');
      if ((await client.catalog()).find(row => row.key === targetKey)?.enabled !== true) throw Error('Re-enable was not reflected in the catalog');
      return { response };
    });
  } catch (error) { report.failure = error.message; }
  finally {
    if (admitted && client) {
      report.cleanup.attempted = true;
      for (const taskId of [...client.pending.keys()]) {
        try { (report.cleanup.cancellations ??= []).push({ taskId, result: await client.cancel(taskId, 'cleanup-cancel') }); }
        catch (error) { report.cleanup.errors.push({ operation: 'cancel-pending-task', taskId, error: error.message }); }
      }
      try {
        const current = await client.owner('cleanup-owner');
        if (!same(logicalRecord(current.record), logicalRecord(original))) report.cleanup.restore = await client.save(structuredClone(original), 'restore-original-space');
        const restored = await client.owner('cleanup-owner-verify');
        report.cleanup.spaceRestored = same(logicalRecord(restored.record), logicalRecord(original));
      } catch (error) { report.cleanup.errors.push({ operation: 'restore-original-space', error: error.message }); }
      try {
        const rows = await client.api(`/api/space/spaces/${client.credentials.spaceId}/assets`, 'GET', undefined, 'cleanup-assets');
        for (const asset of rows.assets ?? []) {
          await client.api(`/api/space/spaces/${client.credentials.spaceId}/assets/${encodeURIComponent(asset.id)}`, 'DELETE', undefined, 'cleanup-new-asset');
        }
        const remaining = await client.api(`/api/space/spaces/${client.credentials.spaceId}/assets`, 'GET', undefined, 'cleanup-assets-verify');
        report.cleanup.noAssets = Array.isArray(remaining.assets) && remaining.assets.length === 0;
      } catch (error) { report.cleanup.errors.push({ operation: 'remove-evaluation-assets', error: error.message }); }
      if (installAttempted) try {
        const key = refKey(refOf(definition)), path = `/api/space/cards/${encodeURIComponent(definition.manifest.id)}`, rows = await client.catalog('cleanup-catalog');
        let target = rows.find(row => row.key === key);
        if (!packageWasInstalled && target) await client.api(path + `?hash=${definition.hash}`, 'DELETE', undefined, 'cleanup-remove-new-package');
        if (packageWasInstalled) {
          const enabled = initialCatalog.find(row => row.key === key).enabled;
          if (!target) {
            // A broken reference guard may have accepted DELETE. Restore an originally present package.
            const form = new FormData(); form.append('file', new File([packageBytes], basename(args['--package']), { type: 'application/zip' }));
            form.append('enabled', String(enabled));
            await client.api('/api/space/cards', 'POST', form, 'cleanup-reinstall-missing-original-package');
            target = (await client.catalog()).find(row => row.key === key);
            if (!target) throw Error('Originally installed package could not be restored');
          }
          if (target.enabled !== enabled) await client.api(path, 'PATCH', { hash: definition.hash, enabled }, 'cleanup-restore-original-enabled-flag');
        }
        const after = await client.catalog('cleanup-catalog-verify');
        const signature = list => list.map(row => ({ key: row.key, enabled: row.enabled })).sort((a, b) => a.key.localeCompare(b.key));
        report.cleanup.catalogRestored = same(signature(after), signature(initialCatalog));
      } catch (error) { report.cleanup.errors.push({ operation: 'restore-package-catalog', error: error.message }); }
      report.cleanup.pendingTasks = [...client.pending.keys()];
      report.cleanup.verified = report.cleanup.spaceRestored === true && report.cleanup.noAssets === true
        && report.cleanup.catalogRestored === true && client.pending.size === 0 && report.cleanup.errors.length === 0;
    }
    const uniqueTraces = [...new Map(report.cases.filter(row => row.trace).map(row => [row.trace.id, row.trace])).values()];
    const knownCalls = uniqueTraces.filter(trace => Number.isInteger(trace.plannerCalls));
    const latencies = report.cases.map(row => row.responseLatencyMs).filter(Number.isFinite);
    report.summary = { cases: report.cases.length, passed: report.cases.filter(row => row.status === 'passed').length,
      failed: report.cases.filter(row => row.status === 'failed').length, skipped: report.cases.filter(row => row.status === 'skipped').length,
      httpRequests: report.http.length, intentStreams: report.http.filter(row => row.route === '/api/intent/stream').length,
      plannerCallsKnown: knownCalls.reduce((sum, trace) => sum + trace.plannerCalls, 0), plannerCallTelemetryComplete: report.cases.length === 5 && knownCalls.length === report.cases.length,
      responseP50Ms: quantile(latencies, .5), responseP95Ms: quantile(latencies, .95),
      routeP50Ms: quantile(uniqueTraces.map(trace => trace.routeLatencyMs).filter(Number.isFinite), .5),
      routeP95Ms: quantile(uniqueTraces.map(trace => trace.routeLatencyMs).filter(Number.isFinite), .95),
      committedRecords: report.cases.filter(row => row.execution?.committed).length,
      verifiedFactRecords: report.cases.filter(row => row.expected?.kind === 'record' && row.status === 'passed').length,
      confirmedExecutionReceipts: report.cases.filter(row => row.receiptResponse?.task?.status === 'completed').length };
    report.passed = !report.failure && report.cases.length === 5 && report.cases.every(row => row.status === 'passed')
      && report.steps.every(row => row.status === 'passed') && report.checks.every(row => row.pass) && report.cleanup.verified;
    report.complete = report.passed; report.finishedAt = new Date().toISOString();
    report.restoreSemantics = 'Normal owner API restores logical Space content/settings; server versions/timestamps and synthetic audit/receipt history remain monotonic.';
    persist();
    console.log(JSON.stringify(publicCopy({ complete: report.complete, passed: report.passed, summary: report.summary,
      cleanupVerified: report.cleanup.verified, failure: report.failure ?? null })));
    if (!report.passed) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('F replay could not initialize or write its report; no success claimed.'); process.exitCode = 1; });
}
