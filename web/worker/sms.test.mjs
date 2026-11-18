import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from './index.mjs';
import { handleSms, handleSmsWebhook } from './sms.mjs';
import { jsonRequest, makeEnv } from './test-env.mjs';

const OURS = '+12134587846', PEER = '+12025550142';
const now = Date.now(), timestamp = String(Math.floor(now / 1000));
const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const publicKey = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))));
const setup = () => makeEnv({ SMS_NUMBER: OURS, TELNYX_PUBLIC_KEY: publicKey });

async function signed(body, ts = timestamp) {
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(`${ts}|${body}`)));
  return new Request('https://example.test/api/webhooks/telnyx/messaging', { method: 'POST', body, headers: { 'telnyx-timestamp': ts, 'telnyx-signature-ed25519': btoa(String.fromCharCode(...signature)) } });
}
const received = (id, text, extra = {}) => ({ data: { id: `evt-${id}`, event_type: 'message.received', occurred_at: '2026-01-01T10:00:00Z', payload: { id, direction: 'inbound', from: { phone_number: PEER }, to: [{ phone_number: OURS }], text, ...extra } } });
const status = (id, event_type, state, at, errors) => ({ data: { id: `evt-${id}-${state}`, event_type, occurred_at: at, payload: { id, direction: 'outbound', from: { phone_number: OURS }, to: [{ phone_number: PEER, status: state }], text: 'hi', errors } } });
const hook = (env, event) => signedHook(env, JSON.stringify(event));
const signedHook = async (env, body) => handleSmsWebhook(await signed(body), env, now);
const accepted = (id = 'tel-1', state = 'queued') => async () => Response.json({ data: { id, to: [{ phone_number: PEER, status: state }] } });

test('webhook needs a valid signature', async () => {
  const { env, db } = setup();
  const body = JSON.stringify(received('m1', 'hello'));
  assert.equal((await handleSmsWebhook(new Request('https://example.test/x', { method: 'POST', body }), env, now)).status, 401);
  const bad = await signed(body); bad.headers.set('telnyx-signature-ed25519', btoa('x'.repeat(64)));
  assert.equal((await handleSmsWebhook(bad, env, now)).status, 401);
  assert.equal((await handleSmsWebhook(await signed(body, '1000'), env, now)).status, 401);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sms_messages').get().n, 0);
  const worker = createWorker();
  assert.equal((await worker.fetch(new Request('https://example.test/api/webhooks/telnyx/messaging', { method: 'POST', body }), env)).status, 401);
  assert.equal((await handleSmsWebhook(new Request('https://example.test/x'), env, now)).status, 405);
});

test('an inbound message creates a thread and a duplicate delivery changes nothing', async () => {
  const { env, db } = setup();
  assert.equal((await hook(env, received('m1', 'hello'))).status, 200);
  assert.equal((await hook(env, received('m1', 'hello'))).status, 200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sms_messages').get().n, 1);
  const threads = await (await handleSms(new Request('https://example.test/api/sms/threads'), env)).json();
  assert.deepEqual(threads.threads.map(t => [t.peer, t.body, t.unread]), [[PEER, 'hello', 1]]);
  const thread = await (await handleSms(new Request(`https://example.test/api/sms/threads/${encodeURIComponent(PEER)}`), env)).json();
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].direction, 'inbound');
});

test('messages for another number or from our own number are ignored', async () => {
  const { env, db } = setup();
  await hook(env, received('m1', 'hi', { to: [{ phone_number: '+12134147728' }] }));
  await hook(env, received('m2', 'hi', { from: { phone_number: OURS } }));
  await hook(env, { data: { id: 'x', event_type: 'message.delivery_something', occurred_at: '2026-01-01T10:00:00Z', payload: { id: 'm3' } } });
  assert.equal(db.prepare('SELECT count(*) AS n FROM sms_messages').get().n, 0);
  assert.equal((await signedHook(env, 'not json')).status, 400);
});

test('send validates, writes a row, calls Telnyx and stores the provider id as sending, not delivered', async () => {
  const { env, db } = setup(); const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); return accepted()(); };
  const response = await handleSms(jsonRequest('/api/sms/messages', { to: '(202) 555-0142', text: 'Hello there' }), env, fetcher);
  assert.equal(response.status, 200);
  const { message } = await response.json();
  assert.equal(message.status, 'sending'); assert.equal(message.peer, PEER);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telnyx.com/v2/messages');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token');
  assert.deepEqual(JSON.parse(calls[0].options.body), { from: OURS, to: PEER, text: 'Hello there' });
  assert.equal(db.prepare('SELECT provider_id FROM sms_messages').get().provider_id, 'tel-1');
});

