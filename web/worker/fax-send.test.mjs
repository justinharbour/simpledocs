import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleFaxSend } from './fax-send.mjs';
import { handleFaxStatus } from './fax-status.mjs';

const id = '11111111-1111-4111-8111-111111111111';
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../backend/core/migrations/0003_fax_intents.sql', import.meta.url), 'utf8'));
  return { prepare(sql) { return { bind(...args) { return {
    async first() { return db.prepare(sql).get(...args); },
    async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
  }; } }; } };
}
function request(confirmed = 'true', origin = 'https://example.test') {
  const form = new FormData();
  form.set('destination', '+12025550102'); form.set('confirmed', confirmed);
  form.set('document', new File(['%PDF-test'], 'test.pdf', { type: 'application/pdf' }));
  return new Request(`https://example.test/api/faxes/${id}`, { method: 'POST', headers: { origin }, body: form });
}
function environment() { return { DB: database(), FAX_ENABLED: 'true', TELNYX_API_TOKEN: 'test', TELNYX_FAX_CONNECTION_ID: 'connection', TELNYX_FAX_FROM: '+12025550101' }; }

it('uploads a PDF, sends once with confirmation, and checks actual delivery', async () => {
  const env = environment(); let sends = 0; let uploads = 0;
  const fetcher = async (url, options) => {
    if (url.endsWith('/media')) { uploads++; return Response.json({ data: { media_name: options.body.get('media_name') } }); }
    if (options.method === 'POST') { sends++; return Response.json({ data: { id: 'fax-1' } }, { status: 202 }); }
    return Response.json({ data: { id: 'fax-1', status: 'delivered' } });
  };
  assert.equal((await handleFaxSend(request('false'), env, 'owner', id, fetcher)).status, 400);
  assert.equal((await handleFaxSend(request('true', 'https://evil.test'), env, 'owner', id, fetcher)).status, 403);
  assert.deepEqual(await (await handleFaxSend(request(), env, 'owner', id, fetcher)).json(), { id, status: 'accepted' });
  assert.equal((await handleFaxSend(request(), env, 'owner', id, fetcher)).status, 409);
  assert.equal(uploads, 1); assert.equal(sends, 1);
  assert.equal((await (await handleFaxStatus(new Request(`https://example.test/api/faxes/${id}`), env, 'owner', id, fetcher)).json()).status, 'delivered');
});
