import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { handleDraft } from './drafts.mjs';
import { handleMail, listUnresolvedMail } from './mail-send.mjs';

it('persists and isolates drafts through a local D1 binding', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    const migration = await readFile(new URL('../../backend/core/migrations/0002_mail_drafts.sql', import.meta.url), 'utf8');
    for (const statement of migration.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
    const id = 'ed600156-741d-4fcb-a7b2-388d87883151';
    const url = `https://example.test/api/mail-drafts/${id}`;
    const write = (revision, text) => new Request(url, { method: 'PUT', headers: { origin: 'https://example.test', 'content-type': 'application/json' }, body: JSON.stringify({ revision, content: { text } }) });
    assert.equal((await handleDraft(write(0, 'hello'), db, 'owner', id)).status, 200);
    assert.equal((await handleDraft(write(1, 'other'), db, 'other', id)).status, 409);
    assert.equal((await handleDraft(write(1, 'updated'), db, 'owner', id)).status, 200);
    assert.equal((await handleDraft(write(1, 'stale'), db, 'owner', id)).status, 409);
    assert.equal((await handleDraft(new Request(url), db, 'other', id)).status, 404);
    assert.deepEqual((await (await handleDraft(new Request(url), db, 'owner', id)).json()).content, { text: 'updated' });
  } finally {
    await mf.dispose();
  }
});

it('serializes separate mail draft claims using a local D1 binding', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    for (const name of ['0002_mail_drafts.sql', '0004_mail_intents.sql', '0005_mail_unresolved_actor.sql', '0006_mail_acknowledgement.sql']) {
      const sql = await readFile(new URL(`../../backend/core/migrations/${name}`, import.meta.url), 'utf8');
      for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
    }
    const ids = ['ed600156-741d-4fcb-a7b2-388d87883151', 'ad600156-741d-4fcb-a7b2-388d87883151'];
    const addr = { firstName: 'Test', addressLine1: '1 Example', city: 'Test', provinceOrState: 'MA', postalOrZip: '00000', countryCode: 'US' };
    const content = { to: addr, from: addr, text: 'Test', color: false, doubleSided: false, mailingClass: 'first_class' };
    const env = { DB: db, MAIL_ENABLED: 'true', POSTGRID_API_KEY: 'fake' };
    const requests = [];
    for (const id of ids) {
      const url = `https://example.test/api/mail-drafts/${id}`;
      await handleDraft(new Request(url, { method: 'PUT', headers: { origin: 'https://example.test', 'content-type': 'application/json' }, body: JSON.stringify({ revision: 0, content }) }), db, 'owner', id);
      const review = await (await handleMail(new Request(url + '/review'), env, 'owner', id, 'review')).json();
      requests.push({ id, request: new Request(url + '/send', { method: 'POST', headers: { origin: 'https://example.test', 'content-type': 'application/json' }, body: JSON.stringify({ revision: review.revision, reviewHash: review.reviewHash, confirmed: true }) }) });
    }
    let calls = 0; let release; const waiting = new Promise(resolve => { release = resolve; });
    const fake = async () => { calls++; await waiting; throw Error('unknown'); };
    const pending = requests.map(({ id, request }) => handleMail(request, env, 'owner', id, 'send', fake));
    const blocked = await Promise.race(pending);
    assert.equal(blocked.status, 409);
    const rows = (await (await listUnresolvedMail(new Request('https://example.test/api/mail-unresolved'), env, 'owner')).json()).orders;
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'submitting');
    release(); await Promise.all(pending); assert.equal(calls, 1);
  } finally { await mf.dispose(); }
});
