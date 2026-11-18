import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleVoiceWebhook, listVoiceRecordings } from './voice-webhook.mjs';

const now = Date.now(), timestamp = String(Math.floor(now / 1000));
const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const publicKey = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))));
const id = '22222222-2222-4222-8222-222222222222';

async function signed(body, ts = timestamp) {
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(`${ts}|${body}`)));
  return new Request('https://example.test/api/webhooks/telnyx/voice', { method: 'POST', body, headers: { 'telnyx-timestamp': ts, 'telnyx-signature-ed25519': btoa(String.fromCharCode(...signature)) } });
}
function setup() {
  const db = new DatabaseSync(':memory:');
  for (const name of ['0008_voice_webhooks.sql', '0012_transmissions.sql', '0013_transcripts.sql']) db.exec(readFileSync(new URL(`../../backend/core/migrations/${name}`, import.meta.url), 'utf8'));
  const DB = { prepare(sql) { return { async all() { return { results: db.prepare(sql).all() }; }, bind(...args) { return { async first() { return db.prepare(sql).get(...args); }, async run() { return db.prepare(sql).run(...args); } }; } }; } };
  const objects = new Map();
  const FILES = { async put(key, value) { objects.set(key, value); }, async get(key) { const value = objects.get(key); return value ? { body: value } : null; } };
  return { env: { DB, FILES, TELNYX_PUBLIC_KEY: publicKey, TELNYX_VOICE_CONNECTION_ID: 'connection' }, db };
}
const saved = (eventId = 'saved-1', recordingId = id) => ({ data: { id: eventId, event_type: 'call.recording.saved', occurred_at: '2026-01-01T00:00:00Z', payload: { connection_id: 'connection', call_control_id: 'leg', recording_id: recordingId, recording_urls: { mp3: 'https://s3.amazonaws.com/telephony-recorder-prod/audio' } } } });
const transcribed = (eventId = 'text-1', text = 'Hi, please call me back.', extra = {}) => ({ data: { id: eventId, event_type: 'call.recording.transcription.saved', occurred_at: '2026-01-01T00:01:00Z', payload: { connection_id: 'connection', call_control_id: 'leg', recording_id: id, recording_transcription_id: 'tr-1', status: 'completed', transcription_text: text, ...extra } } });
const send = async (env, e) => handleVoiceWebhook(await signed(JSON.stringify(e)), env, async () => new Response('audio'), now);
const row = db => db.prepare('SELECT transcript, transcript_at FROM voice_recordings WHERE recording_id = ?').get(id);

test('transcript that arrives after the recording is stored on it', async () => {
  const { env, db } = setup();
  assert.equal((await send(env, saved())).status, 200);
  assert.equal(row(db).transcript, null);
  assert.equal((await send(env, transcribed())).status, 200);
  assert.equal(row(db).transcript, 'Hi, please call me back.');
  assert.ok(row(db).transcript_at);
  const listed = (await (await listVoiceRecordings(new Request('https://example.test'), env)).json()).recordings[0];
  assert.equal(listed.transcript, 'Hi, please call me back.');
});

test('transcript that arrives before the recording is held and applied when it is saved', async () => {
  const { env, db } = setup();
  assert.equal((await send(env, transcribed())).status, 200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM voice_recordings').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM voice_transcripts').get().n, 1);
  assert.equal((await send(env, saved())).status, 200);
  assert.equal(row(db).transcript, 'Hi, please call me back.');
});

test('duplicate and repeated transcript deliveries are harmless', async () => {
  const { env, db } = setup();
  await send(env, saved());
  assert.equal((await send(env, transcribed())).status, 200);
  assert.equal((await send(env, transcribed())).status, 200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM voice_events').get().n, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM voice_transcripts').get().n, 1);
  const first = row(db);
  // A different event for the same recording never replaces the stored text.
  assert.equal((await send(env, transcribed('text-2', 'Something else entirely'))).status, 200);
  assert.deepEqual(row(db), first);
  // A redelivered recording event keeps the transcript too.
  assert.equal((await send(env, saved())).status, 200);
  assert.deepEqual(row(db), first);
});

test('same event id with different content conflicts and bad payloads are not stored', async () => {
  const { env, db } = setup();
  await send(env, saved());
  await send(env, transcribed());
  const clash = transcribed(); clash.data.payload.call_control_id = 'other-leg';
  assert.equal((await send(env, clash)).status, 409);
  const badId = transcribed('text-3'); badId.data.payload.recording_id = 'not-a-uuid';
  assert.equal((await send(env, badId)).status, 400);
  const failed = transcribed('text-4', 'ignored', { status: 'error' });
  assert.equal((await send(env, failed)).status, 200);
  assert.equal(row(db).transcript, 'Hi, please call me back.');
});

test('a transcript from another call leg is not applied to the recording', async () => {
  const { env, db } = setup();
  const stranger = transcribed('text-5', 'not yours'); stranger.data.payload.call_control_id = 'other-leg';
  await send(env, stranger);
  await send(env, saved());
  assert.equal(row(db).transcript, null);
});

test('transcription events need a valid signature', async () => {
  const { env, db } = setup();
  const request = await signed(JSON.stringify(transcribed())); request.headers.set('telnyx-signature-ed25519', btoa('x'.repeat(64)));
  assert.equal((await handleVoiceWebhook(request, env, fetch, now)).status, 401);
  assert.equal(db.prepare('SELECT count(*) AS n FROM voice_transcripts').get().n, 0);
});
