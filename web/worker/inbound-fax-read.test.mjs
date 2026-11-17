import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { handleInboundFaxRead } from './inbound-fax-read.mjs';
import { createWorker } from './index.mjs';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';

test('verified and explicitly authorized subject can list and retrieve private PDF', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'], r2Buckets: ['FAX_MEDIA'] });
  try {
    const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('FAX_MEDIA');
    const migration = await readFile(new URL('../../backend/core/migrations/0007_inbound_fax_events.sql', import.meta.url), 'utf8');
    await db.prepare(migration.replace(/^--.*$/gm, '').trim()).run();
    const event = '11111111-1111-4111-8111-111111111111', fax = '22222222-2222-4222-8222-222222222222';
    const key = `inbound-fax/${fax}/${event}/${'a'.repeat(64)}.pdf`;
    await bucket.put(key, '%PDF-synthetic');
    await db.prepare('INSERT INTO inbound_fax_events VALUES (?, ?, ?, ?, ?, ?)').bind(event, fax, 'fax.received', 'then', 'now', key).run();
    const keys = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(keys.publicKey);
    const issuer = 'https://example.cloudflareaccess.com';
    const worker = createWorker(() => createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] }));
    const token = async sub => new SignJWT({ email: 'test@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience('test').setSubject(sub).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    const env = { DB: db, FAX_MEDIA: bucket, ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUDIENCE: 'test', INBOUND_FAX_ALLOWED_SUBJECTS: '["owner"]' };
    const request = (path, assertion) => new Request(`https://example.test${path}`, { headers: assertion ? { 'cf-access-jwt-assertion': assertion } : {} });
    const owner = await token('owner'), other = await token('other');
    assert.equal((await worker.fetch(request('/api/inbound-faxes'), env)).status, 401);
    assert.equal((await worker.fetch(request('/api/inbound-faxes', other), env)).status, 403);
    assert.equal((await worker.fetch(request(`/api/inbound-faxes/${event}/pdf`, other), env)).status, 403);
    const list = await worker.fetch(request('/api/inbound-faxes', owner), env);
    assert.deepEqual(await list.json(), { records: [{ id: event, faxId: fax, occurredAt: 'then', receivedAt: 'now' }] });
    const pdf = await worker.fetch(request(`/api/inbound-faxes/${event}/pdf`, owner), env);
    assert.equal(pdf.status, 200); assert.equal(await pdf.text(), '%PDF-synthetic');
    assert.equal(pdf.headers.get('content-disposition'), 'attachment; filename="fax.pdf"');
    assert.equal(pdf.headers.get('cache-control'), 'private, no-store');
    assert.equal((await worker.fetch(request('/api/inbound-faxes/invalid/pdf', owner), env)).status, 404);
    await bucket.delete(key);
    assert.equal((await worker.fetch(request(`/api/inbound-faxes/${event}/pdf`, owner), env)).status, 503);
    assert.equal((await handleInboundFaxRead(request('/api/inbound-faxes'), { ...env, INBOUND_FAX_ALLOWED_SUBJECTS: 'broken' }, 'owner')).status, 403);
  } finally { await mf.dispose(); }
});
