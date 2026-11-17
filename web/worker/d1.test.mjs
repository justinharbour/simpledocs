import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { handleDraft } from './drafts.mjs';

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
