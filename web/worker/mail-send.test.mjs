import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleDraft } from './drafts.mjs';
import { handleMail, listUnresolvedMail, letterPayload } from './mail-send.mjs';
import { createWorker } from './index.mjs';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';

const id = 'ed600156-741d-4fcb-a7b2-388d87883151';
const base = `https://example.test/api/mail-drafts/${id}`;
const address = { firstName: 'A', addressLine1: '1 Main', city: 'Boston', provinceOrState: 'MA', postalOrZip: '02110', countryCode: 'US' };
const content = { to: address, from: address, text: 'Hello <world>', color: false, doubleSided: false, mailingClass: 'first_class' };
function db() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0002_mail_drafts.sql', '0004_mail_intents.sql', '0005_mail_unresolved_actor.sql', '0006_mail_acknowledgement.sql']) sqlite.exec(readFileSync(new URL(`../../backend/core/migrations/${file}`, import.meta.url), 'utf8'));
  return { prepare(sql) { return { bind(...args) { return { async first() { return sqlite.prepare(sql).get(...args); }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } }; } }; } };
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
  assert.equal((await worker.fetch(new Request('https://example.test/api/mail-unresolved'), env)).status, 401);
  const response = await worker.fetch(new Request(base + '/review', { headers: { 'cf-access-jwt-assertion': token } }), env);
  assert.equal(response.status, 200);
  assert.match((await response.json()).payload.html, /Hello/);
});

it('rejects template delimiters and encoded or fragmented attempts before review and send', async () => {
  for (const value of ['{{name}}', '{{{name}}}', '{', '}', '{ {name} }', '&#123;&#123;name&#125;&#125;', '&amp;#123;', '&'])
    assert.throws(() => letterPayload({ ...content, text: value }, id), /Template/);
  const database = db(); const env = { DB: database, MAIL_ENABLED: 'true', POSTGRID_API_KEY: 'fake' };
  await save(database, 0, { ...content, text: '{{name}}' });
  assert.equal((await review(env)).status, 400);
  let calls = 0;
  assert.equal((await send(env, { revision: 1, reviewHash: 'a'.repeat(64), confirmed: true }, async () => { calls++; })).status, 400);
  assert.equal(calls, 0);
});

it('atomically blocks different drafts for an actor while unresolved, isolates actors, and allows accepted orders', async () => {
  const database = db(); const env = { DB: database, MAIL_ENABLED: 'true', POSTGRID_API_KEY: 'fake' };
  const id2 = 'ad600156-741d-4fcb-a7b2-388d87883151';
  const id3 = 'bd600156-741d-4fcb-a7b2-388d87883151';
  const prepare = async (draft, actor) => {
    const u = `https://example.test/api/mail-drafts/${draft}`;
    await handleDraft(new Request(u, { method: 'PUT', headers: { origin: 'https://example.test', 'content-type': 'application/json' }, body: JSON.stringify({ revision: 0, content }) }), database, actor, draft);
    const r = await (await handleMail(new Request(u + '/review'), env, actor, draft, 'review')).json();
    return () => handleMail(new Request(u + '/send', { method: 'POST', headers: { origin: 'https://example.test', 'content-type': 'application/json' }, body: JSON.stringify({ revision: r.revision, reviewHash: r.reviewHash, confirmed: true }) }), env, actor, draft, 'send', fake);
  };
  let calls = 0; let release; const waiting = new Promise(resolve => { release = resolve; });
  const fake = async () => { calls++; await waiting; throw Error('unknown'); };
  const first = await prepare(id, 'owner'); const second = await prepare(id2, 'owner'); const other = await prepare(id3, 'other');
  const pending = first(); const blocked = second(); const otherPending = other();
  assert.equal((await blocked).status, 409);
  const list = actor => listUnresolvedMail(new Request('https://example.test/api/mail-unresolved'), env, actor);
  const ownerRows = (await (await list('owner')).json()).orders;
  assert.deepEqual(ownerRows.map(r => r.draft_id), [id]);
  assert.equal(JSON.stringify(ownerRows).includes('Hello'), false);
  release(); await Promise.all([pending, otherPending]); assert.equal(calls, 2);
  assert.equal((await (await list('other')).json()).orders[0].draft_id, id3);
  assert.equal((await second()).status, 409);
  assert.equal((await (await list('owner')).json()).orders[0].status, 'unknown');
  const acceptedDb = db(); const acceptedEnv = { DB: acceptedDb, MAIL_ENABLED: 'true', POSTGRID_API_KEY: 'fake' };
  for (const draft of [id, id2]) {
    const u = `https://example.test/api/mail-drafts/${draft}`;
    await handleDraft(new Request(u, { method: 'PUT', headers: { origin: 'https://example.test', 'content-type': 'application/json' }, body: JSON.stringify({ revision: 0, content }) }), acceptedDb, 'owner', draft);
    const r = await (await handleMail(new Request(u + '/review'), acceptedEnv, 'owner', draft, 'review')).json();
    const res = await handleMail(new Request(u + '/send', { method: 'POST', headers: { origin: 'https://example.test', 'content-type': 'application/json' }, body: JSON.stringify({ revision: r.revision, reviewHash: r.reviewHash, confirmed: true }) }), acceptedEnv, 'owner', draft, 'send', async () => Response.json({ object: 'letter', id: 'letter_123' }, { status: 201 }));
    assert.equal(res.status, 202);
    const ack = await handleMail(new Request(u + '/acknowledge', { method: 'POST', headers: { origin: 'https://example.test', 'content-type': 'application/json' }, body: JSON.stringify({ acknowledged: true, providerId: 'letter_123' }) }), acceptedEnv, 'owner', draft, 'acknowledge');
    assert.equal(ack.status, 200);
  }
});

