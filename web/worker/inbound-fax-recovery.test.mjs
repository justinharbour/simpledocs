import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { recoverInboundFax } from './inbound-fax.mjs';

const event = '11111111-1111-4111-8111-111111111111';
const fax = '22222222-2222-4222-8222-222222222222';
function setup() {
  const db = new DatabaseSync(':memory:');
  for (const file of ['0007_inbound_fax_events.sql', '0010_inbound_fax_pending.sql']) db.exec(readFileSync(new URL(`../../backend/core/migrations/${file}`, import.meta.url), 'utf8'));
  db.prepare('INSERT INTO inbound_fax_pending VALUES (?, ?, ?, ?)').run(event, fax, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z');
  const objects = new Map();
  const env = { TELNYX_FAX_RECOVERY_ENABLED: 'true', TELNYX_INBOUND_FAX_ENABLED: 'true', TELNYX_API_TOKEN: 'synthetic', TELNYX_FAX_CONNECTION_ID: 'connection', TELNYX_FAX_NUMBER: '+12025550101', FILES: { async put(key, value) { objects.set(key, value); } }, DB: { prepare(sql) { return { bind(...args) { return { async first() { return db.prepare(sql).get(...args) ?? null; }, async run() { db.prepare(sql).run(...args); return { success: true }; } }; } }; } } };
  const data = { record_type: 'fax', id: fax, direction: 'inbound', connection_id: 'connection', to: '+12025550101', status: 'received', media_url: 'https://s3.amazonaws.com/faxes-prod/test/a.pdf?signature=synthetic' };
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); if (url.endsWith('/refresh')) return Response.json({ data: { result: 'ok' } }); if (url.startsWith('https://api.telnyx.com/')) return Response.json({ data }); return new Response('%PDF-synthetic', { headers: { 'content-type': 'application/pdf' } }); };
  return { db, env, data, objects, fetcher, calls };
}
test('refreshes, validates and archives a pending fax exactly once', async () => {
  const s = setup();
  assert.equal(await recoverInboundFax(s.env, event, { fetcher: s.fetcher }), true);
  assert.equal(s.calls.length, 3);
  assert.equal(s.calls[0].options.method, 'POST');
  assert.equal(s.calls[1].options.method, 'GET');
  assert.equal(s.calls[2].options.headers, undefined);
  assert.equal(s.objects.size, 1);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM inbound_fax_unarchived').get().n, 0);
  assert.equal(await recoverInboundFax(s.env, event, { fetcher: s.fetcher }), false);
  assert.equal(s.calls.length, 3);
});
test('fails closed on disabled recovery, mismatched fax identity and unsafe media', async () => {
  for (const [field, value] of [['id', 'wrong'], ['direction', 'outbound'], ['connection_id', 'other'], ['to', '+12025550102'], ['status', 'failed'], ['record_type', 'other'], ['media_url', 'https://evil.test/file.pdf?x=1']]) {
    const s = setup(); s.data[field] = value;
    assert.equal(await recoverInboundFax(s.env, event, { fetcher: s.fetcher }), false, field);
    assert.equal(s.objects.size, 0);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM inbound_fax_unarchived').get().n, 1);
  }
  const s = setup(); s.env.TELNYX_FAX_RECOVERY_ENABLED = 'false';
  assert.equal(await recoverInboundFax(s.env, event, { fetcher: s.fetcher }), false);
  assert.equal(s.calls.length, 0);
});
test('does not archive on refresh failure or malformed media', async () => {
  for (const fetcher of [async () => new Response('', { status: 503 }), async url => url.endsWith('/refresh') ? Response.json({ data: { result: 'ok' } }) : url.startsWith('https://api.telnyx.com/') ? Response.json({ data: { record_type: 'fax', id: fax, direction: 'inbound', connection_id: 'connection', to: '+12025550101', status: 'received', media_url: 'https://s3.amazonaws.com/faxes-prod/test/a.pdf?x=1' } }) : new Response('not pdf', { headers: { 'content-type': 'application/pdf' } })]) {
    const s = setup(); assert.equal(await recoverInboundFax(s.env, event, { fetcher }), false);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM inbound_fax_unarchived').get().n, 1);
  }
});
