import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from './index.mjs';
import { handleVoiceWebhook } from './voice-webhook.mjs';
import { handlePresence, phoneOnline } from './voice-presence.mjs';
import { jsonRequest, makeEnv } from './test-env.mjs';

const now = Date.now(), timestamp = String(Math.floor(now / 1000));
const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const publicKey = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))));
const OURS = '+12134587846';

function setup(extra = {}) {
  return makeEnv({ TELNYX_PUBLIC_KEY: publicKey, TELNYX_VOICE_CONNECTION_ID: 'connection', VOICEMAIL_ENABLED: 'true', VOICE_INBOUND_ENABLED: 'true', VOICEMAIL_NUMBER: OURS, VOICEMAIL_GREETING: 'Leave a message.', TELNYX_WEBRTC_CREDENTIAL_ID: 'cred-1', ...extra });
}
async function post(env, fetcher, type, id, payload) {
  const body = JSON.stringify({ data: { id, event_type: type, occurred_at: '2026-01-01T00:00:00Z', payload: { connection_id: 'connection', call_control_id: 'leg-a', ...payload } } });
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(`${timestamp}|${body}`)));
  const request = new Request('https://example.test/api/webhooks/telnyx/voice', { method: 'POST', body, headers: { 'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': btoa(String.fromCharCode(...signature)) } });
  return handleVoiceWebhook(request, env, fetcher, now);
}
const incoming = { direction: 'incoming', from: '+12025550101', to: OURS };
const goOnline = db => db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('phone_online', ?, 'x')").run(new Date().toISOString());

function telnyx({ transfer = 'ok', credential = 'ok' } = {}) {
  const commands = [];
  const fetcher = async (url, options = {}) => {
    if (url.includes('/telephony_credentials/')) {
      commands.push({ url });
      if (credential === 'fail') return new Response('nope', { status: 500 });
      return Response.json({ data: { sip_username: 'gencred123', sip_password: 'must-not-be-used' } });
    }
    const body = JSON.parse(options.body);
    commands.push({ url, body });
    if (url.endsWith('/transfer') && transfer === 'reject') return Response.json({ errors: [{ code: '90018' }] }, { status: 422 });
    if (url.endsWith('/transfer') && transfer === 'throw') throw new Error('timeout');
    return Response.json({ data: { result: 'ok' } });
  };
  return { commands, fetcher, actions: () => commands.filter(c => c.body).map(c => c.url.split('/').pop()) };
}