it('recovers a lost accepted response and gates another draft until actor acknowledgement', async () => {
  const database = db(); const env = { DB: database, MAIL_ENABLED: 'true', POSTGRID_API_KEY: 'fake' };
  await save(database, 0); const r = await (await review(env)).json();
  const response = await send(env, { revision: r.revision, reviewHash: r.reviewHash, confirmed: true }, async () => Response.json({ object: 'letter', id: 'letter_123' }, { status: 201 }));
  assert.equal(response.status, 202); // Simulate the browser never receiving this response.
  const list = actor => listUnresolvedMail(new Request('https://example.test/api/mail-unresolved'), env, actor);
  assert.equal((await (await list('owner')).json()).orders[0].provider_id, 'letter_123');
  assert.deepEqual((await (await list('other')).json()).orders, []);
  const id2 = 'ad600156-741d-4fcb-a7b2-388d87883151'; const u = `https://example.test/api/mail-drafts/${id2}`;
  await handleDraft(new Request(u, { method: 'PUT', headers: { origin: 'https://example.test', 'content-type': 'application/json' }, body: JSON.stringify({ revision: 0, content }) }), database, 'owner', id2);
  const r2 = await (await handleMail(new Request(u + '/review'), env, 'owner', id2, 'review')).json();
  const submit = () => handleMail(new Request(u + '/send', { method: 'POST', headers: { origin: 'https://example.test', 'content-type': 'application/json' }, body: JSON.stringify({ revision: r2.revision, reviewHash: r2.reviewHash, confirmed: true }) }), env, 'owner', id2, 'send', async () => Response.json({ object: 'letter', id: 'letter_456' }, { status: 201 }));
  assert.equal((await submit()).status, 409);
  const ack = (actor, providerId = 'letter_123', origin = 'https://example.test') => handleMail(request('/acknowledge', { acknowledged: true, providerId }, origin), env, actor, id, 'acknowledge');
  assert.equal((await ack('other')).status, 409);
  assert.equal((await ack('owner', 'letter_wrong')).status, 409);
  assert.equal((await ack('owner', 'letter_123', 'https://evil.test')).status, 400);
  assert.equal((await ack('owner')).status, 200);
  assert.equal((await ack('owner')).status, 200);
  assert.deepEqual((await (await list('owner')).json()).orders, []);
  assert.equal((await submit()).status, 202);
});
