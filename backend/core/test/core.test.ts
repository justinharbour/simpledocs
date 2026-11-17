import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channel, delivery, job } from '../src/validation.ts';
import { featureAvailable, features } from '../src/flags.ts';
import { AccessDenied, requireAccess, requireMutationProtection, type Authorizer } from '../src/access.ts';
import { readArtifact } from '../src/objects.ts';
import { reserveIntent } from '../src/idempotency.ts';
const time = '2026-11-16T00:00:00.000Z';
test('validates record fields', () => {
  assert.equal(job({ id:'j', createdBy:'a', createdAt:time }).id, 'j');
  assert.equal(delivery({ id:'d', jobId:'j', channel:'fax', revision:1, state:'draft', updatedAt:time }).channel, 'fax');
  assert.throws(() => channel('voice'));
  assert.throws(() => job({ id:'j', createdBy:'a', createdAt:'2026-02-30T00:00:00.000Z' }));
  assert.throws(() => delivery({ id:'d', jobId:'j', channel:'fax', revision:0, state:'draft', updatedAt:time }));
});
test('features require all signals', () => {
  for (const name of features) {
    assert.equal(featureAvailable(name, undefined, true, true), false);
    assert.equal(featureAvailable(name, { [name]: true }, false, true), false);
    assert.equal(featureAvailable(name, { [name]: true }, true, false), false);
    assert.equal(featureAvailable(name, { [name]: true }, true, true), true);
  }
  assert.equal(featureAvailable('other', {}, true, true), false);
});
test('access and mutations fail closed', async () => {
  const request = new Request('https://example.test', { headers: { 'Cf-Access-Jwt-Assertion':'x' } });
  await assert.rejects(requireAccess(request, 'read', 'x'));
  await assert.rejects(requireAccess(request, 'read', 'x', { verify: async () => { throw Error(); } }, { allow: async () => true }));
  await assert.rejects(requireAccess(request, 'read', 'x', { verify: async () => ({ id:'a' }) }, { allow: async () => false }));
  assert.equal((await requireAccess(request, 'read', 'x', { verify: async () => ({ id:'a' }) }, { allow: async () => true })).id, 'a');
  assert.throws(() => requireMutationProtection(request, ['https://example.test'], true));
  const withOrigin = new Request('https://example.test', { headers: { Origin:'https://example.test' } });
  assert.throws(() => requireMutationProtection(withOrigin, ['https://example.test'], false));
  requireMutationProtection(withOrigin, ['https://example.test'], true);
});
test('authorization accepts only literal true and normalizes adapter failures', async () => {
  const request = new Request('https://example.test', { headers: { 'Cf-Access-Jwt-Assertion':'x' } });
  const verifier = { verify: async () => ({ id:'a' }) };
  for (const value of [false, 'false', 'true', { allowed:false }, 1, null, undefined]) {
    // Exercise malformed JavaScript adapters despite the TypeScript interface.
    const authorizer = { allow: async () => value } as unknown as Authorizer;
    await assert.rejects(requireAccess(request, 'read', 'x', verifier, authorizer), AccessDenied);
  }
  await assert.rejects(requireAccess(request, 'read', 'x', verifier, { allow: async () => { throw new Error('private adapter error'); } }), AccessDenied);
  assert.equal((await requireAccess(request, 'read', 'x', verifier, { allow: async () => true })).id, 'a');
});
test('private reads authorize before lookup and force download', async () => {
  let lookups = 0;
  const deps = { artifacts: { findInternalRef: async () => { lookups++; return 'internal'; } }, objects: { get: async () => ({ body: new Response('data').body!, contentType:'text/html' }) } };
  const req = new Request('https://example.test', { headers: { 'Cf-Access-Jwt-Assertion':'x' } });
  await assert.rejects(readArtifact(req, 'artifact', deps));
  assert.equal(lookups, 0);
  const response = await readArtifact(req, 'artifact', { ...deps, verifier: { verify: async () => ({ id:'a' }) }, authorizer: { allow: async () => true } });
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(await response.text(), 'data');
});
test('idempotency replay and conflict', async () => {
  const records = new Map();
  const db = { prepare(sql: string) { return { bind(...v: any[]) { return { async first() {
    const key = v.slice(0, 4).join(':');
    if (sql.startsWith('INSERT')) {
      if (records.has(key) || [...records.values()].some(r => r.delivery === v[2] && r.revision === v[5])) return null;
      records.set(key, { delivery:v[2], request_hash:v[4], revision:v[5], result_json:null }); return { request_hash:v[4] };
    }
    return records.get(key) ?? null;
  } }; } }; } };
  const i = { actorId:'a', operation:'submit', deliveryId:'d', keyHash:'a'.repeat(64), requestHash:'b'.repeat(64), revision:1, createdAt:time };
  assert.equal((await reserveIntent(db as any, i)).kind, 'reserved');
  assert.deepEqual(await reserveIntent(db as any, i), { kind:'replay', result:null });
  assert.equal((await reserveIntent(db as any, { ...i, requestHash:'c'.repeat(64) })).kind, 'conflict');
  assert.equal((await reserveIntent(db as any, { ...i, keyHash:'d'.repeat(64) })).kind, 'conflict');
});
