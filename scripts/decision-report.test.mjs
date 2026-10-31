import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { buildReportProgram, buildReportQuery, isReportRoute, parseReportArgs, routeAgreement, summarizeDecisions } from './decision-report.mjs';

test('agreement does not turn unavailable old responses into correctness', () => {
  assert.equal(routeAgreement({ route: 'chat', legacyKind: 'unknown', legacyActionTypes: [] }), null);
  assert.equal(routeAgreement({ route: 'countdown', legacyKind: 'envelope', legacyCardTypes: ['CountdownCard'] }), true);
  assert.equal(routeAgreement({ route: 'countdown', legacyKind: 'envelope', legacyCardTypes: ['NoteCard'] }), false);
  assert.equal(routeAgreement({ route: 'arrange', legacyKind: 'envelope' }), null);
});
test('summary excludes pending timings, distinguishes abstention and reports measured quantiles', () => {
  const base = { route: 'countdown', status: 'complete', failedCount: 0, legacyKind: 'envelope', legacyCardTypes: ['CountdownCard'] };
  const rows = [100, 200, 300].map((ms, i) => ({ trace: { ...base, routeLatencyMs: ms }, outcome: 'proposed', undone: i === 1 }));
  rows.push({ trace: { ...base, route: null, status: 'pending', routeLatencyMs: 0 }, outcome: 'pending' });
  rows.push({ trace: { ...base, route: null, failedCount: 1, routeLatencyMs: 4000 }, outcome: 'error' });
  const report = summarizeDecisions(rows);
  assert.equal(report.total, 5);assert.equal(report.pending, 1);assert.equal(report.failures, 1);
  assert.equal(report.byRoute.countdown.p50_ms, 200);assert.equal(report.byRoute.countdown.p95_ms, 300);
  assert.equal(report.byRoute.countdown.agreement, 1);assert.equal(report.undone, 1);
  assert.equal(report.byRoute.pending.p50_ms, null);assert.equal(report.byRoute.unavailable.p95_ms, 4000);
});

test('answer accepts an AI NewsCard or visible subtitle without accepting another card type', () => {
  const trace = { route: 'answer', legacyKind: 'envelope', legacyActionTypes: ['card.create'], legacyCardTypes: ['NewsCard'] };
  assert.equal(routeAgreement(trace), true);
  assert.equal(routeAgreement({ ...trace, legacyActionTypes: ['stage.awaken', 'subtitle.show'], legacyCardTypes: [] }), true);
  assert.equal(routeAgreement({ ...trace, legacyCardTypes: ['NoteCard'] }), false);
  assert.equal(routeAgreement({ ...trace, legacyActionTypes: ['stage.awaken'], legacyCardTypes: [] }), false);
  assert.equal(routeAgreement({ ...trace, legacyActionTypes: ['subtitle.show', 'card.delete'], legacyCardTypes: [] }), false);
  assert.equal(routeAgreement({ ...trace, legacyKind: 'unknown' }), null);
  assert.equal(routeAgreement({ ...trace, legacyKind: 'error' }), null);
});

test('valid extension routes compare to ExtensionCard and retain their exact route groups', () => {
  const base = { status: 'complete', legacyKind: 'envelope', failedCount: 0, legacyCardTypes: ['ExtensionCard'], legacyActionTypes: ['card.create'], routeLatencyMs: 100 };
  const rows = [
    { trace: { ...base, route: 'ext.example.fitness-log' }, outcome: 'succeeded', undone: 1 },
    { trace: { ...base, route: 'ext.example.reading', legacyCardTypes: ['NewsCard'] }, outcome: 'proposed', undone: 0 },
    { trace: { ...base, route: 'ext.example.fitness-log', legacyKind: 'error' }, outcome: 'error', undone: 0 },
  ];
  const report = summarizeDecisions(rows);
  assert.equal(report.byRoute['ext.example.fitness-log'].count, 2);
  assert.equal(report.byRoute['ext.example.fitness-log'].compared, 1);
  assert.equal(report.byRoute['ext.example.fitness-log'].agreed, 1);
  assert.equal(report.byRoute['ext.example.reading'].agreed, 0);
  assert.equal(report.byRoute.abstain, undefined);
  assert.match(report.note, /not labeled model accuracy/);
});

