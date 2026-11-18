import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonRequest, makeEnv } from './test-env.mjs';
import { tvApprove, tvDevices, tvPairStart, tvPoll, tvRevoke } from './tv-pairing.mjs';
import { tvApi } from './tv-api.mjs';

const PORTAL_KEY = Buffer.alloc(32, 7).toString('base64url');
const env = extra => makeEnv({ PORTAL_KEY, ...extra }).env;
const start = (e, ip) => tvPairStart(new Request('https://example.test/tv/pair/start', { method: 'POST', headers: { origin: 'https://example.test', 'content-type': 'application/json', 'cf-connecting-ip': ip ?? '192.0.2.1' }, body: '{"deviceName":"Living room"}' }), e);
const poll = (e, deviceCode) => tvPoll(jsonRequest('/tv/pair/poll', { deviceCode }), e);
const approve = (e, userCode, actor = 'owner') => tvApprove(jsonRequest('/api/tv/pair/approve', { userCode, confirmed: true }), e, actor);
const api = (e, path, token, method = 'GET') => tvApi(new Request(`https://example.test${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} }), e);
const devices = (e, actor) => tvDevices(new Request('https://example.test/api/tv/devices'), e, actor).then(r => r.json());

async function paired(e, actor = 'owner', ip) {
  const s = await (await start(e, ip)).json();
  await approve(e, s.userCode, actor);
  const body = await (await poll(e, s.deviceCode)).json();
  return { token: body.accessToken, code: s.userCode, deviceCode: s.deviceCode };
}

test('an approved code redeems once, then the device code is dead', async () => {
  const e = env();
  const s = await (await start(e)).json();
  assert.equal((await (await poll(e, s.deviceCode)).json()).error, 'authorization_pending');
  await approve(e, s.userCode);
  const first = await poll(e, s.deviceCode);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).scope, 'tv:read');
  assert.equal((await (await poll(e, s.deviceCode)).json()).error, 'expired_token');
});

test('an expired code cannot be approved or redeemed', async () => {
  const { env: e, db } = makeEnv({ PORTAL_KEY });
  const s = await (await start(e)).json();
  db.exec('UPDATE tv_pairings SET expires_at = 0');
  assert.equal((await approve(e, s.userCode)).status, 404);
  assert.equal((await (await poll(e, s.deviceCode)).json()).error, 'expired_token');
});

test('the database holds only hashes of the device code, user code and token', async () => {
  const { env: e, db } = makeEnv({ PORTAL_KEY });
  const { token, code, deviceCode } = await paired(e);
  const rows = JSON.stringify(db.prepare('SELECT * FROM tv_pairings').all());
  assert.ok(!rows.includes(token) && !rows.includes(deviceCode) && !rows.includes(code));
});

test('a TV token is read-only and never reaches owner routes', async () => {
  const e = env({ ACCESS_AUDIENCE: 'aud', ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com' });
  const { token } = await paired(e);
  assert.equal((await api(e, '/tv/api/dashboard', token, 'POST')).status, 405);
  assert.equal((await api(e, '/tv/api/dashboard', token, 'PUT')).status, 405);
  assert.equal((await api(e, '/tv/api/dashboard', '')).status, 401);
  assert.equal((await api(e, '/tv/api/dashboard', 'not-a-token')).status, 401);
  assert.equal((await api(e, '/tv/api/dashboard', token)).status, 200);
  assert.equal((await api(e, '/tv/api/settings', token)).status, 404);
});

test('revoking a device stops its token on the next request', async () => {
  const e = env();
  const { token } = await paired(e);
  const [device] = (await devices(e, 'owner')).devices;
  assert.equal((await tvRevoke(jsonRequest('/x', {}), e, 'owner', device.id)).status, 200);
  assert.equal((await api(e, '/tv/api/dashboard', token)).status, 401);
});

test('one owner cannot revoke another owner’s device or see its list', async () => {
  const e = env();
  const { token } = await paired(e, 'alice');
  const [device] = (await devices(e, 'alice')).devices;
  assert.equal((await tvRevoke(jsonRequest('/x', {}), e, 'mallory', device.id)).status, 404);
  assert.equal((await devices(e, 'mallory')).devices.length, 0);
  assert.equal((await api(e, '/tv/api/dashboard', token)).status, 200);
});

test('start and poll are rate limited per IP', async () => {
  const e = env();
  for (let i = 0; i < 10; i++) assert.equal((await start(e, '192.0.2.9')).status, 200);
  assert.equal((await start(e, '192.0.2.9')).status, 429);
});

test('a TV token cannot read another owner’s transmission PDF', async () => {
  const { env: e, db, objects } = makeEnv({ PORTAL_KEY });
  const { token } = await paired(e, 'owner');
  db.exec(`INSERT INTO transmissions (id, actor_id, title, source_key, page_count, created_at, updated_at) VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'mallory', 'Private', 'outbound/x/document.pdf', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  objects.set('outbound/x/document.pdf', new Uint8Array([37, 80, 68, 70]));
  assert.equal((await api(e, '/tv/api/documents/t:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pdf', token)).status, 404);
});

test('only a recent unended call counts as ringing', async () => {
  const { env: e, db } = makeEnv({ PORTAL_KEY });
  const { token } = await paired(e);
  const now = Date.now(), at = ms => new Date(now - ms).toISOString();
  const insert = db.prepare("INSERT INTO calls (call_control_id, direction, from_number, to_number, started_at, ended_at, outcome, updated_at) VALUES (?, 'inbound', '+15550000000', '+15550000001', ?, ?, ?, ?)");
  insert.run('live', at(10000), null, 'ringing', at(0));
  insert.run('stuck', at(3600000), null, 'ringing', at(0));
  insert.run('done', at(30000), at(5000), 'voicemail', at(0));
  const body = await (await api(e, '/tv/api/dashboard', token)).json();
  assert.deepEqual(body.calls.last24h, { ringing: 1, answered: 0, missed: 0, voicemail: 1 });
});
