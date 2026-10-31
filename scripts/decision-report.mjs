import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isReportRoute(route) {
  const builtin = ['chat', 'answer', 'search', 'countdown', 'todo', 'note', 'generate', 'focus',
    'overview', 'restore', 'highlight', 'edit', 'arrange', 'delete', 'undo', 'unsupported'];
  return typeof route === 'string' && !/\s/.test(route) && (builtin.includes(route) || route.startsWith('ext.') && route.length <= 84
    && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(route.slice(4)));
}

export function routeAgreement(trace) {
  if (['error', 'unknown'].includes(trace.legacyKind)) return null;
  const actions = trace.legacyActionTypes || [], cards = trace.legacyCardTypes || [];
  if (typeof trace.route === 'string' && trace.route.startsWith('ext.'))
    return isReportRoute(trace.route) ? cards.includes('ExtensionCard') : null;
  switch (trace.route) {
    case 'countdown': return cards.includes('CountdownCard');
    case 'todo': return cards.includes('TodoCard');
    case 'note': return cards.includes('NoteCard');
    case 'search': return trace.legacyUsedProvider === 'search' || cards.some(c => /Weather/.test(c));
    case 'overview': return actions.includes('canvas.fit');
    case 'restore': return actions.includes('canvas.restore');
    case 'focus': return actions.includes('card.focus');
    case 'highlight': return actions.includes('card.highlight');
    case 'delete': return actions.some(a => ['card.delete', 'cards.delete'].includes(a));
    case 'undo': return actions.some(a => ['history.undo', 'history.redo'].includes(a));
    case 'answer': return cards.includes('NewsCard') || !cards.length && actions.includes('subtitle.show')
      && actions.every(a => ['stage.awaken', 'subtitle.show', 'subtitle.hide'].includes(a));
    case 'chat': return !cards.length && (trace.legacyKind === 'locale' ||
      actions.length > 0 && actions.every(a => ['stage.awaken', 'subtitle.show', 'subtitle.hide'].includes(a)));
    default: return null;
  }
}

export function summarizeDecisions(rows) {
  const groups = {}, output = { total: rows.length, pending: 0, failures: 0, undone: 0, byRoute: groups,
    succeeded: 0, succeededUndone: 0, undoRatio: null,
    note: 'Agreement is an output-contract proxy, not labeled model accuracy. Browser proposals are not execution receipts. '
      + 'Undo ratios use only confirmed outcome=succeeded records; total counts and undone counts include all records. '
      + 'Undo is a behavior proxy, not accuracy or a causal judgment of model quality.' };
  for (const row of rows) {
    const trace = row.trace;
    const name = isReportRoute(trace.route) ? trace.route : trace.status === 'pending' ? 'pending'
      : trace.failedCount ? 'unavailable' : 'abstain';
    const group = groups[name] ||= { count: 0, compared: 0, agreed: 0, undone: 0, failures: 0, latencies: [], outcomes: {},
      succeeded: 0, succeededUndone: 0, undoRatio: null };
    group.count++; group.undone += Number(Boolean(row.undone)); output.undone += Number(Boolean(row.undone));
    group.failures += trace.failedCount || 0; output.failures += trace.failedCount || 0;
    if (trace.status === 'pending') output.pending++;
    else {
      const value = trace.routeLatencyMs ?? trace.latencyMs;
      if (Number.isFinite(value)) group.latencies.push(value);
      const agreement = routeAgreement(trace);
      if (agreement !== null) { group.compared++; group.agreed += Number(agreement); }
    }
    const status = ['proposed', 'pending', 'succeeded', 'failed', 'clarify', 'error', 'conflict'].includes(row.outcome) ? row.outcome : 'other';
    group.outcomes[status] = (group.outcomes[status] || 0) + 1;
    if (status === 'succeeded') {
      group.succeeded++; output.succeeded++;
      group.succeededUndone += Number(Boolean(row.undone)); output.succeededUndone += Number(Boolean(row.undone));
    }
  }
  for (const group of Object.values(groups)) {
    group.latencies.sort((a, b) => a - b);
    const percentile = p => group.latencies.length ? group.latencies[Math.max(0, Math.ceil(group.latencies.length * p) - 1)] : null;
    group.p50_ms = percentile(.5); group.p95_ms = percentile(.95);
    group.agreement = group.compared ? Math.round(group.agreed / group.compared * 10000) / 10000 : null;
    group.undoRatio = group.succeeded ? Math.round(group.succeededUndone / group.succeeded * 10000) / 10000 : null;
    delete group.latencies;
  }
  output.undoRatio = output.succeeded ? Math.round(output.succeededUndone / output.succeeded * 10000) / 10000 : null;
  return output;
}