for (const route of ['ext', 'ext.', 'ext.Example.bad', 'ext.a..b', 'ext.a_b', 'ext.__proto__', 'ext.constructor.x;DROP', 'ext.example.invalid\n', `ext.${'a'.repeat(81)}`, 'constructor', '__proto__']) {
  test(`rejects malformed or non-contract route ${route}`, () => {
    assert.equal(isReportRoute(route), false);
    assert.equal(routeAgreement({ route, legacyKind: 'envelope', legacyCardTypes: ['ExtensionCard'] }), null);
    assert.equal(summarizeDecisions([{ trace: { route, status: 'complete', failedCount: 0 }, outcome: 'proposed' }]).byRoute.abstain.count, 1);
  });
}

test('recognized routes include bounded package IDs and preserve the old builtin mappings', () => {
  for (const route of ['answer', 'countdown', 'todo', 'note', 'generate', 'ext.a', 'ext.example.fitness-log', `ext.${'a'.repeat(80)}`]) assert.equal(isReportRoute(route), true);
  assert.equal(routeAgreement({ route: 'chat', legacyKind: 'locale', legacyActionTypes: [], legacyCardTypes: [] }), true);
  assert.equal(routeAgreement({ route: 'delete', legacyKind: 'envelope', legacyActionTypes: ['cards.delete'] }), true);
  assert.equal(routeAgreement({ route: 'undo', legacyKind: 'host-operation', legacyActionTypes: ['history.redo'] }), true);
});

test('undo ratios use only succeeded outcomes while preserving all-record counts and undone totals', () => {
  const trace = { route: 'note', status: 'complete', failedCount: 0, legacyKind: 'envelope', legacyCardTypes: ['NoteCard'] };
  const rows = [
    { trace, outcome: 'succeeded', undone: 1 }, { trace, outcome: 'succeeded', undone: 0 },
    { trace, outcome: 'proposed', undone: 1 }, { trace, outcome: 'conflict', undone: 1 },
    { trace, outcome: 'failed', undone: 1 }, { trace, outcome: 'clarify', undone: 0 },
    { trace: { ...trace, route: 'ext.example.fitness-log', legacyCardTypes: ['ExtensionCard'] }, outcome: 'succeeded', undone: 0 },
  ];
  const report = summarizeDecisions(rows), note = report.byRoute.note;
  assert.equal(report.total, 7); assert.equal(report.undone, 4);
  assert.equal(report.succeeded, 3); assert.equal(report.succeededUndone, 1); assert.equal(report.undoRatio, .3333);
  assert.equal(note.count, 6); assert.equal(note.undone, 4);
  assert.equal(note.succeeded, 2); assert.equal(note.succeededUndone, 1); assert.equal(note.undoRatio, .5);
  assert.equal(note.outcomes.conflict, 1); assert.equal(note.outcomes.other, undefined);
  assert.equal(report.byRoute['ext.example.fitness-log'].undoRatio, 0);
  assert.match(report.note, /behavior proxy, not accuracy/);
});

test('zero confirmed executions produces a null undo ratio rather than a success claim', () => {
  const trace = { route: 'answer', status: 'complete', legacyKind: 'envelope', legacyCardTypes: ['NewsCard'] };
  const report = summarizeDecisions([{ trace, outcome: 'proposed', undone: 1 }, { trace, outcome: 'conflict', undone: 0 }]);
  assert.equal(report.succeeded, 0); assert.equal(report.succeededUndone, 0); assert.equal(report.undoRatio, null);
  assert.equal(report.byRoute.answer.undoRatio, null);
  assert.equal(summarizeDecisions([]).undoRatio, null);
});

const now = Date.parse('2026-11-06T03:00:00.000Z');
test('CLI defaults stay at 24 hours without new filters and accept a 168-hour on-mode review', () => {
  const defaults = parseReportArgs([], now);
  assert.deepEqual(defaults, { hours: 24, since: '2026-11-05T03:00:00.000Z', excludeEvaluation: false });
  const weekly = parseReportArgs(['--hours', '168', '--mode', 'on', '--routes', 'answer, ext.example.fitness-log,answer', '--exclude-evaluation', '--account', 'TEST-account_1'], now);
  assert.deepEqual(weekly, { hours: 168, since: '2026-10-30T03:00:00.000Z', mode: 'on', routes: ['answer', 'ext.example.fitness-log'], excludeEvaluation: true, accountId: 'TEST-account_1' });
  assert.equal(parseReportArgs(['--mode', 'shadow'], now).mode, 'shadow');
});

