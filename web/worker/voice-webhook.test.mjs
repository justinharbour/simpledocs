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
  db.exec(readFileSync(new URL('../../backend/core/migrations/0004_voice_webhooks.sql', import.meta.url), 'utf8'));
  const DB = { prepare(sql) { return { async all() { return { results: db.prepare(sql).all() }; }, bind(...args) { return { async first() { return db.prepare(sql).get(...args); }, async run() { return db.prepare(sql).run(...args); } }; } }; } };
  const objects = new Map();
  const VOICE_RECORDINGS = { async put(key, value) { objects.set(key, value); }, async get(key) { const value = objects.get(key); return value ? { body: value } : null; } };
  return { env: { DB, VOICE_RECORDINGS, TELNYX_PUBLIC_KEY: publicKey, TELNYX_VOICE_CONNECTION_ID: 'connection' }, db, objects };
}

test('authenticates, durably records, archives privately and deduplicates', async () => {
  const { env, db, objects } = setup(); let downloads = 0;
  const fetcher = async (_url, options) => { downloads++; assert.equal(options.redirect, 'error'); return new Response('audio'); };
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
  const { env } = setup(); delete env.VOICE_RECORDINGS;
  assert.equal((await handleVoiceWebhook(await signed(JSON.stringify(event('call.hangup'))), env, fetch, now)).status, 200);
  assert.equal((await handleVoiceWebhook(await signed(JSON.stringify(event('call.answered'))), env, fetch, now)).status, 409);
});
