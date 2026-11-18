import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { submitFax } from './telnyx-fax.mjs';

const input = { token: 'test-token', connectionId: 'test-connection', from: '+12025550101', to: '+12025550102', mediaName: 'test-document.pdf', intentId: '11111111-1111-4111-8111-111111111111' };

describe('Telnyx fax single-attempt boundary', () => {
  it('sends one request and returns provider acceptance, not delivery', async () => {
    let calls = 0;
    const result = await submitFax(input, async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.telnyx.com/v2/faxes');
      assert.equal(options.redirect, 'manual');
      assert.deepEqual(JSON.parse(options.body), { connection_id: input.connectionId, from: input.from, to: input.to, media_name: input.mediaName, client_state: btoa(input.intentId) });
      return Response.json({ data: { id: 'fax-id' } }, { status: 202 });
    });
    assert.deepEqual(result, { outcome: 'accepted', providerId: 'fax-id' });
    assert.equal(calls, 1);
  });
  it('never treats a timeout, provider error or malformed success as safe to retry', async () => {
    for (const fetcher of [async () => { throw Error('network'); }, async () => new Response('', { status: 500 }), async () => new Response('', { status: 429 }), async () => Response.json({ data: {} })]) {
      assert.deepEqual(await submitFax(input, fetcher), { outcome: 'unknown' });
    }
  });
  it('classifies a definitive client rejection without exposing provider data', async () => {
    assert.deepEqual(await submitFax(input, async () => new Response('secret details', { status: 422 })), { outcome: 'rejected' });
  });
  it('validates input before invoking provider', async () => {
    let called = false;
    await assert.rejects(() => submitFax({ ...input, to: 'not-a-number' }, async () => { called = true; }), TypeError);
    assert.equal(called, false);
  });
});
