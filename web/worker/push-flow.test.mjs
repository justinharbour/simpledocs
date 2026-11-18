import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { handleVoiceWebhook } from './voice-webhook.mjs';
import { processDelivery, reconcileDeliveries } from './queue-consumer.mjs';
import { applyOutboundFaxEvent } from './deliveries.mjs';
import { createTransmission, approveMail, reviewMail } from './transmissions.mjs';
import { resetPushCache } from './push.mjs';
import { address, jsonRequest, makeEnv, samplePdf, sendRequest } from './test-env.mjs';

const realFetch = globalThis.fetch;
let pushes;
beforeEach(() => {
  resetPushCache(); pushes = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.sandbox.push.apple.com/')) throw new Error(`unexpected ${url}`);
    pushes.push(JSON.parse(init.body));
    return new Response('', { status: 200 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function pushEnv(extra = {}) {
  const { pem } = await (async () => {
    const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey));
    return { pem: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----` };
  })();
  const waiting = [];
  const ctx = makeEnv({ APNS_KEY_P8: pem, APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: 'TEAM123456', waitUntil: promise => waiting.push(promise), ...extra });
  ctx.db.prepare('INSERT INTO push_devices (token, platform, environment) VALUES (?, ?, ?)').run('a'.repeat(64), 'ios', 'sandbox');
  ctx.settle = () => Promise.all(waiting.splice(0));
  return ctx;
}

const kinds = () => pushes.map(p => p.kind);

// Voicemail: one push per recording, however many events arrive.
const now = Date.now(), timestamp = String(Math.floor(now / 1000));
const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const publicKey = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))));
const recordingId = '11111111-1111-4111-8111-111111111111';
const marker = 'marker-1';
const event = (id, type, extra = {}) => ({ data: { id, event_type: type, occurred_at: '2026-01-01T00:00:00Z', payload: {
  connection_id: 'connection', call_control_id: 'leg', recording_id: recordingId, client_state: btoa(`simpledocs-voicemail-recording:${marker}`),
  recording_urls: { mp3: 'https://s3.amazonaws.com/telephony-recorder-prod/audio?signature=secret' }, ...extra } } });
async function signed(body) {
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(`${timestamp}|${body}`)));
  return new Request('https://example.test/api/webhooks/telnyx/voice', { method: 'POST', body, headers: { 'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': btoa(String.fromCharCode(...signature)) } });
}

test('voicemail pushes once per recording: not on duplicate delivery, a second event, or the transcript', async () => {
  const ctx = await pushEnv({ TELNYX_PUBLIC_KEY: publicKey, TELNYX_VOICE_CONNECTION_ID: 'connection' });
  const { env, db } = ctx;
  db.prepare('INSERT INTO voicemail_calls (call_control_id, marker) VALUES (?, ?)').run('leg', marker);
  db.prepare("INSERT INTO voicemail_commands (call_control_id, action, command_id, outcome) VALUES ('leg', 'record_start', 'c', 'accepted')").run();
  const fetcher = async () => new Response('audio');
  const send = async body => (await handleVoiceWebhook(await signed(JSON.stringify(body)), env, fetcher, now)).status;

  assert.equal(await send(event('event-1', 'call.recording.saved')), 200);
  assert.equal(await send(event('event-1', 'call.recording.saved')), 200);
  assert.equal(await send(event('event-2', 'call.recording.saved')), 409);
  assert.equal(await send(event('event-3', 'call.recording.transcription.saved', { status: 'completed', transcription_text: 'Hello' })), 200);
  await ctx.settle();
  assert.deepEqual(kinds(), ['voicemail']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM voice_transcripts').get().n, 1);
});

test('a plain recording that is not a voicemail does not push', async () => {
  const ctx = await pushEnv({ TELNYX_PUBLIC_KEY: publicKey, TELNYX_VOICE_CONNECTION_ID: 'connection' });
  const status = (await handleVoiceWebhook(await signed(JSON.stringify(event('event-1', 'call.recording.saved'))), ctx.env, async () => new Response('audio'), now)).status;
  await ctx.settle();
  assert.equal(status, 200);
  assert.deepEqual(kinds(), []);
});

// Outgoing failures: pushed once, when the delivery itself becomes failed.
async function queuedFax(ctx) {
  const { id, deliveries } = await (await createTransmission(await sendRequest({ title: 'Lease', fax: { recipients: ['5125550100'], cover: { enabled: false } } }, await samplePdf(1)), ctx.env, 'owner')).json();
  return { transmissionId: id, channel: 'fax', deliveryId: deliveries[0].id };
}
const telnyx = (upload = 200) => async url => String(url).endsWith('/v2/media')
  ? new Response('{}', { status: upload })
  : new Response(JSON.stringify({ data: { id: 'fax-provider-1' } }));

test('a permanent fax failure pushes once; redelivery and later provider events do not push again', async () => {
  const ctx = await pushEnv();
  const body = await queuedFax(ctx);
  assert.equal(await processDelivery(ctx.env, body, 1, telnyx(400)), 'ack');
  assert.equal(await processDelivery(ctx.env, body, 2, telnyx(400)), 'ack');
  await ctx.settle();
  assert.deepEqual(kinds(), ['fax-failed']);
  assert.equal(pushes[0].id, body.deliveryId);
});

test('a provider fax.failed pushes once even when the webhook repeats', async () => {
  const ctx = await pushEnv();
  const body = await queuedFax(ctx);
  await processDelivery(ctx.env, body, 1, telnyx());
  await ctx.settle();
  assert.deepEqual(kinds(), []);
  await applyOutboundFaxEvent(ctx.env, 'fax.failed', 'fax-provider-1');
  await applyOutboundFaxEvent(ctx.env, 'fax.failed', 'fax-provider-1');
  await ctx.settle();
  assert.deepEqual(kinds(), ['fax-failed']);
});

test('accepted and delivered faxes never push', async () => {
  const ctx = await pushEnv();
  const body = await queuedFax(ctx);
  await processDelivery(ctx.env, body, 1, telnyx());
  await applyOutboundFaxEvent(ctx.env, 'fax.delivered', 'fax-provider-1');
  await ctx.settle();
  assert.deepEqual(kinds(), []);
});

test('giving up on a stale queued fax pushes once', async () => {
  const ctx = await pushEnv();
  await queuedFax(ctx);
  const later = Date.now() + 2 * 24 * 60 * 60 * 1000;
  await reconcileDeliveries(ctx.env, fetch, later);
  await reconcileDeliveries(ctx.env, fetch, later);
  await ctx.settle();
  assert.deepEqual(kinds(), ['fax-failed']);
});

test('a rejected letter pushes a mail failure once', async () => {
  const ctx = await pushEnv();
  const { id, deliveries } = await (await createTransmission(await sendRequest({ mail: { to: address, from: address } }, await samplePdf(1)), ctx.env, 'owner')).json();
  const mailId = deliveries[0].id;
  const review = await (await reviewMail(new Request('https://example.test/x?mode=test'), ctx.env, 'owner', id, mailId)).json();
  await approveMail(jsonRequest('/x', { confirmed: true, mode: 'test', reviewHash: review.reviewHash }), ctx.env, 'owner', id, mailId);
  const body = { transmissionId: id, channel: 'mail', deliveryId: mailId };
  const rejected = async () => new Response('{}', { status: 422 });
  await processDelivery(ctx.env, body, 1, rejected);
  await processDelivery(ctx.env, body, 2, rejected);
  await ctx.settle();
  assert.deepEqual(kinds(), ['mail-failed']);
});
