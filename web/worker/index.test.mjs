import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import worker, { verifyAccess } from './index.mjs';

const request = (token, path = '/', options = {}) => new Request(`https://example.test${path}`, { ...options, headers: token ? { 'cf-access-jwt-assertion': token } : {} });
const issuer = 'https://example.cloudflareaccess.com';
const env = { ACCESS_AUDIENCE: 'expected', ACCESS_TEAM_DOMAIN: issuer, ASSETS: { fetch: async () => new Response('asset') } };

describe('owner Worker Access boundary', () => {
  it('denies missing configuration, identity and forged tokens', async () => {
    assert.equal((await worker.fetch(request(), env)).status, 401);
    assert.equal((await worker.fetch(request('fake'), { ...env, ACCESS_TEAM_DOMAIN: 'https://evil.test' })).status, 401);
    assert.equal((await worker.fetch(request('fake'), { ...env, ACCESS_AUDIENCE: '' })).status, 401);
    assert.equal((await worker.fetch(request('fake'), env)).status, 401);
  });
  it('rejects unauthenticated draft reads and writes before touching storage', async () => {
    let touched = false;
    const privateEnv = { ...env, DB: { prepare() { touched = true; throw new Error('unexpected database access'); } } };
    const path = '/api/mail-drafts/ed600156-741d-4fcb-a7b2-388d87883151';
    for (const method of ['GET', 'PUT']) {
      const response = await worker.fetch(request(undefined, path, { method }), privateEnv);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(touched, false);
  });
  it('verifies signed identity, audience, issuer and expiry', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(publicKey);
    const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] });
    const sign = (audience, expiration) => new SignJWT({ email: 'owner@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience(audience).setSubject('owner').setIssuedAt().setExpirationTime(expiration).sign(privateKey);
    await verifyAccess(await sign('expected', '5m'), issuer, 'expected', keys);
    await assert.rejects(verifyAccess(await sign('other', '5m'), issuer, 'expected', keys));
    await assert.rejects(verifyAccess(await sign('expected', '-1m'), issuer, 'expected', keys));
    await assert.rejects(verifyAccess(await sign('expected', '5m'), 'https://other.cloudflareaccess.com', 'expected', keys));
  });
});
