import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { createWorker } from './index.mjs';

test('unresolved discovery requires verified Access and isolates actors', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    const sql = await readFile(new URL('../../backend/core/migrations/0003_fax_intents.sql', import.meta.url), 'utf8');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
    const id = '11111111-1111-4111-8111-111111111111';
    await db.prepare('INSERT INTO fax_intents VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, 'owner', '+12025550102', 'test.pdf', 'unknown', null, 'now', 'now').run();
    const keys = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(keys.publicKey), issuer = 'https://example.cloudflareaccess.com';
    const worker = createWorker(() => createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] }));
    const token = sub => new SignJWT({ email: 'test@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience('test').setSubject(sub).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    const env = { DB: db, ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUDIENCE: 'test' };
    const request = assertion => new Request('https://example.test/api/faxes/unresolved', { headers: assertion ? { 'cf-access-jwt-assertion': assertion } : {} });
    assert.equal((await worker.fetch(request(), env)).status, 401);
    assert.deepEqual(await (await worker.fetch(request(await token('other')), env)).json(), { intents: [] });
    assert.deepEqual(await (await worker.fetch(request(await token('owner')), env)).json(), { intents: [{ id, status: 'unknown', created_at: 'now' }] });
    assert.equal((await worker.fetch(request(await token('owner')), { ...env, DB: undefined })).status, 503);
  } finally { await mf.dispose(); }
});