for (const args of [
  ['--hours'], ['--hours', '0'], ['--hours', '-1'], ['--hours', '721'], ['--hours', 'Infinity'], ['--hours', 'NaN'], ['--hours', '168;echo TEST'],
  ['--mode'], ['--mode', 'off'], ['--mode', "on' OR 1=1"], ['--mode', 'on', '--mode', 'shadow'],
  ['--account', "x' OR 1=1 --"], ['--account', 'x\nTEST'], ['--account', 'TEST-account\n'], ['--account', '../account'],
  ['--routes'], ['--routes', 'note,'], ['--routes', 'note,,answer'], ['--routes', 'ext.*'], ['--routes', 'ext.not..valid'],
  ['--routes', 'note) OR 1=1 --'], ['--exclude-evaluation', 'false'], ['--exclude-evaluation', '--exclude-evaluation'],
  ['--unknown'], ['on'], ['--hours', '--exclude-evaluation'],
]) {
  test(`CLI rejects unsafe, missing or ambiguous arguments ${JSON.stringify(args)}`, () => {
    assert.throws(() => parseReportArgs(args, now), /Invalid report filter/);
  });
}

test('query construction validates direct callers instead of relying on CLI validation', () => {
  const valid = parseReportArgs([], now);
  for (const extra of [
    { since: "2026' OR 1=1" }, { since: '2026-11-06' }, { accountId: "');DELETE" }, { mode: 'off' },
    { routes: ['ext.not..valid'] }, { routes: [] }, { routes: 'answer' }, { routes: Array(129).fill('note') },
    { excludeEvaluation: 'false' }, { hours: 0 }, { rawText: 'TEST forbidden query field' },
  ]) assert.throws(() => buildReportQuery({ ...valid, ...extra }), /Invalid report filter/);
});

