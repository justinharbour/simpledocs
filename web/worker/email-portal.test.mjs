import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './test-env.mjs';
import { cleanupPortal, createEmailDelivery, portal, revokeEmailDelivery } from './email-portal.mjs';
import { newPortalToken } from './portal-crypto.mjs';
const tx = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', verifyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function setup() {
  const messages = []; const result = makeEnv({ PORTAL_ENABLED: 'true', PORTAL_VERIFY_ENABLED: 'true', PORTAL_ORIGIN: 'https://example.test', PORTAL_KEY: newPortalToken(), PORTAL_SENDER: 'test@example.test', PORTAL_EMAIL: { send: async m => messages.push(m) }, TELNYX_VERIFY_PROFILE_ID: verifyId });
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
test('session insertion and consumption roll back together on database failure', async () => {
  const { env, db, messages } = setup(), d = await create(env, messages);
  db.exec("CREATE TRIGGER fail_consumption BEFORE UPDATE OF consumed_at ON portal_deliveries BEGIN SELECT RAISE(ABORT, 'injected'); END");
  await assert.rejects(exchange(env, d.token));
  assert.equal(db.prepare('SELECT consumed_at FROM portal_deliveries').get().consumed_at, null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM portal_sessions').get().n, 0);
  db.exec('DROP TRIGGER fail_consumption');
  assert.equal((await exchange(env, d.token)).r.status, 200);
});
test('concurrent link exchanges produce exactly one session', async () => {
  const { env, db, messages } = setup(), d = await create(env, messages);
  const results = await Promise.all([exchange(env, d.token), exchange(env, d.token)]);
  assert.deepEqual(results.map(x => x.r.status).sort(), [200, 404]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM portal_sessions').get().n, 1);
});
test('failed delivery registration leaves a retryable orphan cleanup intent', async () => {
  const { env, db, objects, messages } = setup();
  env.FILES.delete = async key => { objects.delete(key); };
  db.exec("CREATE TRIGGER fail_portal BEFORE INSERT ON portal_deliveries BEGIN SELECT RAISE(ABORT, 'injected'); END");
  await assert.rejects(createEmailDelivery(req('/x', { email: 'a@example.test', pinChannel: 'none' }), env, 'owner', tx));
  assert.equal(messages.length, 0);
  const intent = db.prepare('SELECT * FROM portal_object_intents').get();
  assert.ok(objects.has(intent.object_key));
  await cleanupPortal(env, intent.cleanup_after - 1);
  assert.ok(objects.has(intent.object_key));
  await cleanupPortal(env, intent.cleanup_after);
  assert.equal(objects.has(intent.object_key), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM portal_object_intents').get().n, 0);
});
test('failed or ambiguous R2 writes retain cleanup intent and failed deletes retry', async () => {
  const { env, db, objects } = setup();
  env.FILES.put = async (key, value) => { objects.set(key, value); throw Error('ambiguous write'); };
  await assert.rejects(createEmailDelivery(req('/x', { email: 'a@example.test', pinChannel: 'none' }), env, 'owner', tx));
  const intent = db.prepare('SELECT * FROM portal_object_intents').get();
  env.FILES.delete = async () => { throw Error('temporary'); };
  await cleanupPortal(env, intent.cleanup_after);
  assert.ok(objects.has(intent.object_key));
  assert.equal(db.prepare('SELECT count(*) AS n FROM portal_object_intents').get().n, 1);
  env.FILES.delete = async key => { objects.delete(key); };
  await cleanupPortal(env, intent.cleanup_after);
  assert.equal(objects.has(intent.object_key), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM portal_object_intents').get().n, 0);
});
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
  env.PORTAL_EMAIL.send = async () => { throw Error('uncertain'); }; const r = await createEmailDelivery(req('/x', { email: 'other@example.test', pinChannel: 'none' }), env, 'owner', tx); assert.equal(r.status, 409);
});

test('five failed PIN checks exhaust the durable limit without further provider calls', async () => {
  const { env, messages } = setup(), d = await create(env, messages, 'sms'), { cookie } = await exchange(env, d.token); let checks = 0;
  const fetcher = async url => url.endsWith('/actions/verify') ? (checks++, Response.json({ data: { response_code: 'rejected' } })) : Response.json({ data: { id: verifyId } });
  assert.equal((await portal(req('/portal/pin/start', { consent: true }, cookie), env, fetcher)).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await portal(req('/portal/pin/check', { code: '000000' }, cookie), env, fetcher)).status, 403);
  assert.equal((await portal(req('/portal/pin/check', { code: '000000' }, cookie), env, fetcher)).status, 429);
  assert.equal(checks, 5); assert.equal((await portal(req('/portal/document', undefined, cookie), env)).status, 403);
});

test('GET of the portal does not consume a link and scripts require a nonce', async () => {
  const { env, messages, db } = setup(), d = await create(env, messages);
  const page = await portal(req('/portal'), env);
  assert.equal(page.status, 200);
  const nonce = page.headers.get('content-security-policy').match(/'nonce-([\w-]+)'/)[1];
  assert.match(await page.text(), new RegExp(`<script nonce="${nonce}">`));
  assert.equal(db.prepare('SELECT consumed_at FROM portal_deliveries').get().consumed_at, null);
  const { r } = await exchange(env, d.token); assert.equal(r.status, 200);
});

test('recipient cookies are host-bound; invalid origin, duplicate cookie and disabled feature fail closed', async () => {
  const { env, messages } = setup(), d = await create(env, messages);
  const { r, cookie } = await exchange(env, d.token);
  assert.match(r.headers.get('set-cookie'), /^__Host-sdportal=[\w-]+; Path=\/; Secure; HttpOnly; SameSite=Strict/);
  assert.equal((await portal(req('/portal/document', undefined, `${cookie}; ${cookie}`), env)).status, 404);
  assert.equal((await portal(new Request('https://other.test/portal/document', { headers: { cookie } }), env)).status, 404);
  env.PORTAL_ENABLED = 'false';
  assert.equal((await portal(req('/portal/document', undefined, cookie), env)).status, 404);
  assert.equal((await revokeEmailDelivery(req('/x', {}), env, 'owner', tx, d.id)).status, 200);
});

test('provider ambiguity is persisted and repeat attempts cannot send', async () => {
  const { env, db } = setup(); let calls = 0;
  env.PORTAL_EMAIL.send = async () => { calls++; throw Error('timeout'); };
  const request = () => req('/x', { email: 'recipient@example.test', pinChannel: 'none' });
  assert.equal((await (await createEmailDelivery(request(), env, 'owner', tx)).json()).status, 'unknown');
  assert.equal((await createEmailDelivery(request(), env, 'owner', tx)).status, 409);
  assert.equal(calls, 1); assert.equal(db.prepare('SELECT status FROM email_attempts').get().status, 'unknown');
});

test('cleanup removes expired objects and sessions but retains audit record', async () => {
  const { env, db, objects, messages } = setup(), d = await create(env, messages), { cookie } = await exchange(env, d.token);
  const key = db.prepare('SELECT object_key FROM portal_deliveries').get().object_key;
  env.FILES.delete = async k => { objects.delete(k); };
  db.prepare('UPDATE portal_deliveries SET expires_at = 1').run();
  db.prepare('UPDATE portal_sessions SET expires_at = 1').run();
  await cleanupPortal(env);
  assert.equal(objects.has(key), false); assert.equal(db.prepare('SELECT object_key FROM portal_deliveries').get().object_key, '');
  assert.equal(db.prepare('SELECT count(*) AS n FROM portal_sessions').get().n, 0);
  assert.equal((await portal(req('/portal/document', undefined, cookie), env)).status, 404);
});
