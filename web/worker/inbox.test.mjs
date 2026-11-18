import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createWorker } from './index.mjs';
import { makeEnv } from './test-env.mjs';

const issuer = 'https://example.cloudflareaccess.com';
const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'k', alg: 'RS256' }] });
const worker = createWorker(() => keys);
const token = subject => new SignJWT({ email: `${subject}@example.test` }).setProtectedHeader({ alg: 'RS256', kid: 'k' }).setIssuer(issuer).setAudience('aud').setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(privateKey);

const FAX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', FAX2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
const VM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', VM2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc';

function seed(extra = {}) {
  const ctx = makeEnv({ ACCESS_AUDIENCE: 'aud', ACCESS_TEAM_DOMAIN: issuer, ...extra });
  const { db } = ctx;
  db.exec(`
    INSERT INTO inbound_fax_events (event_id, fax_id, event_type, occurred_at, received_at, object_key) VALUES
      ('${FAX}', 'f1', 'fax.received', '2026-01-01T09:00:00Z', '2026-01-01T09:00:00Z', 'inbound-fax/${FAX}/${FAX}.pdf'),
      ('${FAX2}', 'f2', 'fax.received', '2026-01-01T12:00:00Z', '2026-01-01T12:00:00Z', 'inbound-fax/${FAX2}/${FAX2}.pdf'),
      ('${FAX2.replace(/b$/, 'c')}', 'f3', 'fax.received', '2026-01-01T13:00:00Z', '2026-01-01T13:00:00Z', NULL);
    INSERT INTO voice_events (event_id, event_type, call_control_id, occurred_at) VALUES ('e1', 'call.recording.saved', 'leg', '2026-01-01T10:00:00Z');
    INSERT INTO voice_recordings (recording_id, event_id, call_control_id, object_key, content_type, kind, archived_at, from_number, to_number, duration_secs, transcript) VALUES
      ('${VM}', 'e1', 'leg', 'voice/a', 'audio/mpeg', 'voicemail', '2026-01-01 10:00:00', '+12025550101', '+12134587846', 20, 'Hi, call me back about the lease.'),
      ('${VM2}', 'e1', 'leg2', 'voice/b', 'audio/mpeg', 'recording', '2026-01-01 14:00:00', '+12025550101', '+12134587846', 20, NULL);
    INSERT INTO calls (call_control_id, direction, from_number, to_number, started_at, outcome, updated_at) VALUES
      ('c-missed', 'inbound', '+12025550103', '+12134587846', '2026-01-01T11:00:00Z', 'missed', 'x'),
      ('c-answered', 'inbound', '+12025550104', '+12134587846', '2026-01-01T11:30:00Z', 'answered', 'x'),
      ('c-out', 'outbound', '+12134587846', '+12025550105', '2026-01-01T11:40:00Z', 'no answer', 'x');
    INSERT INTO sms_messages (id, provider_id, direction, peer, body, status, created_at, status_at) VALUES
      ('s1', 'p1', 'inbound', '+12025550142', 'first', 'received', '2026-01-01T08:00:00.000Z', '2026-01-01T08:00:00.000Z'),
      ('s2', 'p2', 'inbound', '+12025550142', 'second text', 'received', '2026-01-01T11:45:00.000Z', '2026-01-01T11:45:00.000Z'),
      ('s3', 'p3', 'outbound', '+12025550142', 'my reply', 'delivered', '2026-01-01T11:50:00.000Z', '2026-01-01T11:50:00.000Z'),
      ('s4', 'p4', 'outbound', '+12025550199', 'sent only', 'delivered', '2026-01-01T11:55:00.000Z', '2026-01-01T11:55:00.000Z');
  `);
  return ctx;
}
async function call(env, path, { method = 'GET', subject = 'owner', origin = 'https://example.test' } = {}) {
  const headers = { 'cf-access-jwt-assertion': await token(subject) };
  if (method === 'POST') headers.origin = origin;
  return worker.fetch(new Request(`https://example.test${path}`, { method, headers }), env);
}
const list = async (env, query = '') => (await (await call(env, `/api/inbox${query}`)).json()).items;
const count = async env => (await call(env, '/api/inbox/count')).json();

test('merges faxes, voicemails, missed calls and SMS threads newest first and leaves out everything else', async () => {
  const { env } = seed();
  const items = await list(env);
  assert.deepEqual(items.map(i => `${i.kind}:${i.id}`), [`fax:${FAX2}`, 'sms:+12025550142', 'call:c-missed', `voicemail:${VM}`, `fax:${FAX}`]);
  assert.equal(items.every(i => i.unread), true);
  const fax = items[0], sms = items[1], vm = items[3];
  assert.equal(fax.previewUrl, `/api/inbound-faxes/${FAX2}/pdf?inline=1`);
  assert.equal(sms.preview, 'second text'); assert.equal(sms.unreadCount, 2);
  assert.equal(vm.title, '+12025550101'); assert.match(vm.preview, /lease/); assert.equal(vm.at, '2026-01-01T10:00:00Z');
  assert.equal(vm.previewUrl, `/api/voice/recordings/${VM}`);
});

test('type and limit narrow the list and bad values are refused', async () => {
  const { env } = seed();
  assert.deepEqual((await list(env, '?type=fax')).map(i => i.kind), ['fax', 'fax']);
  assert.deepEqual((await list(env, '?type=sms')).map(i => i.kind), ['sms']);
  assert.equal((await list(env, '?limit=2')).length, 2);
  assert.equal((await call(env, '/api/inbox?type=mail')).status, 400);
  assert.equal((await call(env, '/api/inbox?filter=old')).status, 400);
  assert.equal((await call(env, '/api/inbox', { method: 'POST' })).status, 405);
});