test('SQL parameterizes every filter and selects only required trace metadata', () => {
  const options = parseReportArgs(['--hours', '168', '--account', 'TEST-account', '--mode', 'on', '--routes', 'answer,ext.example.fitness-log', '--exclude-evaluation'], now);
  const { sql, params } = buildReportQuery(options);
  assert.equal((sql.match(/\?/g) || []).length, params.length);
  assert.deepEqual(params, [options.since, 'TEST-account', 'TEST-account', 'on', 'answer', 'ext.example.fitness-log', 'decision-eval-']);
  for (const value of ['TEST-account', 'ext.example.fitness-log', 'decision-eval-']) assert.equal(sql.includes(value), false);
  const projection = sql.slice(0, sql.indexOf('FROM decision_log'));
  assert.deepEqual([...projection.matchAll(/json_extract\(d\.trace_json,'\$\.([^']+)'\)/g)].map(match => match[1]),
    ['route', 'status', 'legacyKind', 'legacyUsedProvider', 'legacyActionTypes', 'legacyCardTypes', 'latencyMs', 'routeLatencyMs', 'failedCount']);
  const columns = projection.replace(/json_extract\(d\.trace_json,'\$\.[^']+'\)/g, '');
  assert.doesNotMatch(columns, /username|account_id|\btext\b|canvas|attachment|image|trace_json/i);
  assert.doesNotMatch(sql, /SELECT\s+\*|\$\.(?:text|canvas|attachments|images)|\bd\.text\b/i);
  assert.match(sql, /ORDER BY d\.id DESC LIMIT 20000/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM accounts/);
  assert.match(sql, /substr\(a\.username,1,14\)=\?/);
  const unfiltered = buildReportQuery(parseReportArgs([], now));
  assert.equal(unfiltered.sql.includes('accounts'), false);
  assert.deepEqual(unfiltered.params, ['2026-11-05T03:00:00.000Z', null, null]);
});

test('synthetic in-memory SQL proves mode/routes/evaluation exclusion without returning usernames or content', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT); CREATE TABLE decision_log(id INTEGER PRIMARY KEY,at TEXT,account_id TEXT,text TEXT,trace_json TEXT,outcome TEXT,undone INTEGER);');
    for (const [id, username] of [['user', 'TEST-user'], ['eval', 'decision-eval-TEST'], ['suffix', 'TEST-decision-eval-suffix']]) db.prepare('INSERT INTO accounts VALUES(?,?)').run(id, username);
    const base = { mode: 'on', route: 'answer', status: 'complete', legacyKind: 'envelope', legacyUsedProvider: 'gpt',
      legacyActionTypes: ['card.create'], legacyCardTypes: ['NewsCard'], latencyMs: 20, routeLatencyMs: 10, failedCount: 0,
      text: 'TEST_PRIVATE_TEXT', canvas: { text: 'TEST_PRIVATE_CANVAS' }, images: ['TEST_PRIVATE_IMAGE'] };
    const insert = (id, account, mode, route, at = '2026-11-01T00:00:00.000Z') => db.prepare('INSERT INTO decision_log VALUES(?,?,?,?,?,?,?)')
      .run(id, at, account, 'TEST_PRIVATE_ORIGINAL_TEXT', JSON.stringify({ ...base, mode, route }), 'succeeded', 0);
    insert(1, 'user', 'on', 'answer'); insert(2, 'eval', 'on', 'answer'); insert(3, 'user', 'shadow', 'answer');
    insert(4, 'user', 'on', 'note'); insert(5, 'user', 'on', 'ext.example.fitness-log'); insert(6, 'suffix', 'on', 'answer');
    insert(7, 'user', 'on', 'answer', '2026-10-01T00:00:00.000Z');
    const query = buildReportQuery(parseReportArgs(['--hours', '168', '--mode', 'on', '--routes', 'answer,ext.example.fitness-log', '--exclude-evaluation'], now));
    const rows = db.prepare(query.sql).all(...query.params);
    assert.equal(rows.length, 3); assert.deepEqual(rows.map(row => row.route), ['answer', 'ext.example.fitness-log', 'answer']);
    assert.doesNotMatch(JSON.stringify(rows), /TEST_PRIVATE|username|TEST-user|decision-eval|account_id/);
    const accountQuery = buildReportQuery(parseReportArgs(['--hours', '168', '--mode', 'on', '--account', 'user', '--exclude-evaluation'], now));
    assert.equal(db.prepare(accountQuery.sql).all(...accountQuery.params).length, 3);
    const defaultQuery = buildReportQuery(parseReportArgs(['--hours', '168'], now));
    assert.equal(db.prepare(defaultQuery.sql).all(...defaultQuery.params).length, 6);
  } finally { db.close(); }
});

test('the exact serialized report program runs independently with only a fake database and metadata rows', () => {
  const options = parseReportArgs(['--hours', '168', '--mode', 'on', '--routes', 'ext.example.fitness-log', '--exclude-evaluation'], now);
  const logs = [], calls = []; let closed = false;
  class FakeDatabase {
    constructor(path, config) { assert.equal(path, '/data/vivic/space.sqlite'); assert.equal(config.readOnly, true); }
    prepare(sql) {
      if (sql.startsWith('SELECT name FROM sqlite_master')) return { get: () => ({ name: 'decision_log' }) };
      return { all: (...params) => { calls.push({ sql, params }); return [{ outcome: 'succeeded', undone: 1, route: 'ext.example.fitness-log', status: 'complete',
        legacyKind: 'envelope', legacyUsedProvider: 'gpt', actions: '["card.create"]', cards: '["ExtensionCard"]', latencyMs: 20, routeLatencyMs: 10, failedCount: 0 }]; } };
    }
    close() { closed = true; }
  }
  const program = buildReportProgram(options).replace(/^import \{DatabaseSync\} from 'node:sqlite';\n/, '');
  assert.doesNotMatch(program, /^import/);
  runInNewContext(program, { DatabaseSync: FakeDatabase, Buffer, console: { log: value => logs.push(value) } });
  assert.equal(closed, true); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, buildReportQuery(options).params);
  const report = JSON.parse(logs[0]);
  assert.equal(report.available, true); assert.equal(report.total, 1); assert.equal(report.undoRatio, 1);
  assert.equal(report.byRoute['ext.example.fitness-log'].agreement, 1);
  assert.doesNotMatch(logs[0], /username|account_id|TEST_PRIVATE/);
});
