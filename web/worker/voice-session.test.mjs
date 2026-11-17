import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleVoiceSession } from './voice-session.mjs';
import worker from './index.mjs';

const env = { VOICE_WEBRTC_ENABLED: 'true', VOICE_OWNER_SUBJECT: 'owner', TELNYX_WEBRTC_CREDENTIAL_ID: 'credential-1', TELNYX_VOICE_FROM: '+12025550102', TELNYX_API_TOKEN: 'server-secret' };
const req = (origin = 'https://example.test') => new Request('https://example.test/api/voice/session', { method: 'POST', headers: { origin } });

test('only the configured owner can issue a token via same-origin POST', async () => {
  let calls = 0;
  const fetcher = async (url, options) => { calls++; assert.equal(url, 'https://api.telnyx.com/v2/telephony_credentials/credential-1/token'); assert.equal(options.redirect, 'error'); return new Response('a.b.c', { status: 201 }); };
  assert.equal((await worker.fetch(req(), env)).status, 401);
  assert.equal((await handleVoiceSession(req(), env, 'other', fetcher)).status, 503);
  assert.equal((await handleVoiceSession(req('https://evil.test'), env, 'owner', fetcher)).status, 403);
  assert.equal((await handleVoiceSession(req(), { ...env, VOICE_WEBRTC_ENABLED: 'false' }, 'owner', fetcher)).status, 503);
  assert.equal(calls, 0);
  const result = await handleVoiceSession(req(), env, 'owner', fetcher);
  assert.deepEqual(await result.json(), { loginToken: 'a.b.c', callerNumber: '+12025550102' });
  assert.match(result.headers.get('cache-control'), /no-store/);
  assert.equal(calls, 1);
});

test('provider errors and malformed token are not exposed', async () => {
  for (const provider of [async () => new Response('server-secret', { status: 500 }), async () => new Response('bad', { status: 201 }), async () => { throw Error('secret'); }]) {
    const response = await handleVoiceSession(req(), env, 'owner', provider);
    assert.equal(response.status, 502); assert.equal((await response.text()).includes('secret'), false);
  }
});
