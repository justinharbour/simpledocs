import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleDraft } from './drafts.mjs';

const id = 'ed600156-741d-4fcb-a7b2-388d87883151';
const url = `https://example.test/api/mail-drafts/${id}`;
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../backend/core/migrations/0002_mail_drafts.sql', import.meta.url), 'utf8'));
  return { prepare(sql) { return { bind(...args) { return {
    async first() { return db.prepare(sql).get(...args); },
    async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; },
  }; } }; } };
}
function put(revision, content, origin = 'https://example.test') {
  const body = JSON.stringify({ revision, content });
  return new Request(url, { method: 'PUT', headers: { origin, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, body });
}
it('persists drafts per actor and rejects stale revisions and cross-origin writes', async () => {
  const db = database();
  assert.equal((await handleDraft(put(0, { text: 'hello' }), db, 'owner', id)).status, 200);
  assert.equal((await handleDraft(new Request(url), db, 'other', id)).status, 404);
  assert.equal((await handleDraft(put(1, { text: 'bad' }), db, 'other', id)).status, 409);
  assert.equal((await handleDraft(put(1, { text: 'bad' }, 'https://evil.test'), db, 'owner', id)).status, 403);
  assert.equal((await handleDraft(put(1, { text: 'updated' }), db, 'owner', id)).status, 200);
  assert.equal((await handleDraft(put(1, { text: 'stale' }), db, 'owner', id)).status, 409);
  const response = await handleDraft(new Request(url), db, 'owner', id);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await response.json()).content, { text: 'updated' });
  assert.equal((await handleDraft(new Request(url), null, 'owner', id)).status, 503);
});