test('read and unread work for every kind and the unread filter and count follow', async () => {
  const { env, db } = seed();
  assert.deepEqual(await count(env), { unread: 5, byKind: { fax: 2, voicemail: 1, call: 1, sms: 1 } });
  for (const [kind, id] of [['fax', FAX], ['voicemail', VM], ['call', 'c-missed'], ['sms', '+12025550142']]) {
    assert.equal((await call(env, `/api/inbox/${kind}/${encodeURIComponent(id)}/read`, { method: 'POST' })).status, 200, kind);
  }
  assert.deepEqual(await count(env), { unread: 1, byKind: { fax: 1, voicemail: 0, call: 0, sms: 0 } });
  assert.deepEqual((await list(env, '?filter=unread')).map(i => i.id), [FAX2]);
  assert.equal((await list(env)).length, 5);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sms_messages WHERE read_at IS NULL AND direction = \'inbound\'').get().n, 0);
  assert.ok(db.prepare('SELECT heard_at FROM voice_recordings WHERE recording_id = ?').get(VM).heard_at);
  for (const [kind, id] of [['fax', FAX], ['voicemail', VM], ['call', 'c-missed'], ['sms', '+12025550142']]) {
    assert.equal((await call(env, `/api/inbox/${kind}/${encodeURIComponent(id)}/unread`, { method: 'POST' })).status, 200, kind);
  }
  // An SMS thread comes back as one unread item, not as every old message.
  assert.deepEqual(await count(env), { unread: 5, byKind: { fax: 2, voicemail: 1, call: 1, sms: 1 } });
  assert.equal((await list(env, '?filter=unread')).length, 5);
});

test('read-all marks everything, or only one kind', async () => {
  const { env } = seed();
  assert.equal((await call(env, '/api/inbox/read-all?kind=fax', { method: 'POST' })).status, 200);
  assert.deepEqual((await count(env)).byKind, { fax: 0, voicemail: 1, call: 1, sms: 1 });
  assert.equal((await call(env, '/api/inbox/read-all?kind=bogus', { method: 'POST' })).status, 400);
  assert.equal((await call(env, '/api/inbox/read-all', { method: 'POST' })).status, 200);
  assert.deepEqual(await count(env), { unread: 0, byKind: { fax: 0, voicemail: 0, call: 0, sms: 0 } });
  assert.deepEqual(await list(env, '?filter=unread'), []);
});

test('unknown ids are not found and no read row is invented for them', async () => {
  const { env, db } = seed();
  for (const [kind, id] of [['fax', FAX2.replace(/b$/, 'c')], ['fax', 'nope'], ['call', 'c-answered'], ['call', 'c-out'], ['voicemail', VM2], ['sms', '+12025550199'], ['mail', 'x']]) {
    assert.equal((await call(env, `/api/inbox/${kind}/${id.replace('+', '%2B')}/read`, { method: 'POST' })).status, 404, `${kind} ${id}`);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM inbox_reads').get().n, 0);
});

test('mutations need POST and a same-origin request', async () => {
  const { env } = seed();
  assert.equal((await call(env, `/api/inbox/fax/${FAX}/read`, { method: 'POST', origin: 'https://evil.test' })).status, 403);
  assert.equal((await call(env, '/api/inbox/read-all', { method: 'POST', origin: 'https://evil.test' })).status, 403);
  assert.equal((await call(env, `/api/inbox/fax/${FAX}/read`)).status, 405);
  assert.equal((await call(env, '/api/inbox/read-all')).status, 405);
  assert.equal((await count(env)).unread, 5);
});

test('voice and SMS items are hidden from anyone but the voice owner, and faxes follow the fax allow list', async () => {
  const { env } = seed({ VOICE_OWNER_SUBJECT: 'owner', INBOUND_FAX_ALLOWED_SUBJECTS: JSON.stringify(['owner', 'clerk']) });
  const asClerk = async path => (await call(env, path, { subject: 'clerk' })).json();
  assert.deepEqual((await asClerk('/api/inbox')).items.map(i => i.kind), ['fax', 'fax']);
  assert.deepEqual(await asClerk('/api/inbox/count'), { unread: 2, byKind: { fax: 2, voicemail: 0, call: 0, sms: 0 } });
  assert.equal((await call(env, `/api/inbox/voicemail/${VM}/read`, { method: 'POST', subject: 'clerk' })).status, 404);
  assert.equal((await call(env, '/api/inbox/sms/%2B12025550142/read', { method: 'POST', subject: 'clerk' })).status, 404);
  await call(env, '/api/inbox/read-all', { method: 'POST', subject: 'clerk' });
  assert.deepEqual(await count(env), { unread: 3, byKind: { fax: 0, voicemail: 1, call: 1, sms: 1 } });
  const stranger = await call(env, '/api/inbox', { subject: 'stranger' });
  assert.deepEqual((await stranger.json()).items, []);
});

test('every inbox route requires Access', async () => {
  const { env } = seed();
  for (const [method, path] of [['GET', '/api/inbox'], ['GET', '/api/inbox/count'], ['POST', `/api/inbox/fax/${FAX}/read`], ['POST', `/api/inbox/fax/${FAX}/unread`], ['POST', '/api/inbox/read-all']]) {
    assert.equal((await worker.fetch(new Request(`https://example.test${path}`, { method }), env)).status, 401, path);
    assert.equal((await worker.fetch(new Request(`https://example.test${path}`, { method, headers: { 'cf-access-jwt-assertion': 'forged' } }), env)).status, 401, `${path} forged`);
  }
});
