import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from './index.mjs';
import { handleVoicemailSettings } from './voicemail-config.mjs';
import { jsonRequest, makeEnv } from './test-env.mjs';

const get = () => new Request('https://example.test/api/settings/voicemail');
const put = body => jsonRequest('/api/settings/voicemail', body, 'PUT');

test('GET returns the effective defaults, using the environment greeting', async () => {
  const { env } = makeEnv({ VOICEMAIL_GREETING: '  Please leave a message.  ' });
  const response = await handleVoicemailSettings(get(), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { greeting: 'Please leave a message.', voice: 'Telnyx.KokoroTTS.af', service_level: 'basic' });
  const empty = makeEnv();
  assert.equal((await (await handleVoicemailSettings(get(), empty.env)).json()).greeting, '');
});

test('PUT saves, trims and is read back; stored values beat the environment', async () => {
  const { env, db } = makeEnv({ VOICEMAIL_GREETING: 'From env' });
  const response = await handleVoicemailSettings(put({ greeting: '  Hello there  ', voice: 'AWS.Polly.Joanna-Neural', service_level: 'premium' }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { greeting: 'Hello there', voice: 'AWS.Polly.Joanna-Neural', service_level: 'premium' });
  assert.deepEqual(await (await handleVoicemailSettings(get(), env)).json(), { greeting: 'Hello there', voice: 'AWS.Polly.Joanna-Neural', service_level: 'premium' });
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'voicemail_greeting'").get().value, 'Hello there');
  await handleVoicemailSettings(put({ voice: 'female' }), env);
  assert.equal((await (await handleVoicemailSettings(get(), env)).json()).voice, 'female');
});

test('PUT rejects invalid input and stores nothing', async () => {
  const { env, db } = makeEnv();
  for (const body of [
    { greeting: '' }, { greeting: '   ' }, { greeting: 'x'.repeat(1001) }, { greeting: 5 },
    { voice: 'robot' }, { voice: 'Telnyx.KokoroTTS' }, { voice: 'a.b.c d' }, { voice: 'a.b.c/../d' }, { voice: 7 },
    { service_level: 'gold' }, { service_level: null },
  ]) {
    assert.equal((await handleVoicemailSettings(put(body), env)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await handleVoicemailSettings(put([]), env)).status, 400);
  assert.equal((await handleVoicemailSettings(new Request('https://example.test/api/settings/voicemail', { method: 'PUT', body: 'nope', headers: { origin: 'https://example.test' } }), env)).status, 400);
  assert.equal(db.prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'voicemail_%'").get().n, 0);
  assert.equal((await handleVoicemailSettings(put({ greeting: 'x'.repeat(1000) }), env)).status, 200);
  for (const voice of ['female', 'male', 'Telnyx.KokoroTTS.af', 'AWS.Polly.Joanna-Neural', 'Telnyx.NaturalHD.astra', 'Azure.Neural.en-US-AvaNeural']) {
    assert.equal((await handleVoicemailSettings(put({ voice }), env)).status, 200, voice);
  }
});

test('PUT needs a same-origin request and other methods are refused', async () => {
  const { env } = makeEnv();
  const cross = new Request('https://example.test/api/settings/voicemail', { method: 'PUT', body: JSON.stringify({ greeting: 'Hi' }), headers: { origin: 'https://evil.test' } });
  assert.equal((await handleVoicemailSettings(cross, env)).status, 403);
  assert.equal((await handleVoicemailSettings(new Request('https://example.test/api/settings/voicemail', { method: 'PUT', body: '{}' }), env)).status, 403);
  assert.equal((await handleVoicemailSettings(new Request('https://example.test/api/settings/voicemail', { method: 'DELETE' }), env)).status, 405);
});

test('an invalid stored value falls back to the default', async () => {
  const { env, db } = makeEnv({ VOICEMAIL_GREETING: 'From env' });
  db.exec("INSERT INTO settings (key, value, updated_at) VALUES ('voicemail_voice', 'bad voice', 'x'), ('voicemail_greeting', '', 'x'), ('voicemail_service_level', 'gold', 'x')");
  assert.deepEqual(await (await handleVoicemailSettings(get(), env)).json(), { greeting: 'From env', voice: 'Telnyx.KokoroTTS.af', service_level: 'basic' });
});

test('the route requires a verified Access identity and does not shadow /api/settings', async () => {
  const { env } = makeEnv({ ACCESS_AUDIENCE: 'expected', ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com' });
  const worker = createWorker();
  for (const method of ['GET', 'PUT']) {
    assert.equal((await worker.fetch(new Request('https://example.test/api/settings/voicemail', { method }), env)).status, 401, method);
    assert.equal((await worker.fetch(new Request('https://example.test/api/settings/voicemail', { method, headers: { 'cf-access-jwt-assertion': 'forged' } }), env)).status, 401, `${method} forged`);
  }
});
