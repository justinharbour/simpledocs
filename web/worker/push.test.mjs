import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { createWorker } from './index.mjs';
import { handlePushDevices, notifyPush, providerToken, pushLater, resetPushCache } from './push.mjs';

const hex = char => char.repeat(64);
const bytes = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));

async function makeP8() {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey };
}

async function database() {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  const sql = await readFile(new URL('../../backend/core/migrations/0030_push_devices.sql', import.meta.url), 'utf8');
  for (const statement of sql.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  return { mf, db };
}
const insert = (db, token, platform, environment) => db.prepare('INSERT INTO push_devices (token, platform, environment) VALUES (?, ?, ?)').bind(token, platform, environment).run();
const count = async db => (await db.prepare('SELECT COUNT(*) AS n FROM push_devices').first()).n;

describe('APNs sender', () => {
  beforeEach(() => resetPushCache());

  it('signs an ES256 provider token that verifies, and caches it for under an hour', async () => {
    const { pem, publicKey } = await makeP8();
    const creds = { key: pem, keyId: 'ABC123DEFG', teamId: 'TEAM123456' };
    const now = Date.UTC(2026, 10, 16);
    const jwt = await providerToken(creds, now);
    const [header, claims, signature] = jwt.split('.');
    assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes(header))), { alg: 'ES256', kid: 'ABC123DEFG' });
    assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes(claims))), { iss: 'TEAM123456', iat: now / 1000 });
    assert.equal(bytes(signature).length, 64);
    assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, bytes(signature), new TextEncoder().encode(`${header}.${claims}`)), true);
    assert.equal(await providerToken(creds, now + 49 * 60 * 1000), jwt);
    assert.notEqual(await providerToken(creds, now + 51 * 60 * 1000), jwt);
  });

  it('chooses the endpoint by environment and sends the required headers and payload', async () => {
    const { mf, db } = await database();
    try {
      const { pem } = await makeP8();
      await insert(db, hex('a'), 'ios', 'sandbox');
      await insert(db, hex('b'), 'macos', 'production');
      const calls = [];
      const fetcher = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 200 }); };
      const env = { DB: db, APNS_KEY_P8: pem, APNS_KEY_ID: 'KEYID', APNS_TEAM_ID: 'TEAMID' };
      assert.equal(await notifyPush(env, { kind: 'voicemail', id: 'rec-1' }, { fetcher }), 'sent');
      const urls = calls.map(c => c.url).sort();
      assert.deepEqual(urls, [`https://api.push.apple.com/3/device/${hex('b')}`, `https://api.sandbox.push.apple.com/3/device/${hex('a')}`]);
      const sandbox = calls.find(c => c.url.includes('sandbox'));
      assert.equal(sandbox.init.headers['apns-topic'], 'dev.justinharbour.simpledocs.ios');
      assert.equal(calls.find(c => !c.url.includes('sandbox')).init.headers['apns-topic'], 'dev.justinharbour.simpledocs.mac.connected');
      assert.equal(sandbox.init.headers['apns-push-type'], 'alert');
      assert.equal(sandbox.init.headers['apns-priority'], '10');
      assert.match(sandbox.init.headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      const payload = JSON.parse(sandbox.init.body);
      assert.deepEqual(payload, { aps: { alert: { title: 'New voicemail', body: 'A voicemail was saved.' }, sound: 'default', 'thread-id': 'voicemail' }, kind: 'voicemail', id: 'rec-1' });
      const overridden = await notifyPush({ ...env, APNS_TOPIC: 'custom.topic' }, { kind: 'fax', id: 'x' }, { fetcher: async (_u, init) => { assert.ok(['custom.topic', 'dev.justinharbour.simpledocs.mac.connected'].includes(init.headers['apns-topic'])); return new Response(null); } });
      assert.equal(overridden, 'sent');
    } finally { await mf.dispose(); }
  });

  it('removes a device on 410 or BadDeviceToken and keeps it on other failures', async () => {
    const { mf, db } = await database();
    try {
      const { pem } = await makeP8();
      const env = { DB: db, APNS_KEY_P8: pem, APNS_KEY_ID: 'KEYID', APNS_TEAM_ID: 'TEAMID' };
      await insert(db, hex('1'), 'ios', 'production');
      assert.equal(await notifyPush(env, { kind: 'fax', id: 'a' }, { fetcher: async () => Response.json({ reason: 'Unregistered' }, { status: 410 }) }), 'failed');
      assert.equal(await count(db), 0);
      await insert(db, hex('2'), 'ios', 'production');
      await notifyPush(env, { kind: 'fax', id: 'a' }, { fetcher: async () => Response.json({ reason: 'BadDeviceToken' }, { status: 400 }) });
      assert.equal(await count(db), 0);
      await insert(db, hex('3'), 'ios', 'production');
      assert.equal(await notifyPush(env, { kind: 'fax', id: 'a' }, { fetcher: async () => Response.json({ reason: 'InternalServerError' }, { status: 500 }) }), 'failed');
      assert.equal(await count(db), 1);
      assert.equal(await notifyPush(env, { kind: 'fax', id: 'a' }, { fetcher: async () => { throw new Error('network'); } }), 'failed');
    } finally { await mf.dispose(); }
  });

  it('is a no-op without credentials and never touches the network or storage', async () => {
    let touched = false;
    const db = { prepare() { touched = true; throw new Error('unexpected'); } };
    const fetcher = async () => { touched = true; throw new Error('unexpected'); };
    for (const env of [{ DB: db }, { DB: db, APNS_KEY_P8: 'k', APNS_KEY_ID: 'i' }, { DB: db, APNS_KEY_P8: '', APNS_KEY_ID: 'i', APNS_TEAM_ID: 't' }]) {
      assert.equal(await notifyPush(env, { kind: 'fax', id: 'a' }, { fetcher }), 'skipped');
    }
    assert.equal(touched, false);
  });

  it('never throws, even with a malformed key or failing storage, and pushLater hands the promise to waitUntil', async () => {
    const db = { prepare: () => ({ all: async () => ({ results: [{ token: hex('c'), platform: 'ios', environment: 'sandbox' }] }) }) };
    const env = { DB: db, APNS_KEY_P8: 'not a key', APNS_KEY_ID: 'i', APNS_TEAM_ID: 't' };
    assert.equal(await notifyPush(env, { kind: 'fax', id: 'a' }, { fetcher: async () => { throw new Error(); } }), 'failed');
    assert.equal(await notifyPush({ ...env, DB: { prepare() { throw new Error('db'); } } }, { kind: 'fax' }), 'failed');
    let waited;
    const promise = pushLater({ ...env, waitUntil: p => { waited = p; } }, { kind: 'fax', id: 'a' });
    assert.equal(waited, promise);
    assert.equal(await promise, 'failed');
  });
});

