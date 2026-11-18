import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleInboundFax } from './inbound-fax.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const fax = '22222222-2222-4222-8222-222222222222';
const now = 1700000000000;
const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const b64 = bytes => Buffer.from(bytes).toString('base64');
const publicKey = b64(await crypto.subtle.exportKey('raw', keys.publicKey));
function fixture(overrides = {}) {
  return { data: { id, event_type: 'fax.received', occurred_at: '2023-11-14T22:13:20Z', payload: { fax_id: fax, direction: 'inbound', connection_id: 'test-connection', to: '+12025550101', media_url: 'https://s3.amazonaws.com/faxes-prod/test/file.pdf?signature=synthetic', ...overrides } } };
}
async function signed(body, timestamp = String(now / 1000)) {
  const text = JSON.stringify(body);
  const signature = b64(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(`${timestamp}|${text}`)));
  return new Request('https://example.test/webhooks/telnyx/fax', { method: 'POST', body: text, headers: { 'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': signature } });
}
function setup() {
  const rows = new Map(), pending = new Map(), objects = new Map(); let downloads = 0;
  const env = {
    TELNYX_INBOUND_FAX_ENABLED: 'true', TELNYX_PUBLIC_KEY: publicKey, TELNYX_FAX_CONNECTION_ID: 'test-connection', TELNYX_FAX_NUMBER: '+12025550101',
    DB: { prepare(sql) { return { bind(...args) { return { async first() { return sql.includes('inbound_fax_pending') ? pending.get(args[0]) ?? null : rows.get(args[0]) ?? null; }, async run() { if (!sql.startsWith('INSERT')) throw Error(); if (sql.includes('inbound_fax_pending')) { if (!pending.has(args[0])) pending.set(args[0], { fax_id: args[1], occurred_at: args[2], received_at: args[3] }); } else if (!rows.has(args[0])) rows.set(args[0], args); return { success: true }; } }; } }; } },
    FILES: { async put(key, bytes) { objects.set(key, bytes); } },
  };
  const fetcher = async () => { downloads++; return new Response('%PDF-test', { headers: { 'Content-Type': 'application/pdf' } }); };
  return { env, rows, pending, objects, fetcher, downloads: () => downloads };
}

test('verified received fax is stored privately before acknowledgement, duplicates do not fetch', async () => {
  const s = setup();
  assert.equal((await handleInboundFax(await signed(fixture()), s.env, { now, fetcher: s.fetcher })).status, 200);
  assert.equal(s.rows.size, 1); assert.equal(s.objects.size, 1);
  assert.ok(!JSON.stringify([...s.rows.values()]).includes('signature=synthetic'));
  assert.equal((await handleInboundFax(await signed(fixture()), s.env, { now, fetcher: s.fetcher })).status, 200);
  assert.equal(s.downloads(), 1);
});
test('fails closed for missing config, invalid signatures, stale requests, wrong connection and wrong direction', async () => {
  const s = setup();
  assert.equal((await handleInboundFax(await signed(fixture()), { ...s.env, TELNYX_INBOUND_FAX_ENABLED: 'false' }, { now, fetcher: s.fetcher })).status, 503);
  assert.equal((await handleInboundFax(await signed(fixture(), String(now / 1000 - 301)), s.env, { now, fetcher: s.fetcher })).status, 401);
  assert.equal((await handleInboundFax(await signed(fixture()), { ...s.env, TELNYX_PUBLIC_KEY: b64(new Uint8Array(32)) }, { now, fetcher: s.fetcher })).status, 401);
  assert.equal((await handleInboundFax(await signed(fixture({ connection_id: 'other' })), s.env, { now, fetcher: s.fetcher })).status, 400);
  assert.equal((await handleInboundFax(await signed(fixture({ direction: 'outbound' })), s.env, { now, fetcher: s.fetcher })).status, 400);
  assert.equal(s.rows.size, 0); assert.equal(s.downloads(), 0);
});
test('unsafe URLs and failed media or storage never acknowledge', async () => {
  for (const url of ['http://s3.amazonaws.com/faxes-prod/x?q=1', 'https://s3.amazonaws.com.evil.test/faxes-prod/x?q=1', 'https://s3.amazonaws.com/other/x?q=1', 'https://user@s3.amazonaws.com/faxes-prod/x?q=1']) {
    const s = setup(); assert.equal((await handleInboundFax(await signed(fixture({ media_url: url })), s.env, { now, fetcher: s.fetcher })).status, 503); assert.equal(s.downloads(), 0);
  }
  const s = setup(); s.env.FILES.put = async () => { throw Error('failure'); };
  assert.equal((await handleInboundFax(await signed(fixture()), s.env, { now, fetcher: s.fetcher })).status, 503);
  assert.equal(s.rows.size, 0);
  const invalid = setup();
  assert.equal((await handleInboundFax(await signed(fixture()), invalid.env, { now, fetcher: async () => new Response('bad', { headers: { 'content-type': 'application/pdf' } }) })).status, 503);
  assert.equal(invalid.rows.size, 0);
});
test('non-media lifecycle events need no download and can arrive out of order', async () => {
  const s = setup(); const body = fixture(); body.data.event_type = 'fax.media.processing.started';
  assert.equal((await handleInboundFax(await signed(body), s.env, { now, fetcher: s.fetcher })).status, 200);
  assert.equal(s.rows.size, 1); assert.equal(s.downloads(), 0);
});