/** Pure validation/query construction: no storage access and no interpolated filter values. */
export function buildReportQuery(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['since', 'accountId', 'mode', 'routes', 'excludeEvaluation', 'hours'].includes(key))
    || typeof options.since !== 'string' || !Number.isFinite(Date.parse(options.since)) || new Date(options.since).toISOString() !== options.since
    || options.hours !== undefined && (!Number.isFinite(options.hours) || options.hours <= 0 || options.hours > 720)
    || options.accountId !== undefined && (typeof options.accountId !== 'string' || options.accountId.length < 1
      || options.accountId.length > 128 || /[^A-Za-z0-9_-]/.test(options.accountId))
    || options.mode !== undefined && !['on', 'shadow'].includes(options.mode)
    || options.routes !== undefined && (!Array.isArray(options.routes) || !options.routes.length || options.routes.length > 128
      || Array.from(options.routes).some(route => !isReportRoute(route)))
    || options.excludeEvaluation !== undefined && typeof options.excludeEvaluation !== 'boolean') throw Error('Invalid report filter');
  const where = ['d.at>=?', '(? IS NULL OR d.account_id=?)'];
  const params = [options.since, options.accountId ?? null, options.accountId ?? null];
  if (options.mode !== undefined) { where.push("json_extract(d.trace_json,'$.mode')=?"); params.push(options.mode); }
  if (options.routes !== undefined) {
    const routes = [...new Set(options.routes)];
    where.push(`json_extract(d.trace_json,'$.route') IN (${routes.map(() => '?').join(',')})`); params.push(...routes);
  }
  if (options.excludeEvaluation) {
    where.push('NOT EXISTS (SELECT 1 FROM accounts AS a WHERE a.id=d.account_id AND substr(a.username,1,14)=?)');
    params.push('decision-eval-');
  }
  return { sql: `SELECT d.outcome,d.undone,
json_extract(d.trace_json,'$.route') AS route,json_extract(d.trace_json,'$.status') AS status,
json_extract(d.trace_json,'$.legacyKind') AS legacyKind,json_extract(d.trace_json,'$.legacyUsedProvider') AS legacyUsedProvider,
json_extract(d.trace_json,'$.legacyActionTypes') AS actions,json_extract(d.trace_json,'$.legacyCardTypes') AS cards,
json_extract(d.trace_json,'$.latencyMs') AS latencyMs,json_extract(d.trace_json,'$.routeLatencyMs') AS routeLatencyMs,
json_extract(d.trace_json,'$.failedCount') AS failedCount FROM decision_log AS d
WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT 20000`, params };
}

export function parseReportArgs(args, now = Date.now()) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw Error('Invalid report filter');
  const seen = new Set(), values = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--hours', '--account', '--mode', '--routes', '--exclude-evaluation'].includes(flag) || seen.has(flag)) throw Error('Invalid report filter');
    seen.add(flag);
    if (flag === '--exclude-evaluation') { values[flag] = true; continue; }
    const value = args[++index];
    if (value === undefined || value.trim() === '' || value.startsWith('--')) throw Error('Invalid report filter');
    values[flag] = value;
  }
  const hours = values['--hours'] === undefined ? 24 : Number(values['--hours']);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 720 || !Number.isFinite(now)) throw Error('Invalid report filter');
  const options = { hours, since: new Date(now - hours * 3600000).toISOString(),
    ...(values['--account'] === undefined ? {} : { accountId: values['--account'] }),
    ...(values['--mode'] === undefined ? {} : { mode: values['--mode'] }),
    ...(values['--routes'] === undefined ? {} : { routes: [...new Set(values['--routes'].split(',').map(route => route.trim()))] }),
    excludeEvaluation: values['--exclude-evaluation'] === true };
  buildReportQuery(options);
  return options;
}

/** Keep every serialized function dependency explicit; only metadata is selected remotely. */
export function buildReportProgram(options) {
  buildReportQuery(options);
  const encoded = Buffer.from(JSON.stringify(options)).toString('base64');
  return `import {DatabaseSync} from 'node:sqlite';
const isReportRoute=${isReportRoute.toString()};
const routeAgreement=${routeAgreement.toString()};
const summarizeDecisions=${summarizeDecisions.toString()};
const buildReportQuery=${buildReportQuery.toString()};
const options=JSON.parse(Buffer.from('${encoded}','base64').toString());
const db=new DatabaseSync('/data/vivic/space.sqlite',{readOnly:true});
if(!db.prepare("SELECT name FROM sqlite_master WHERE name='decision_log'").get()){console.log(JSON.stringify({available:false,total:0,reason:'not-deployed'}));process.exit(0);}
const query=buildReportQuery(options);
const rows=db.prepare(query.sql).all(...query.params);
const input=rows.map(x=>({outcome:x.outcome,undone:x.undone,trace:{...x,legacyActionTypes:JSON.parse(x.actions||'[]'),legacyCardTypes:JSON.parse(x.cards||'[]')}}));
db.close();console.log(JSON.stringify({available:true,...summarizeDecisions(input)}));`;
}

function main() {
  const program = buildReportProgram(parseReportArgs(process.argv.slice(2)));
  const command = "docker exec -i vivic-preview-20261027 node --no-warnings --input-type=module <<'VIVIC_REPORT'\n" + program + '\nVIVIC_REPORT\n';
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const python = process.env.VIVIC_SSH_PYTHON || (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe') : 'python3');
  const runner = process.env.VIVIC_SSH_RUNNER || resolve(repo, '..', 'tools', 'vssh.py');
  const result = spawnSync(python, ['-I', runner], { input: command, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error('Decision report could not read deployed storage');
  process.stdout.write(result.stdout);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
