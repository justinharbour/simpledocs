import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, samplePdf, sendRequest } from './test-env.mjs';
import { createEmailDelivery, portal, revokeEmailDelivery } from './email-portal.mjs';
import { newPortalToken } from './portal-crypto.mjs';
import { approveEmail, createTransmission, getTransmission, listRecipients, reviewEmail } from './transmissions.mjs';

const origin = 'https://example.test';
const legacy = 'https://legacy.example.test';
const profile = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function req(route, body, cookie, host = origin) {
  const headers = { origin: host, 'cf-connecting-ip': '192.0.2.1' };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(host + route, { method: body === undefined ? 'GET' : 'POST', headers, body: JSON.stringify(body) });
}

async function setup(pinChannel = 'none', send) {
  const messages = [];
  const result = makeEnv({ PORTAL_ORIGIN: origin, PORTAL_LEGACY_OWNER_ORIGIN: legacy, PORTAL_KEY: newPortalToken(), PORTAL_SENDER: 'sender@example.test', PORTAL_EMAIL: { send: send ?? (async message => messages.push(message)) }, TELNYX_VERIFY_PROFILE_ID: profile });
  const pdf = await samplePdf(1);
  const files = [new File([pdf], 'first.pdf'), new File([pdf], 'second.pdf')];
  const request = await sendRequest({ email: { email: 'recipient@example.test', pinChannel, phone: '+12125550100' } }, files, `${legacy}/api/transmissions`, 'numberedEmailDocuments');
  const response = await createTransmission(request, result.env, 'owner');
  assert.equal(response.status, 202);
  const tx = await response.json();
  assert.deepEqual(tx.documents.map(d => d.name), ['first.pdf', 'second.pdf']);
  const text = messages[0]?.text;
  const invitation = text && { token: text.match(/\/portal#([\w-]+)/)[1], accessCode: text.match(/page: ([0-9A-F]{10})/)[1], verifier: newPortalToken() };
  return { ...result, tx, invitation };
}

const cookieFrom = response => response.headers.get('set-cookie')?.split(';')[0];

test('email recipient history includes only actor-scoped submitted portal deliveries, deduplicated without verification data', async () => {
  const { env, db } = await setup('sms');
  const history = async actor => (await listRecipients(req('/api/recipients'), env, actor)).json();
  assert.deepEqual((await history('owner')).email, ['recipient@example.test']);
  assert.deepEqual((await history('other')).email, []);
  const clone = db.prepare(`INSERT INTO portal_deliveries (id, transmission_id, actor_id, recipient, token_hash, expires_at, object_key, iv, key_id, pin_channel, pin_phone, pin_state, send_status, created_at)
    SELECT ?, transmission_id, ?, ?, ?, expires_at, object_key, iv, key_id, pin_channel, pin_phone, pin_state, ?, ? FROM portal_deliveries WHERE id = ?`);
  const id = db.prepare('SELECT id FROM portal_deliveries').get().id;
  clone.run('duplicate', 'owner', 'RECIPIENT@example.test', 'hash1', 'unknown', Date.now() + 1, id);
  clone.run('unsubmitted', 'owner', 'no-send@example.test', 'hash2', 'failed', Date.now() + 2, id);
  clone.run('other', 'other', 'private@example.test', 'hash3', 'accepted', Date.now() + 3, id);
  const prepared = await createTransmission(await sendRequest({ email: { email: 'pending@example.test', pinChannel: 'none' } }, await samplePdf(1)), env, 'owner');
  assert.equal(prepared.status, 202);
  const result = await history('owner');
  assert.deepEqual(result.email, ['RECIPIENT@example.test']);
  assert.equal(JSON.stringify(result).includes('+12125550100'), false);
  assert.deepEqual((await history('other')).email, ['private@example.test']);
});

test('prepared email cannot send before explicit review and delivers the reviewed PDF', async () => {
  const messages = [];
  const { env, objects } = makeEnv({ PORTAL_ORIGIN: origin, PORTAL_KEY: newPortalToken(), PORTAL_SENDER: 'sender@example.test', PORTAL_EMAIL: { send: async message => messages.push(message) } });
  const spec = { email: { email: 'recipient@example.test', pinChannel: 'none' } };
  const response = await createTransmission(await sendRequest(spec, await samplePdf(2)), env, 'owner');
  const tx = await response.json();
  assert.equal(tx.deliveries[0].status, 'awaiting_approval');
  assert.equal(messages.length, 0);
  assert.equal((await createEmailDelivery(req('/x', spec.email), env, 'owner', tx.id)).status, 409);
  assert.equal((await reviewEmail(req('/x'), env, 'other', tx.id)).status, 404);
  const review = await (await reviewEmail(req('/x'), env, 'owner', tx.id)).json();
  assert.equal((await approveEmail(req('/x', { confirmed: true, reviewHash: 'f'.repeat(64) }), env, 'owner', tx.id)).status, 409);
  assert.equal(messages.length, 0);
  const sourceKey = `outbound/${tx.id}/document.pdf`, original = objects.get(sourceKey);
  objects.set(sourceKey, new Uint8Array([1]));
  assert.equal((await approveEmail(req('/x', { confirmed: true, reviewHash: review.reviewHash }), env, 'owner', tx.id)).status, 404);
  objects.set(sourceKey, original);
  assert.equal((await approveEmail(req('/x', { confirmed: true, reviewHash: review.reviewHash }), env, 'owner', tx.id)).status, 202);
  assert.equal((await approveEmail(req('/x', { confirmed: true, reviewHash: review.reviewHash }), env, 'owner', tx.id)).status, 409);
  assert.equal(messages.length, 1);
  const text = messages[0].text;
  const invitation = { token: text.match(/\/portal#([\w-]+)/)[1], accessCode: text.match(/page: ([0-9A-F]{10})/)[1], verifier: newPortalToken() };
  const cookie = cookieFrom(await portal(req('/portal/exchange', invitation), env));
  assert.deepEqual(new Uint8Array(await (await portal(req('/portal/document', undefined, cookie), env)).arrayBuffer()), original);
});

test('legacy owner sends an ordered encrypted copy; canonical recipient redeems once and owner can revoke', async () => {
  const { env, db, objects, tx, invitation } = await setup();
  assert.equal(tx.deliveries[0].status, 'accepted');
  const page = await portal(req('/portal'), env);
  const nonce = page.headers.get('content-security-policy').match(/'nonce-([\w-]+)'/)[1];
  assert.match(await page.text(), new RegExp(`<script nonce="${nonce}">`));
  assert.equal((await portal(req('/portal/exchange', { token: invitation.token }), env)).status, 400);
  assert.equal((await portal(req('/portal/exchange', invitation, null, legacy), env)).status, 404);
  assert.equal(db.prepare('SELECT consumed_at FROM portal_deliveries').get().consumed_at, null);
  const exchange = () => portal(req('/portal/exchange', invitation), env);
  const first = await exchange();
  const cookie = cookieFrom(first);
  assert.match(first.headers.get('set-cookie'), /^__Host-sdportal=[\w-]+; Path=\/; Secure; HttpOnly; SameSite=Strict/);
  assert.equal(cookieFrom(await exchange()), cookie);
  assert.equal((await portal(req('/portal/exchange', { ...invitation, verifier: newPortalToken() }), env)).status, 404);
  assert.equal(db.prepare('SELECT count(*) AS n FROM portal_sessions').get().n, 1);
  const source = objects.get(`outbound/${tx.id}/document.pdf`);
  assert.notDeepEqual(objects.get(db.prepare('SELECT object_key FROM portal_deliveries').get().object_key), source);
  assert.deepEqual(new Uint8Array(await (await portal(req('/portal/document', undefined, cookie), env)).arrayBuffer()), source);
  const id = tx.deliveries[0].id;
  assert.equal((await revokeEmailDelivery(req('/revoke', {}, null, legacy), env, 'other', tx.id, id)).status, 404);
  assert.equal((await revokeEmailDelivery(req('/revoke', {}, null, legacy), env, 'owner', tx.id, id)).status, 200);
  assert.equal((await portal(req('/portal/document', undefined, cookie), env)).status, 404);
});

test('ambiguity persists in Records without retrying a provider submission', async () => {
  let submissions = 0;
  const { env, tx } = await setup('none', async () => { submissions++; throw Error('provider timeout'); });
  assert.equal(tx.deliveries[0].status, 'unknown');
  const detail = await (await getTransmission(env, 'owner', tx.id)).json();
  assert.equal(detail.deliveries[0].status, 'unknown');
  assert.equal(detail.deliveries[0].canRevoke, true);
  assert.equal(submissions, 1);
});

test('Verify requires consent, full-number match, and acceptance for the same verification ID', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /^https:\/\/api\.telnyx\.com\/v2\/verifications\//);
    calls.push({ url, body: JSON.parse(options.body) });
    return Response.json(url.endsWith('/actions/verify') ? { data: { response_code: 'accepted' } } : { data: { id: profile } });
  });
  const { env, invitation } = await setup('voice');
  const cookie = cookieFrom(await portal(req('/portal/exchange', invitation), env));
  const act = (route, body) => portal(req(`/portal/${route}`, body, cookie), env);
  assert.equal((await act('document')).status, 403);
  assert.equal((await act('pin/start', { consent: false, phone: '+12125550100' })).status, 400);
  assert.equal((await act('pin/start', { consent: true, phone: '+12125550101' })).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await act('pin/start', { consent: true, phone: '+12125550100' })).status, 200);
  assert.equal((await act('pin/start', { consent: true, phone: '+12125550100' })).status, 400);
  assert.equal((await act('pin/check', { code: '123456' })).status, 200);
  assert.deepEqual(calls, [
    { url: 'https://api.telnyx.com/v2/verifications/call', body: { phone_number: '+12125550100', verify_profile_id: profile, timeout_secs: 300 } },
    { url: `https://api.telnyx.com/v2/verifications/${profile}/actions/verify`, body: { code: '123456' } },
  ]);
  assert.equal((await act('document')).status, 200);
});
