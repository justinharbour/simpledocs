import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './test-env.mjs';
import { createEmailDelivery, portal, revokeEmailDelivery } from './email-portal.mjs';
import { newPortalToken } from './portal-crypto.mjs';
const tx = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', verifyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function setup() {
  const messages = []; const result = makeEnv({ PORTAL_ENABLED: 'true', PORTAL_ORIGIN: 'https://example.test', PORTAL_KEY: newPortalToken(), PORTAL_SENDER: 'test@example.test', PORTAL_EMAIL: { send: async m => messages.push(m) }, TELNYX_VERIFY_PROFILE_ID: 'profile' });
  result.db.prepare('INSERT INTO transmissions (id, actor_id, title, source_key, page_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tx, 'owner', 'title', 'source', 1, 'now', 'now');
  result.objects.set('source', new TextEncoder().encode('%PDF-private')); return { ...result, messages };
}
function req(path, data, cookie, origin = 'https://example.test') {
  const headers = { origin, 'cf-connecting-ip': '192.0.2.1' }; if (cookie) headers.cookie = cookie; if (data !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://example.test${path}`, { method: data === undefined ? 'GET' : 'POST', headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
}
async function create(env, messages, pinChannel = 'none') {
  const r = await createEmailDelivery(req('/x', { email: 'a@example.test', pinChannel, phone: '+12125550100' }), env, 'owner', tx); assert.equal(r.status, 202);
  return { ...await r.json(), token: messages.at(-1).text.match(/\/portal#([\w-]+)/)[1] };
}
async function exchange(env, token) { const r = await portal(req('/portal/exchange', { token }), env); return { r, cookie: r.headers.get('set-cookie')?.split(';')[0] }; }
test('encrypted copy, single-use link, session and revocation', async () => {
  const { env, db, objects, messages } = setup(); const d = await create(env, messages); const stored = db.prepare('SELECT * FROM portal_deliveries').get();
  assert.notEqual(stored.token_hash, d.token); assert.equal(new TextDecoder().decode(objects.get(stored.object_key)).includes('private'), false);
  assert.equal((await portal(req('/portal/document'), env)).status, 404);
  assert.equal((await portal(req('/portal/exchange', { token: d.token }, null, 'https://evil.test'), env)).status, 403);
  const { r, cookie } = await exchange(env, d.token); assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Strict/);
  assert.equal((await exchange(env, d.token)).r.status, 404); assert.equal(await (await portal(req('/portal/document', undefined, cookie), env)).text(), '%PDF-private');
  assert.equal((await revokeEmailDelivery(req('/x', {}), env, 'other', tx, d.id)).status, 404);
  assert.equal((await revokeEmailDelivery(req('/x', {}), env, 'owner', tx, d.id)).status, 200); assert.equal((await portal(req('/portal/document', undefined, cookie), env)).status, 404);
});
test('voice verification requires consent and an accepted code', async () => {
  const { env, messages } = setup(), calls = []; const fetcher = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Response.json(url.endsWith('/actions/verify') ? { data: { response_code: 'accepted' } } : { data: { id: verifyId } }); };
  const d = await create(env, messages, 'voice'), { cookie } = await exchange(env, d.token);
  assert.equal((await portal(req('/portal/document', undefined, cookie), env, fetcher)).status, 403);
  assert.equal((await portal(req('/portal/pin/start', { consent: false }, cookie), env, fetcher)).status, 400); assert.equal(calls.length, 0);
  assert.equal((await portal(req('/portal/pin/start', { consent: true }, cookie), env, fetcher)).status, 200); assert.match(calls[0].url, /verifications\/call$/);
  assert.equal((await portal(req('/portal/pin/start', { consent: true }, cookie), env, fetcher)).status, 400);
  assert.equal((await portal(req('/portal/pin/check', { code: '123456' }, cookie), env, fetcher)).status, 200); assert.equal((await portal(req('/portal/document', undefined, cookie), env, fetcher)).status, 200);
});
test('ambiguous provider outcomes are not retried', async () => {
  const { env, messages, db } = setup(), d = await create(env, messages, 'sms'), { cookie } = await exchange(env, d.token); let calls = 0; const broken = async () => { calls++; throw Error('private'); };
  assert.equal((await portal(req('/portal/pin/start', { consent: true }, cookie), env, broken)).status, 503); assert.equal((await portal(req('/portal/pin/start', { consent: true }, cookie), env, broken)).status, 400); assert.equal(calls, 1); assert.equal(db.prepare('SELECT pin_state FROM portal_deliveries').get().pin_state, 'unknown');
  env.PORTAL_EMAIL.send = async () => { throw Error('uncertain'); }; const r = await createEmailDelivery(req('/x', { email: 'other@example.test', pinChannel: 'none' }), env, 'owner', tx); assert.equal((await r.json()).status, 'unknown');
});
