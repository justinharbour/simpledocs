import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createWorker } from './index.mjs';
import { handleVoiceWebhook, handleVoiceRecording, listVoiceRecordings } from './voice-webhook.mjs';

const now = Date.now(), timestamp = String(Math.floor(now / 1000));
const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const publicKey = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))));
const id = '11111111-1111-4111-8111-111111111111';
const event = (type = 'call.recording.saved') => ({ data: { id: 'event-1', event_type: type, occurred_at: '2026-01-01T00:00:00Z', payload: { connection_id: 'connection', call_control_id: 'leg', recording_id: id, recording_urls: { mp3: 'https://s3.amazonaws.com/telephony-recorder-prod/audio?signature=secret' } } } });
async function signed(body, ts = timestamp) {
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(`${ts}|${body}`)));
  return new Request('https://example.test/api/webhooks/telnyx/voice', { method: 'POST', body, headers: { 'telnyx-timestamp': ts, 'telnyx-signature-ed25519': btoa(String.fromCharCode(...signature)) } });
}
function setup() {
  const db = new DatabaseSync(':memory:');
  for (const name of ['0008_voice_webhooks.sql', '0012_transmissions.sql', '0013_transcripts.sql', '0017_ai_voicemail.sql']) db.exec(readFileSync(new URL(`../../backend/core/migrations/${name}`, import.meta.url), 'utf8'));
  const DB = { prepare(sql) { return { async all() { return { results: db.prepare(sql).all() }; }, bind(...args) { return { async first() { return db.prepare(sql).get(...args); }, async run() { return db.prepare(sql).run(...args); } }; } }; } };
  const objects = new Map();
  const FILES = { async put(key, value) { objects.set(key, value); }, async get(key) { const value = objects.get(key); return value ? { body: value } : null; } };
  return { env: { DB, FILES, TELNYX_PUBLIC_KEY: publicKey, TELNYX_VOICE_CONNECTION_ID: 'connection' }, db, objects };
}

test('authenticates, durably records, archives privately and deduplicates', async () => {
  const { env, db, objects } = setup(); let downloads = 0;
  const fetcher = async (_url, options) => { downloads++; assert.equal(options.redirect, 'manual'); return new Response('audio'); };
  const body = JSON.stringify(event());
  assert.equal((await handleVoiceWebhook(await signed(body), env, fetcher, now)).status, 200);
  assert.equal((await handleVoiceWebhook(await signed(body), env, fetcher, now)).status, 200);
  assert.equal(downloads, 1); assert.equal(objects.size, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM voice_events').get().n, 1);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM voice_events').get()).includes('secret'), false);
  const response = await handleVoiceRecording(new Request('https://example.test'), env, id);
  assert.equal(response.status, 200); assert.equal(await response.text(), 'audio');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await (await listVoiceRecordings(new Request('https://example.test'), env)).json()).recordings[0].recording_id, id);
  const worker = createWorker();
  assert.equal((await worker.fetch(new Request(`https://example.test/api/voice/recordings/${id}`), env)).status, 401);
});