test('presence heartbeat stores a timestamp, expires, and can go offline; it needs a same-origin POST', async () => {
  const { env, db } = setup();
  assert.equal(await phoneOnline(env.DB), false);
  assert.equal((await handlePresence(jsonRequest('/api/voice/presence', {}), env)).status, 200);
  assert.equal(await phoneOnline(env.DB), true);
  assert.equal(await phoneOnline(env.DB, Date.now() + 2 * 60 * 1000), false);
  assert.equal((await handlePresence(jsonRequest('/api/voice/presence', { online: false }), env)).status, 200);
  assert.equal(await phoneOnline(env.DB), false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM settings WHERE key = 'phone_online'").get().n, 1);
  const cross = new Request('https://example.test/api/voice/presence', { method: 'POST', headers: { origin: 'https://evil.test' } });
  assert.equal((await handlePresence(cross, env)).status, 403);
  assert.equal((await handlePresence(new Request('https://example.test/api/voice/presence'), env)).status, 405);
  const worker = createWorker();
  assert.equal((await worker.fetch(new Request('https://example.test/api/voice/presence', { method: 'POST' }), env)).status, 401);
});

test('offline phone: voicemail answers immediately, exactly as before', async () => {
  const { env } = setup(); const t = telnyx();
  await post(env, t.fetcher, 'call.initiated', 'init', incoming);
  assert.deepEqual(t.actions(), ['answer']);
  assert.equal(t.commands.some(c => c.url.includes('telephony_credentials')), false);
});

test('AI starts on answered caller leg and a 4xx does not trigger competing voicemail', async () => {
  for (const rejected of [false, true]) {
    const { env } = setup({ TELNYX_AI_ASSISTANT_ID: 'assistant-test', AI_TOOL_BASE_URL: 'https://example.test' });
    const t = telnyx();
    const fetcher = async (url, options) => {
      if (url.endsWith('/ai_assistant_start') && rejected) { t.commands.push({ url, body: JSON.parse(options.body) }); return new Response('', { status: 422 }); }
      return t.fetcher(url, options);
    };
    await post(env, fetcher, 'call.initiated', 'init', incoming);
    const answer = t.commands.find(c => c.url.endsWith('/answer'));
    await post(env, fetcher, 'call.answered', 'answered', { client_state: answer.body.client_state });
    await post(env, fetcher, 'call.answered', 'answered', { client_state: answer.body.client_state });
    assert.deepEqual(t.actions(), ['answer', 'ai_assistant_start']);
    const start = t.commands.find(c => c.url.endsWith('/ai_assistant_start')).body;
    assert.equal(start.assistant.id, 'assistant-test');
    assert.equal(start.assistant.tools.length, 3);
  }
});

test('online phone: rings the softphone with a timeout, then answers voicemail when nobody picks up', async () => {
  const { env, db } = setup(); goOnline(db); const t = telnyx();
  await post(env, t.fetcher, 'call.initiated', 'init', incoming);
  await post(env, t.fetcher, 'call.initiated', 'init', incoming);
  assert.deepEqual(t.actions(), ['transfer']);
  const transfer = t.commands.find(c => c.url.endsWith('/transfer')).body;
  assert.equal(transfer.to, 'sip:gencred123@sip.telnyx.com');
  assert.equal(transfer.timeout_secs, 20);
  assert.equal(transfer.from, '+12025550101');
  assert.equal(JSON.stringify(t.commands).includes('must-not-be-used'), false);
  assert.equal(db.prepare('SELECT outcome FROM voicemail_rings').get().outcome, 'accepted');
  // The softphone leg is a second leg with our marker; its timeout hangup starts voicemail on the caller's leg.
  const legState = transfer.target_leg_client_state;
  await post(env, t.fetcher, 'call.initiated', 'leg-init', { call_control_id: 'leg-b', direction: 'outgoing', client_state: legState });
  assert.deepEqual(t.actions(), ['transfer']);
  await post(env, t.fetcher, 'call.hangup', 'leg-hangup', { call_control_id: 'leg-b', client_state: legState, hangup_cause: 'timeout' });
  await post(env, t.fetcher, 'call.hangup', 'leg-hangup', { call_control_id: 'leg-b', client_state: legState, hangup_cause: 'timeout' });
  assert.deepEqual(t.actions(), ['transfer', 'answer']);
  const answer = t.commands.find(c => c.url.endsWith('/answer'));
  assert.match(answer.url, /leg-a\/actions\/answer$/);
  // The existing greeting and record flow continues from the answer.
  await post(env, t.fetcher, 'call.answered', 'answered', { client_state: answer.body.client_state });
  assert.deepEqual(t.actions(), ['transfer', 'answer', 'speak']);
  // The softphone leg never shows up as its own call in the log; the caller's leg ends as a voicemail call.
  assert.equal(db.prepare("SELECT count(*) AS n FROM calls WHERE call_control_id = 'leg-b'").get().n, 0);
});

test('online phone: when the softphone answers there is no voicemail and the call is logged as answered', async () => {
  const { env, db } = setup(); goOnline(db); const t = telnyx();
  await post(env, t.fetcher, 'call.initiated', 'init', incoming);
  const legState = t.commands.find(c => c.url.endsWith('/transfer')).body.target_leg_client_state;
  await post(env, t.fetcher, 'call.answered', 'leg-answered', { call_control_id: 'leg-b', client_state: legState });
  await post(env, t.fetcher, 'call.hangup', 'leg-hangup', { call_control_id: 'leg-b', client_state: legState, hangup_cause: 'normal_clearing' });
  await post(env, t.fetcher, 'call.hangup', 'a-hangup', { hangup_cause: 'normal_clearing' });
  assert.deepEqual(t.actions(), ['transfer']);
  assert.equal(db.prepare("SELECT outcome FROM calls WHERE call_control_id = 'leg-a'").get().outcome, 'answered');
});

test('a declined softphone leg falls back to voicemail too', async () => {
  const { env, db } = setup(); goOnline(db); const t = telnyx();
  await post(env, t.fetcher, 'call.initiated', 'init', incoming);
  const legState = t.commands.find(c => c.url.endsWith('/transfer')).body.target_leg_client_state;
  await post(env, t.fetcher, 'call.hangup', 'leg-hangup', { call_control_id: 'leg-b', client_state: legState, hangup_cause: 'call_rejected' });
  assert.deepEqual(t.actions(), ['transfer', 'answer']);
});

test('a rejected transfer or a failed credential lookup goes straight to voicemail; an unknown transfer waits', async () => {
  for (const options of [{ transfer: 'reject' }, { credential: 'fail' }]) {
    const { env, db } = setup(); goOnline(db); const t = telnyx(options);
    await post(env, t.fetcher, 'call.initiated', 'init', incoming);
    assert.equal(t.actions().at(-1), 'answer', JSON.stringify(options));
  }
  const { env, db } = setup(); goOnline(db); const t = telnyx({ transfer: 'throw' });
  await post(env, t.fetcher, 'call.initiated', 'init', incoming);
  assert.deepEqual(t.actions(), ['transfer']);
  assert.equal(db.prepare('SELECT outcome FROM voicemail_rings').get().outcome, 'unknown');
});

test('without a WebRTC credential the phone is never rung', async () => {
  const { env, db } = setup({ TELNYX_WEBRTC_CREDENTIAL_ID: undefined }); goOnline(db); const t = telnyx();
  await post(env, t.fetcher, 'call.initiated', 'init', incoming);
  assert.deepEqual(t.actions(), ['answer']);
});

test('a ring-leg event on the softphone credential connection is accepted only with a marker we issued', async () => {
  const { env, db } = setup(); goOnline(db); const t = telnyx();
  await post(env, t.fetcher, 'call.initiated', 'init', incoming);
  const legState = t.commands.find(c => c.url.endsWith('/transfer')).body.target_leg_client_state;
  const foreign = { connection_id: 'softphone-connection', call_control_id: 'leg-b' };
  const events = () => db.prepare('SELECT count(*) AS n FROM voice_events').get().n;
  const before = events();

  // No marker, an unknown marker, and a marker for a call that was never rung are all rejected.
  assert.equal((await post(env, t.fetcher, 'call.hangup', 'no-marker', { ...foreign })).status, 400);
  assert.equal((await post(env, t.fetcher, 'call.hangup', 'unknown', { ...foreign, client_state: btoa('simpledocs-ring-leg:unknown') })).status, 400);
  assert.equal((await post(env, t.fetcher, 'call.hangup', 'prefix', { ...foreign, client_state: btoa('simpledocs-ring-leg:') })).status, 400);
  assert.equal((await post(env, t.fetcher, 'call.hangup', 'other-state', { ...foreign, client_state: btoa('simpledocs-voicemail:x') })).status, 400);
  assert.equal(events(), before);
  assert.deepEqual(t.actions(), ['transfer']);

  // A genuine ring leg reporting the other connection is processed and starts voicemail.
  const response = await post(env, t.fetcher, 'call.hangup', 'leg-hangup', { ...foreign, client_state: legState, hangup_cause: 'timeout' });
  assert.equal(response.status, 200);
  assert.deepEqual(t.actions(), ['transfer', 'answer']);
  assert.match(t.commands.find(c => c.url.endsWith('/answer')).url, /leg-a\/actions\/answer$/);
});

test('plain events and recordings on a foreign connection are still rejected, even with a valid marker', async () => {
  const { env, db } = setup(); goOnline(db); const t = telnyx();
  await post(env, t.fetcher, 'call.initiated', 'init', incoming);
  const legState = t.commands.find(c => c.url.endsWith('/transfer')).body.target_leg_client_state;
  assert.equal((await post(env, t.fetcher, 'call.initiated', 'foreign', { ...incoming, connection_id: 'other', call_control_id: 'leg-z' })).status, 400);
  assert.equal((await post(env, t.fetcher, 'call.hangup', 'foreign-hangup', { connection_id: 'other', call_control_id: 'leg-a' })).status, 400);
  const saved = await post(env, t.fetcher, 'call.recording.saved', 'rec', { connection_id: 'other', call_control_id: 'leg-b', client_state: legState, recording_id: '11111111-1111-4111-8111-111111111111' });
  assert.equal(saved.status, 400);
  assert.deepEqual(t.actions(), ['transfer']);
});

test('signature verification still comes first for foreign-connection ring-leg events', async () => {
  const { env, db } = setup(); goOnline(db); const t = telnyx();
  await post(env, t.fetcher, 'call.initiated', 'init', incoming);
  const legState = t.commands.find(c => c.url.endsWith('/transfer')).body.target_leg_client_state;
  const body = JSON.stringify({ data: { id: 'forged', event_type: 'call.hangup', occurred_at: '2026-01-01T00:00:00Z', payload: { connection_id: 'softphone-connection', call_control_id: 'leg-b', client_state: legState } } });
  const request = new Request('https://example.test/api/webhooks/telnyx/voice', { method: 'POST', body, headers: { 'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': btoa('x'.repeat(64)) } });
  assert.equal((await handleVoiceWebhook(request, env, t.fetcher, now)).status, 401);
  assert.deepEqual(t.actions(), ['transfer']);
});
