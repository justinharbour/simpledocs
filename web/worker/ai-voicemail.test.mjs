import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, jsonRequest } from './test-env.mjs';
import { assistantForCall, handleAiTool, handleKnowledge, listAiRequests, deleteAiRequest, expireAiSessions } from './ai-voicemail.mjs';

test('knowledge starts empty and requires same-origin writes', async () => {
  const { env } = makeEnv();
  assert.deepEqual(await (await handleKnowledge(new Request('https://example.test/api/settings/ai-knowledge'), env)).json(), { knowledge: '' });
  assert.equal((await handleKnowledge(new Request('https://example.test/api/settings/ai-knowledge', { method: 'PUT', body: '{}' }), env)).status, 403);
  assert.equal((await handleKnowledge(jsonRequest('/api/settings/ai-knowledge', { knowledge: 'Approved facts' }, 'PUT'), env)).status, 200);
});

test('owner deletion waits for callback expiry, then deletes; expired sessions are cleaned', async () => {
  const { env, db } = makeEnv({ TELNYX_AI_ASSISTANT_ID: 'assistant-test', AI_TOOL_BASE_URL: 'https://example.test' });
  await assistantForCall(env, 'leg');
  db.prepare('INSERT INTO ai_voicemail_requests (call_control_id,kind,details,consent,created_at) VALUES (?, ?, ?, ?, ?)').run('leg', 'sms', 'details', 1, new Date().toISOString());
  const list = await (await listAiRequests(new Request('https://example.test/api/voice/ai-requests'), env)).json();
  assert.equal(JSON.stringify(list).includes('leg'), false);
  const id = list.requests[0].id;
  const del = origin => new Request(`https://example.test/api/voice/ai-requests/${id}`, { method: 'DELETE', headers: { origin } });
  assert.equal((await deleteAiRequest(del('https://evil.test'), env, id)).status, 403);
  assert.equal((await deleteAiRequest(del('https://example.test'), env, id)).status, 409);
  const future = Date.now() + 5 * 3600000;
  assert.equal((await deleteAiRequest(del('https://example.test'), env, id, future)).status, 200);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_voicemail_requests').get().n, 0);
  await expireAiSessions(env, future);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_voicemail_sessions').get().n, 0);
});

test('per-call tools require matching bearer and call ID, consent and replay consistency', async () => {
  const { env, db } = makeEnv({ TELNYX_AI_ASSISTANT_ID: 'assistant-test', AI_TOOL_BASE_URL: 'https://example.test' });
  const assistant = await assistantForCall(env, 'call-1');
  assert.match(assistant.instructions, /say you do not know/);
  const token = assistant.tools[2].webhook.headers[0].value;
  const request = (auth, call, body) => new Request('https://example.test/api/webhooks/telnyx/ai/sms', { method: 'POST', headers: { authorization: auth, 'x-telnyx-call-control-id': call }, body: JSON.stringify(body) });
  assert.equal((await handleAiTool(request('Bearer bad', 'call-1', {}), env, 'sms')).status, 401);
  assert.equal((await handleAiTool(request(token, 'call-2', {}), env, 'sms')).status, 401);
  assert.equal((await handleAiTool(request(token, 'call-1', { details: 'hello', consent: false }), env, 'sms')).status, 400);
  const body = { details: 'Please text me', consent: true };
  assert.equal((await handleAiTool(request(token, 'call-1', body), env, 'sms')).status, 200);
  assert.equal((await handleAiTool(request(token, 'call-1', body), env, 'sms')).status, 200);
  assert.equal((await handleAiTool(request(token, 'call-1', { ...body, details: 'different' }), env, 'sms')).status, 409);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_voicemail_requests').get().n, 1);
});