test('database failure and oversized event never return success', async () => {
  const s = setup(); s.env.DB.prepare = () => { throw Error('db unavailable'); };
  assert.equal((await handleInboundFax(await signed(fixture()), s.env, { now, fetcher: s.fetcher })).status, 503);
  const big = setup(); const body = fixture(); body.padding = 'x'.repeat(65536);
  assert.equal((await handleInboundFax(await signed(body), big.env, { now, fetcher: big.fetcher })).status, 413);
  assert.equal(big.downloads(), 0);
});

test('a transient download failure can be retried before the media URL expires', async () => {
  const s = setup(); let attempts = 0;
  const fetcher = async (...args) => {
    attempts++;
    if (attempts === 1) return new Response('temporarily unavailable', { status: 503 });
    return s.fetcher(...args);
  };
  assert.equal((await handleInboundFax(await signed(fixture()), s.env, { now, fetcher })).status, 503);
  assert.equal(s.rows.size, 0);
  assert.equal(s.pending.size, 1);
  assert.ok(!JSON.stringify([...s.pending.values()]).includes('signature=synthetic'));
  assert.equal(s.objects.size, 0);
  assert.equal((await handleInboundFax(await signed(fixture()), s.env, { now, fetcher })).status, 200);
  assert.equal(attempts, 2);
  assert.equal(s.rows.size, 1);
  assert.equal(s.objects.size, 1);
});

test('a conflicting pending receipt cannot fetch or archive another fax', async () => {
  const s = setup();
  s.pending.set(id, { fax_id: '33333333-3333-4333-8333-333333333333', occurred_at: fixture().data.occurred_at });
  assert.equal((await handleInboundFax(await signed(fixture()), s.env, { now, fetcher: s.fetcher })).status, 503);
  assert.equal(s.downloads(), 0);
  assert.equal(s.rows.size, 0);
});

test('concurrent duplicate deliveries with different media cannot overwrite each other', async () => {
  const s = setup();
  let fetches = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const fetcher = async () => {
    const n = ++fetches;
    if (n === 2) release();
    await barrier;
    return new Response(`%PDF-content-${n}`, { headers: { 'content-type': 'application/pdf' } });
  };
  const [a, b] = await Promise.all([signed(fixture()), signed(fixture())]);
  const results = await Promise.all([handleInboundFax(a, s.env, { now, fetcher }), handleInboundFax(b, s.env, { now, fetcher })]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.equal(s.objects.size, 2);
  assert.equal(s.rows.size, 1);
  const selected = [...s.rows.values()][0][5];
  assert.ok(s.objects.has(selected));
});
