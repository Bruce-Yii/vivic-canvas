import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHostedService } from '../apps/local-api/src/hosted/service.ts';

const dataDir = mkdtempSync(path.join(tmpdir(), 'vivic-owner-test-'));
const origin = 'https://vivic.test';
let service = createHostedService({ origin, dataDir, inviteCode: 'owner-integration-invite-one', autoStartReminders: false });
let checks = 0;
const call = (route, token, body, method = body === undefined ? 'GET' : 'POST', extra = {}) => service.fetch(new Request(origin + route, {
  method, headers: { ...(token ? { cookie: `__Host-vivic_space=${token}` } : {}), origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}));
try {
  const a = await service.store.register({ invite: 'owner-integration-invite-one', username: 'owner-one', password: 'isolated-test-password' });
  const space = service.store.listSpaces(a.identity.accountId)[0];
  const created = await call(`/api/space/spaces/${space.id}/commands`, a.token, { requestId: 'create-note', expectedVersion: 0, command: { type: 'note.create', text: 'existing server card' } });
  assert.equal(created.status, 200); checks++;
  let result = await (await call(`/api/space/owner/canvases/${space.id}`, a.token)).json();
  assert.equal(Object.values(result.record.cardsById)[0].displayProps.text, 'existing server card'); checks++;
  const record = result.record, card = record.cardsById[record.cardOrder[0]];
  card.layout = { ...card.layout, x: 140, y: 75, surface: 'user', userPos: { x: 110, y: 90 } }; record.version++;
  const request = { record, expectedVersion: result.serverVersion, requestId: 'owner-move-1' };
  const saved = await call(`/api/space/owner/canvases/${space.id}`, a.token, request, 'PUT');
  assert.equal(saved.status, 200); result = await saved.json(); assert.equal(result.record.cardsById[card.id].layout.surface, 'user'); checks++;
  assert.equal((await call(`/api/space/owner/canvases/${space.id}`, a.token, request, 'PUT')).status, 200); checks++;
  assert.equal((await call(`/api/space/owner/canvases/${space.id}`, a.token, { ...request, requestId: 'stale-update' }, 'PUT')).status, 409); checks++;
  assert.equal((await call(`/api/space/owner/canvases/${space.id}`, undefined)).status, 401); checks++;
  assert.equal((await call(`/api/space/owner/canvases/${space.id}`, a.token, request, 'PUT', { origin: 'https://outside.test' })).status, 401); checks++;
  await service.dispose();
  service = createHostedService({ origin, dataDir, inviteCode: 'owner-integration-invite-two', autoStartReminders: false });
  const b = await service.store.register({ invite: 'owner-integration-invite-two', username: 'owner-two', password: 'isolated-test-password' });
  result = await (await call(`/api/space/owner/canvases/${space.id}`, a.token)).json();
  assert.equal(result.record.cardsById[card.id].layout.surface, 'user'); assert.equal(result.record.cardsById[card.id].layout.x, 140); checks++;
  assert.equal((await call(`/api/space/owner/canvases/${space.id}`, b.token)).status, 404); checks++;
  assert.equal((await call(`/api/space/owner/canvases/${space.id}`, b.token, { ...request, expectedVersion: result.serverVersion }, 'PUT')).status, 404); checks++;
  await call('/api/space/owner/meta/displayPreferences', a.token, { value: '{"theme":"dark"}' }, 'PUT');
  assert.equal((await (await call('/api/space/owner/meta/displayPreferences', b.token)).json()).value, undefined); checks++;
  const other = { ...record, id: 'canvas_new-test', cardsById: {}, cardOrder: [], version: 0 };
  const newRequest = { record: other, expectedVersion: null, requestId: 'new-canvas-test' };
  assert.equal((await call('/api/space/owner/canvases/canvas_new-test', a.token, newRequest, 'PUT')).status, 200);
  assert.equal((await call('/api/space/owner/canvases/canvas_new-test', a.token, newRequest, 'PUT')).status, 200);
  assert.equal(service.store.listSpaces(a.identity.accountId).length, 2); checks++;
  assert.equal((await call('/api/gpt/login/start', a.token, {})).status, 404); checks++;
  assert.equal((await call('/api/providers/status', a.token)).status, 200); checks++;
  assert.equal((await call('/api/space/owner/canvases/canvas_new-test', a.token, { record: { ...other, cardOrder: ['missing'] }, expectedVersion: 1, requestId: 'bad-card' }, 'PUT')).status, 400); checks++;
  console.log(JSON.stringify({ ok: true, checks, dataDir, verified: ['existing server data', 'portal surfaces', 'durable restart', 'stale-version rejection', 'deduplication', 'account isolation', 'same-origin authentication', 'model status', 'local runtime blocked'] }, null, 2));
} finally { await service.dispose(); }
