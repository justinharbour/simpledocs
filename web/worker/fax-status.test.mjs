import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleFaxStatus } from './fax-status.mjs';

const id = '11111111-1111-4111-8111-111111111111';
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../backend/core/migrations/0003_fax_intents.sql', import.meta.url), 'utf8'));
  db.prepare("INSERT INTO fax_intents VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, 'owner', '+12025550102', 'test.pdf', 'accepted', 'fax-1', 'now', 'now');
  return { prepare(sql) { return { bind(...args) { return {
    async first() { return db.prepare(sql).get(...args); },
    async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
  }; } }; } };
}
const request = new Request(`https://example.test/api/faxes/${id}`);

it('checks provider delivery and isolates the owner', async () => {
  const env = { DB: database(), TELNYX_API_TOKEN: 'test' };
  let calls = 0;
  const provider = async () => { calls++; return Response.json({ data: { id: 'fax-1', status: 'delivered' } }); };
  assert.equal((await handleFaxStatus(request, env, 'other', id, provider)).status, 404);
  assert.equal(calls, 0);
  assert.deepEqual(await (await handleFaxStatus(request, env, 'owner', id, provider)).json(), { id, status: 'delivered' });
  assert.deepEqual(await (await handleFaxStatus(request, env, 'owner', id, provider)).json(), { id, status: 'delivered' });
  assert.equal(calls, 1);
});

it('does not claim delivery on provider errors or mismatched IDs', async () => {
  for (const provider of [async () => { throw Error('offline'); }, async () => Response.json({ data: { id: 'other', status: 'delivered' } })]) {
    const env = { DB: database(), TELNYX_API_TOKEN: 'test' };
    assert.equal((await (await handleFaxStatus(request, env, 'owner', id, provider)).json()).status, 'accepted');
  }
});
