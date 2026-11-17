import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleDraft } from './drafts.mjs';
import { handleMail } from './mail-send.mjs';
import { createWorker } from './index.mjs';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';

const id = 'ed600156-741d-4fcb-a7b2-388d87883151';
const base = `https://example.test/api/mail-drafts/${id}`;
const address = { firstName: 'A', addressLine1: '1 Main', city: 'Boston', provinceOrState: 'MA', postalOrZip: '02110', countryCode: 'US' };
const content = { to: address, from: address, text: 'Hello <world>', color: false, doubleSided: false, mailingClass: 'first_class' };
function db() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0002_mail_drafts.sql', '0004_mail_intents.sql']) sqlite.exec(readFileSync(new URL(`../../backend/core/migrations/${file}`, import.meta.url), 'utf8'));
  return { prepare(sql) { return { bind(...args) { return { async first() { return sqlite.prepare(sql).get(...args); }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } }; } }; } };
}
const request = (path, body, origin = 'https://example.test') => new Request(base + path, body === undefined ? {} : { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function save(database, revision, value = content) {
  return handleDraft(new Request(base, { method: 'PUT', headers: { origin: 'https://example.test', 'content-type': 'application/json' }, body: JSON.stringify({ revision, content: value }) }), database, 'owner', id);
}
async function review(env, actor = 'owner') { return handleMail(request('/review'), env, actor, id, 'review'); }
async function send(env, data, fetcher, actor = 'owner') { return handleMail(request('/send', data), env, actor, id, 'send', fetcher); }

it('requires current actor review and confirmation; sends precisely the reviewed payload once', async () => {
  const database = db(); const env = { DB: database, MAIL_ENABLED: 'true', POSTGRID_API_KEY: 'fake' }; let calls = 0; let sent;
  const fake = async (url, init) => { calls++; sent = JSON.parse(init.body); assert.equal(url, 'https://api.postgrid.com/print-mail/v1/letters'); return Response.json({ object: 'letter', id: 'letter_123' }, { status: 201 }); };
  await save(database, 0);
  assert.equal((await review(env, 'other')).status, 404);
  let r = await (await review(env)).json();
  assert.match(r.payload.html, /&lt;world&gt;/);
  assert.equal((await send(env, { revision: r.revision, reviewHash: r.reviewHash, confirmed: false }, fake)).status, 400);
  assert.equal((await send(env, { revision: r.revision, reviewHash: r.reviewHash, confirmed: true }, fake, 'other')).status, 409);
  await save(database, 1, { ...content, text: 'changed' });
  assert.equal((await send(env, { revision: r.revision, reviewHash: r.reviewHash, confirmed: true }, fake)).status, 409);
  r = await (await review(env)).json();
  const confirmation = { revision: r.revision, reviewHash: r.reviewHash, confirmed: true };
  const responses = await Promise.all([send(env, confirmation, fake), send(env, confirmation, fake)]);
  assert.deepEqual(responses.map(x => x.status).sort(), [202, 409]);
  assert.equal(calls, 1); assert.deepEqual(sent, r.payload);
  assert.equal((await (await handleMail(request('/status'), env, 'owner', id, 'status')).json()).status, 'accepted');
  assert.equal((await handleMail(request('/status'), env, 'other', id, 'status')).status, 404);
});

it('fails closed on disabled, cross-origin, invalid data and uncertain provider outcomes', async () => {
  const database = db(); const env = { DB: database, MAIL_ENABLED: 'true', POSTGRID_API_KEY: 'fake' }; let calls = 0;
  await save(database, 0); const r = await (await review(env)).json(); const body = { revision: r.revision, reviewHash: r.reviewHash, confirmed: true };
  const fake = async () => { calls++; throw Error('timeout'); };
  assert.equal((await send({ ...env, MAIL_ENABLED: 'false' }, body, fake)).status, 503);
  assert.equal((await handleMail(request('/send', body, 'https://evil.test'), env, 'owner', id, 'send', fake)).status, 400);
  assert.equal((await send(env, { ...body, reviewHash: 'a'.repeat(64) }, fake)).status, 409);
  assert.equal((await (await send(env, body, fake)).json()).status, 'unknown');
  assert.equal((await send(env, body, fake)).status, 409); assert.equal(calls, 1);
  await save(database, 1, { ...content, text: 'new' });
  const updated = await (await review(env)).json();
  assert.equal((await send(env, { revision: updated.revision, reviewHash: updated.reviewHash, confirmed: true }, fake)).status, 409);
});

it('leaves a durable submitting claim if the worker stops before recording the result', async () => {
  const database = db(); const env = { DB: database, MAIL_ENABLED: 'true', POSTGRID_API_KEY: 'fake' };
  await save(database, 0); const r = await (await review(env)).json();
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const sending = send(env, { revision: r.revision, reviewHash: r.reviewHash, confirmed: true }, async () => { await waiting; throw Error('lost'); });
  while ((await (await handleMail(request('/status'), env, 'owner', id, 'status')).json()).status !== 'submitting') await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal((await send(env, { revision: r.revision, reviewHash: r.reviewHash, confirmed: true }, async () => { throw Error('must not call'); })).status, 409);
  release(); await sending;
});

it('enforces Access authentication before any mail route reaches storage', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const worker = createWorker(() => createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] }));
  const issuer = 'https://example.cloudflareaccess.com';
  const env = { DB: db(), ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUDIENCE: 'expected' };
  await save(env.DB, 0);
  const token = await new SignJWT({ email: 'owner@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience('expected').setSubject('owner').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  for (const path of ['/review', '/send', '/status']) assert.equal((await worker.fetch(request(path), env)).status, 401);
  const response = await worker.fetch(new Request(base + '/review', { headers: { 'cf-access-jwt-assertion': token } }), env);
  assert.equal(response.status, 200);
  assert.match((await response.json()).payload.html, /Hello/);
});