test('rejects forged, stale, mismatched connection and unsafe recording URL', async () => {
  const { env, db } = setup(); const body = JSON.stringify(event());
  const bad = await signed(body); bad.headers.set('telnyx-signature-ed25519', btoa('x'.repeat(64)));
  assert.equal((await handleVoiceWebhook(bad, env, fetch, now)).status, 401);
  assert.equal((await handleVoiceWebhook(await signed(body, '1000'), env, fetch, now)).status, 401);
  const wrong = event(); wrong.data.payload.connection_id = 'other';
  assert.equal((await handleVoiceWebhook(await signed(JSON.stringify(wrong)), env, fetch, now)).status, 400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM voice_events').get().n, 0);
  const unsafe = event(); unsafe.data.payload.recording_urls.mp3 = 'https://example.com/secret';
  assert.equal((await handleVoiceWebhook(await signed(JSON.stringify(unsafe)), env, () => { throw Error('must not fetch'); }, now)).status, 503);
  assert.equal(db.prepare('SELECT count(*) AS n FROM voice_events').get().n, 1);
});

test('storage failure returns retryable response and later retry archives', async () => {
  const { env, db } = setup(); const body = JSON.stringify(event());
  assert.equal((await handleVoiceWebhook(await signed(body), env, async () => { throw Error('offline'); }, now)).status, 503);
  assert.equal(db.prepare('SELECT count(*) AS n FROM voice_events').get().n, 1);
  assert.equal((await handleVoiceWebhook(await signed(body), env, async () => new Response('audio'), now)).status, 200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM voice_recordings').get().n, 1);
});

test('lifecycle event requires no recording storage and conflicts are rejected', async () => {
  const { env } = setup(); delete env.FILES;
  assert.equal((await handleVoiceWebhook(await signed(JSON.stringify(event('call.hangup'))), env, fetch, now)).status, 200);
  assert.equal((await handleVoiceWebhook(await signed(JSON.stringify(event('call.answered'))), env, fetch, now)).status, 409);
});

test('voicemail answers only dedicated incoming calls, greets then records and classifies its recording', async () => {
  const { env, db } = setup();
  Object.assign(env, { VOICEMAIL_ENABLED: 'true', VOICE_INBOUND_ENABLED: 'true', VOICEMAIL_NUMBER: '+12025550102', VOICEMAIL_GREETING: 'Please leave a message.', TELNYX_API_TOKEN: 'test' });
  const commands = [];
  const fetcher = async (url, options) => {
    if (url.startsWith('https://api.telnyx.com/')) { commands.push({ url, body: JSON.parse(options.body) }); return Response.json({ data: { result: 'ok' } }); }
    return new Response('audio');
  };
  const send = async (type, eventId, extra = {}) => {
    const e = event(type); e.data.id = eventId; Object.assign(e.data.payload, extra);
    return handleVoiceWebhook(await signed(JSON.stringify(e)), env, fetcher, now);
  };
  assert.equal((await send('call.initiated', 'init', { direction: 'incoming', to: '+12025550102' })).status, 200);
  assert.equal((await send('call.initiated', 'init', { direction: 'incoming', to: '+12025550102' })).status, 200);
  assert.equal(commands.length, 1); assert.match(commands[0].url, /\/answer$/);
  const marker = commands[0].body.client_state;
  await send('call.answered', 'answered', { client_state: marker });
  assert.match(commands[1].url, /\/speak$/);
  assert.deepEqual(commands[1].body, { client_state: marker, payload: 'Please leave a message.', payload_type: 'text', voice: 'Telnyx.KokoroTTS.af', language: 'en-US', command_id: commands[1].body.command_id });
  await send('call.speak.ended', 'unmatched-speech', { client_state: btoa('unrelated') });
  assert.equal(commands.length, 2);
  await send('call.speak.ended', 'spoken', { client_state: marker });
  assert.match(commands[2].url, /\/record_start$/);
  assert.equal(commands[2].body.transcription, true);
  assert.equal(commands[2].body.transcription_engine, 'A');
  assert.equal(commands[2].body.transcription_language, 'en-US');
  assert.equal(commands.slice(0, 2).some(c => 'transcription' in c.body), false);
  await send('call.recording.saved', 'recorded', { client_state: commands[2].body.client_state });
  assert.equal(db.prepare('SELECT kind FROM voice_recordings').get().kind, 'voicemail');
});

async function greetingCommand(env, callId) {
  const commands = [];
  const fetcher = async (url, options) => { commands.push({ url, body: JSON.parse(options.body) }); return Response.json({ data: { result: 'ok' } }); };
  const send = async (type, eventId, extra) => { const e = event(type); e.data.id = eventId; Object.assign(e.data.payload, { call_control_id: callId }, extra); return handleVoiceWebhook(await signed(JSON.stringify(e)), env, fetcher, now); };
  await send('call.initiated', `init-${callId}`, { direction: 'incoming', to: '+12025550102' });
  await send('call.answered', `answered-${callId}`, { client_state: commands[0].body.client_state });
  return commands.find(c => c.url.endsWith('/speak'));
}
const voicemailEnv = extra => ({ VOICEMAIL_ENABLED: 'true', VOICE_INBOUND_ENABLED: 'true', VOICEMAIL_NUMBER: '+12025550102', TELNYX_API_TOKEN: 'test', ...extra });
const store = (db, values) => { for (const [key, value] of Object.entries(values)) db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(`voicemail_${key}`, value, 'now'); };

test('voicemail speaks the stored greeting and voice at call time, ahead of the environment', async () => {
  const { env, db } = setup();
  Object.assign(env, voicemailEnv({ VOICEMAIL_GREETING: 'From env' }));
  store(db, { greeting: 'Stored hello', voice: 'AWS.Polly.Joanna-Neural', service_level: 'premium' });
  const speak = await greetingCommand(env, 'named');
  assert.equal(speak.body.payload, 'Stored hello');
  assert.equal(speak.body.voice, 'AWS.Polly.Joanna-Neural');
  assert.equal(speak.body.payload_type, 'text');
  assert.equal('service_level' in speak.body, false);
  db.prepare("UPDATE settings SET value = 'female' WHERE key = 'voicemail_voice'").run();
  const legacy = await greetingCommand(env, 'legacy');
  assert.equal(legacy.body.voice, 'female');
  assert.equal(legacy.body.service_level, 'premium');
});

test('voicemail falls back to the environment greeting and default voice, and needs one of the two greetings', async () => {
  const fromEnv = setup();
  Object.assign(fromEnv.env, voicemailEnv({ VOICEMAIL_GREETING: 'From env' }));
  const speak = await greetingCommand(fromEnv.env, 'env');
  assert.equal(speak.body.payload, 'From env');
  assert.equal(speak.body.voice, 'Telnyx.KokoroTTS.af');
  assert.equal('service_level' in speak.body, false);

  const storedOnly = setup();
  Object.assign(storedOnly.env, voicemailEnv());
  store(storedOnly.db, { greeting: 'Only stored' });
  assert.equal((await greetingCommand(storedOnly.env, 'stored')).body.payload, 'Only stored');

  const neither = setup();
  Object.assign(neither.env, voicemailEnv());
  let count = 0;
  const e = event('call.initiated'); Object.assign(e.data.payload, { direction: 'incoming', to: '+12025550102' });
  await handleVoiceWebhook(await signed(JSON.stringify(e)), neither.env, async () => { count++; return new Response('ok'); }, now);
  assert.equal(count, 0);
});

test('disabled, unrelated, outbound and stale calls never trigger commands', async () => {
  const { env } = setup(); let count = 0;
  const fetcher = async () => { count++; return new Response('ok'); };
  const send = async (type, id, extra) => { const e = event(type); e.data.id = id; Object.assign(e.data.payload, extra); return handleVoiceWebhook(await signed(JSON.stringify(e)), env, fetcher, now); };
  await send('call.initiated', 'disabled', { direction: 'incoming', to: '+12025550102' });
  Object.assign(env, { VOICEMAIL_ENABLED: 'true', VOICE_INBOUND_ENABLED: 'true', VOICEMAIL_NUMBER: '+12025550102', VOICEMAIL_GREETING: 'Leave a message.', TELNYX_API_TOKEN: 'test' });
  await send('call.initiated', 'outgoing', { direction: 'outgoing', to: '+12025550102' });
  await send('call.initiated', 'wrong-number', { direction: 'incoming', to: '+12025550103' });
  await send('call.hangup', 'ended', {});
  await send('call.initiated', 'late', { direction: 'incoming', to: '+12025550102' });
  assert.equal(count, 0);
});

test('uncertain provider command is not retried and generic recording remains unclassified', async () => {
  const { env, db } = setup(); let count = 0;
  Object.assign(env, { VOICEMAIL_ENABLED: 'true', VOICE_INBOUND_ENABLED: 'true', VOICEMAIL_NUMBER: '+12025550102', VOICEMAIL_GREETING: 'Leave a message.', TELNYX_API_TOKEN: 'test' });
  const e = event('call.initiated'); Object.assign(e.data.payload, { direction: 'incoming', to: '+12025550102' });
  const send = async () => handleVoiceWebhook(await signed(JSON.stringify(e)), env, async () => { count++; throw Error('timeout'); }, now);
  await send(); await send(); assert.equal(count, 1);
  assert.equal(db.prepare('SELECT outcome FROM voicemail_commands').get().outcome, 'unknown');
  const recording = event(); recording.data.id = 'record';
  assert.equal((await handleVoiceWebhook(await signed(JSON.stringify(recording)), env, async () => new Response('audio'), now)).status, 200);
  assert.equal(db.prepare('SELECT kind FROM voice_recordings').get().kind, 'recording');
});