describe('push device routes', () => {
  const issuer = 'https://example.cloudflareaccess.com';
  const device = (extra = {}) => ({ token: hex('a'), platform: 'ios', environment: 'sandbox', ...extra });
  const post = body => new Request('https://example.test/api/push/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('requires a verified Access assertion before any storage access', async () => {
    let touched = false;
    const env = { ACCESS_AUDIENCE: 'expected', ACCESS_TEAM_DOMAIN: issuer, ASSETS: { fetch: async () => new Response('asset') }, DB: { prepare() { touched = true; throw new Error('unexpected'); } } };
    const { publicKey } = await generateKeyPair('RS256', { extractable: true });
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }] });
    const worker = createWorker(() => keys);
    assert.equal((await worker.fetch(post(device()), env, {})).status, 401);
    assert.equal((await worker.fetch(new Request(`https://example.test/api/push/devices/${hex('a')}`, { method: 'DELETE', headers: { 'cf-access-jwt-assertion': 'forged' } }), env, {})).status, 401);
    assert.equal(touched, false);
  });

  it('routes a signed-in owner to the handler', async () => {
    const { mf, db } = await database();
    try {
      const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
      const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }] });
      const jwt = await new SignJWT({ email: 'o@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience('expected').setSubject('owner').setIssuedAt().setExpirationTime('5m').sign(privateKey);
      const env = { ACCESS_AUDIENCE: 'expected', ACCESS_TEAM_DOMAIN: issuer, DB: db };
      const request = (path, init) => new Request(`https://example.test${path}`, { ...init, headers: { ...init.headers, 'cf-access-jwt-assertion': jwt } });
      const worker = createWorker(() => keys);
      assert.equal((await worker.fetch(request('/api/push/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(device()) }), env, {})).status, 200);
      assert.equal(await count(db), 1);
      assert.equal((await worker.fetch(request(`/api/push/devices/${hex('a')}`, { method: 'DELETE', headers: {} }), env, {})).status, 200);
      assert.equal(await count(db), 0);
    } finally { await mf.dispose(); }
  });

  it('validates input, upserts, deletes, and restricts to the configured owner', async () => {
    const { mf, db } = await database();
    try {
      const env = { DB: db };
      for (const bad of [device({ token: 'abc' }), device({ token: 'g'.repeat(64) }), device({ token: 'a'.repeat(201) }), device({ platform: 'android' }), device({ environment: 'dev' }), null, { token: 5 }]) {
        assert.equal((await handlePushDevices(post(bad), env, 'owner')).status, 400);
      }
      assert.equal((await handlePushDevices(new Request('https://example.test/api/push/devices', { method: 'POST', body: '{}' }), env, 'owner')).status, 400);
      assert.equal((await handlePushDevices(post(device({ token: hex('A') })), env, 'owner')).status, 200);
      assert.equal((await handlePushDevices(post(device({ environment: 'production', platform: 'macos' })), env, 'owner')).status, 200);
      const row = await db.prepare('SELECT token, platform, environment FROM push_devices').first();
      assert.deepEqual(row, { token: hex('a'), platform: 'macos', environment: 'production' });
      assert.equal(await count(db), 1);
      assert.equal((await handlePushDevices(new Request('https://example.test/api/push/devices', { method: 'GET' }), env, 'owner')).status, 405);
      assert.equal((await handlePushDevices(new Request('https://example.test/x', { method: 'DELETE' }), env, 'owner', 'nothex')).status, 400);
      assert.equal((await handlePushDevices(new Request('https://example.test/x', { method: 'DELETE' }), { ...env, VOICE_OWNER_SUBJECT: 'someone' }, 'owner', hex('a'))).status, 404);
      assert.equal(await count(db), 1);
      assert.equal((await handlePushDevices(new Request('https://example.test/x', { method: 'DELETE' }), env, 'owner', hex('a'))).status, 200);
      assert.equal(await count(db), 0);
      assert.equal((await handlePushDevices(post(device()), {}, 'owner')).status, 503);
    } finally { await mf.dispose(); }
  });
});
