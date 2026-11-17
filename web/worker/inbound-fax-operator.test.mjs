import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { handleFaxOperator } from './inbound-fax-operator.mjs';
import { createWorker } from './index.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const env = { TELNYX_FAX_RECOVERY_ENABLED: 'true', TELNYX_INBOUND_FAX_ENABLED: 'true', INBOUND_FAX_OPERATOR_SUBJECTS: '["operator"]', DB: { prepare() { return { async all() { return { success: true, results: [{ event_id: id }] }; } }; } } };
const request = (method, origin = 'https://example.test') => new Request(`https://example.test/api/inbound-fax-recovery/${id}`, { method, headers: { origin } });

test('only explicitly authorized operators can list and invoke recovery', async () => {
  let calls = 0; const recover = async () => { calls++; return true; };
  assert.equal((await handleFaxOperator(request('POST'), env, 'other', id, recover)).status, 403);
  assert.equal((await handleFaxOperator(request('POST'), env, 'operator', id, recover)).status, 200);
  assert.equal(calls, 1);
  const list = await handleFaxOperator(request('GET'), env, 'operator');
  assert.deepEqual(await list.json(), { pending: [{ event_id: id }] });
  assert.equal(list.headers.get('cache-control'), 'private, no-store');
});
test('fails closed for cross-origin, disabled, invalid and unsuccessful requests', async () => {
  let calls = 0; const recover = async () => { calls++; return false; };
  assert.equal((await handleFaxOperator(request('POST', 'https://evil.test'), env, 'operator', id, recover)).status, 403);
  assert.equal((await handleFaxOperator(request('POST'), { ...env, TELNYX_FAX_RECOVERY_ENABLED: 'false' }, 'operator', id, recover)).status, 503);
  assert.equal((await handleFaxOperator(request('POST'), env, 'operator', 'invalid', recover)).status, 404);
  assert.equal((await handleFaxOperator(request('GET'), env, 'operator', id, recover)).status, 405);
  assert.equal(calls, 0);
  assert.equal((await handleFaxOperator(request('POST'), env, 'operator', id, recover)).status, 503);
  assert.equal(calls, 1);
});
test('worker verifies Access before dispatching operator routes', async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  const issuer = 'https://example.cloudflareaccess.com';
  const worker = createWorker(() => createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] }));
  const token = await new SignJWT({ email: 'operator@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience('test').setSubject('operator').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  const config = { ...env, ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUDIENCE: 'test' };
  const req = assertion => new Request('https://example.test/api/inbound-fax-recovery', { headers: assertion ? { 'cf-access-jwt-assertion': assertion } : {} });
  assert.equal((await worker.fetch(req(), config)).status, 401);
  assert.equal((await worker.fetch(req(token), config)).status, 200);
});