test('send rejects bad numbers, empty or long text, a foreign origin and a missing token without calling Telnyx', async () => {
  const { env, db } = setup(); let called = 0;
  const fetcher = async () => { called++; return accepted()(); };
  for (const body of [{ to: '12', text: 'x' }, { to: PEER, text: '' }, { to: PEER, text: '   ' }, { to: PEER, text: 'x'.repeat(1601) }, { to: PEER }, { to: OURS, text: 'x' }]) {
    assert.equal((await handleSms(jsonRequest('/api/sms/messages', body), env, fetcher)).status, 400, JSON.stringify(body).slice(0, 40));
  }
  const cross = new Request('https://example.test/api/sms/messages', { method: 'POST', body: JSON.stringify({ to: PEER, text: 'x' }), headers: { origin: 'https://evil.test' } });
  assert.equal((await handleSms(cross, env, fetcher)).status, 403);
  assert.equal((await handleSms(jsonRequest('/api/sms/messages', { to: PEER, text: 'x'.repeat(1600) }), env, accepted())).status, 200);
  assert.equal((await handleSms(new Request('https://example.test/api/sms/messages'), env, fetcher)).status, 405);
  const noToken = makeEnv({ SMS_NUMBER: OURS, TELNYX_API_TOKEN: '' });
  assert.equal((await handleSms(jsonRequest('/api/sms/messages', { to: PEER, text: 'x' }), noToken.env, fetcher)).status, 503);
  assert.equal(called, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sms_messages').get().n, 1);
});

test('a provider error marks the message failed with the carrier reason and no secrets', async () => {
  const { env, db } = setup();
  const fetcher = async () => Response.json({ errors: [{ code: '40010', title: 'Not 10DLC registered', detail: 'Register the number.' }] }, { status: 400 });
  const response = await handleSms(jsonRequest('/api/sms/messages', { to: PEER, text: 'hi' }), env, fetcher);
  assert.equal(response.status, 502);
  const { message, error } = await response.json();
  assert.match(error, /10DLC|Register/);
  assert.equal(message.status, 'failed'); assert.equal(message.errorCode, '40010');
  assert.match(message.errorText, /10DLC/);
  const row = db.prepare('SELECT status, provider_id FROM sms_messages').get();
  assert.equal(row.status, 'failed'); assert.equal(row.provider_id, null);
  const network = await handleSms(jsonRequest('/api/sms/messages', { to: PEER, text: 'again' }), env, async () => { throw new Error('Bearer token leaked'); });
  const body = await network.json();
  assert.equal(body.message.status, 'failed');
  assert.equal(JSON.stringify(body).includes('leaked'), false);
});

test('status events update an outbound message and never move backwards from delivered or failed', async () => {
  const { env, db } = setup();
  await handleSms(jsonRequest('/api/sms/messages', { to: PEER, text: 'hi' }), env, accepted('tel-1'));
  const state = () => db.prepare("SELECT status, error_code FROM sms_messages WHERE provider_id = 'tel-1'").get();
  await hook(env, status('tel-1', 'message.finalized', 'delivered', '2026-01-01T10:00:05Z'));
  assert.equal(state().status, 'delivered');
  // Out-of-order: an earlier "sent" event arrives after delivery.
  await hook(env, status('tel-1', 'message.sent', 'sent', '2026-01-01T10:00:02Z'));
  await hook(env, status('tel-1', 'message.finalized', 'delivery_failed', '2026-01-01T10:00:06Z', [{ code: '30003' }]));
  assert.equal(state().status, 'delivered');
  assert.equal(db.prepare('SELECT count(*) AS n FROM sms_messages').get().n, 1);

  await handleSms(jsonRequest('/api/sms/messages', { to: PEER, text: 'second' }), env, accepted('tel-2'));
  await hook(env, status('tel-2', 'message.sent', 'sent', '2026-01-01T10:00:02Z'));
  await hook(env, status('tel-2', 'message.finalized', 'delivery_failed', '2026-01-01T10:00:06Z', [{ code: '40008', title: 'Blocked', detail: 'Carrier blocked it' }]));
  await hook(env, status('tel-2', 'message.sent', 'sent', '2026-01-01T10:00:07Z'));
  const failed = db.prepare("SELECT status, error_code, error_text FROM sms_messages WHERE provider_id = 'tel-2'").get();
  assert.deepEqual([failed.status, failed.error_code], ['failed', '40008']);
  assert.match(failed.error_text, /Carrier blocked it/);
});

test('a status event that arrives before the send response is kept and the send adopts it', async () => {
  const { env, db } = setup();
  const fetcher = async () => { await hook(env, status('tel-9', 'message.finalized', 'delivered', '2026-01-01T10:00:05Z')); return accepted('tel-9')(); };
  const response = await handleSms(jsonRequest('/api/sms/messages', { to: PEER, text: 'hi' }), env, fetcher);
  assert.equal(response.status, 200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sms_messages').get().n, 1);
  assert.equal(db.prepare('SELECT status FROM sms_messages').get().status, 'delivered');
  assert.equal((await response.json()).message.status, 'delivered');
});

test('read marks only inbound messages of that thread and needs a same-origin POST', async () => {
  const { env } = setup();
  await hook(env, received('m1', 'a')); await hook(env, received('m2', 'b'));
  const path = `/api/sms/threads/${encodeURIComponent(PEER)}/read`;
  const cross = new Request(`https://example.test${path}`, { method: 'POST', headers: { origin: 'https://evil.test' } });
  assert.equal((await handleSms(cross, env)).status, 403);
  assert.equal((await handleSms(new Request(`https://example.test${path}`), env)).status, 405);
  assert.equal((await handleSms(jsonRequest(path, {}), env)).status, 200);
  const threads = await (await handleSms(new Request('https://example.test/api/sms/threads'), env)).json();
  assert.equal(threads.threads[0].unread, 0);
  assert.equal((await handleSms(new Request('https://example.test/api/sms/threads/not-a-number'), env)).status, 404);
});

test('every SMS route requires Access and the voice owner', async () => {
  const { env } = setup();
  const worker = createWorker();
  for (const [method, path] of [['GET', '/api/sms/threads'], ['GET', `/api/sms/threads/${encodeURIComponent(PEER)}`], ['POST', '/api/sms/messages'], ['POST', `/api/sms/threads/${encodeURIComponent(PEER)}/read`]]) {
    assert.equal((await worker.fetch(new Request(`https://example.test${path}`, { method }), env)).status, 401, path);
    assert.equal((await worker.fetch(new Request(`https://example.test${path}`, { method, headers: { 'cf-access-jwt-assertion': 'forged' } }), env)).status, 401, `${path} forged`);
  }
});
