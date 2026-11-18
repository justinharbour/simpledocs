import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from './index.mjs';
import { approveMail, createTransmission, getTransmission, getTransmissionFile, listRecords, listTransmissions, reviewMail } from './transmissions.mjs';
import { address, jsonRequest, makeEnv, samplePdf, sendRequest } from './test-env.mjs';

const actor = 'owner';
const faxSpec = { title: 'Lease', fax: { recipients: ['(512) 555-0100', '512.555.0101'], cover: { enabled: true, to: 'Ada', message: 'Hello' } } };

test('create writes the envelope, queued fax rows and one message per fax channel', async () => {
  const { env, db, objects, queue } = makeEnv();
  const response = await createTransmission(await sendRequest(faxSpec, await samplePdf(2)), env, actor);
  assert.equal(response.status, 202);
  const { id, deliveries } = await response.json();
  assert.equal(deliveries.length, 2);
  assert.ok(objects.has(`outbound/${id}/document.pdf`));
  assert.equal([...objects.keys()].filter(k => k.startsWith(`covers/${id}/`)).length, 2);
  const tx = db.prepare('SELECT title, page_count FROM transmissions WHERE id = ?').get(id);
  assert.deepEqual({ ...tx }, { title: 'Lease', page_count: 2 });
  assert.deepEqual(db.prepare('SELECT DISTINCT status FROM dispatches').all().map(r => r.status), ['queued']);
  assert.equal(queue.sent.length, 2);
  assert.deepEqual(Object.keys(queue.sent[0]).sort(), ['channel', 'deliveryId', 'transmissionId']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM fax_intents').get().n, 0, 'nothing is submitted by the POST');
});

test('create rejects bad input without storing anything', async () => {
  const { env, db, objects, queue } = makeEnv();
  const pdf = await samplePdf(1);
  for (const spec of [{ fax: { recipients: ['123'] } }, { fax: { recipients: [] } }, {}, { mail: { to: { firstName: 'x' }, from: address } }]) {
    assert.equal((await createTransmission(await sendRequest(spec, pdf), env, actor)).status, 400);
  }
  const notPdf = new TextEncoder().encode('hello world, not a pdf');
  assert.equal((await createTransmission(await sendRequest(faxSpec, notPdf), env, actor)).status, 400);
  const wrongOrigin = await sendRequest(faxSpec, pdf); wrongOrigin.headers.set('origin', 'https://evil.test');
  assert.equal((await createTransmission(wrongOrigin, env, actor)).status, 403);
  assert.equal(db.prepare('SELECT count(*) AS n FROM transmissions').get().n, 0);
  assert.equal(objects.size, 0); assert.equal(queue.sent.length, 0);
});

test('list and detail are per actor, include the timeline and serve stored PDFs', async () => {
  const { env } = makeEnv();
  const { id, deliveries } = await (await createTransmission(await sendRequest(faxSpec, await samplePdf(1)), env, actor)).json();
  const list = await (await listTransmissions(env, actor)).json();
  assert.equal(list.transmissions.length, 1);
  assert.equal(list.transmissions[0].channels.length, 2);
  assert.equal((await (await listTransmissions(env, 'someone-else')).json()).transmissions.length, 0);
  const detail = await (await getTransmission(env, actor, id)).json();
  assert.equal(detail.title, 'Lease');
  assert.equal(detail.settled, false);
  assert.equal(detail.deliveries[0].timeline[0].status, 'queued');
  assert.ok(detail.deliveries[0].coverUrl);
  assert.equal((await getTransmission(env, 'someone-else', id)).status, 404);
  const doc = await getTransmissionFile(env, actor, id, 'document');
  assert.equal(doc.headers.get('content-type'), 'application/pdf');
  assert.equal((await getTransmissionFile(env, actor, id, 'cover', deliveries[0].id)).status, 200);
  assert.equal((await getTransmissionFile(env, 'someone-else', id, 'document')).status, 404);
});

test('without the cover toggle no cover is stored', async () => {
  const { env, objects } = makeEnv();
  await createTransmission(await sendRequest({ fax: { recipients: ['5125550100'], cover: { enabled: false } } }, await samplePdf(1)), env, actor);
  assert.equal([...objects.keys()].filter(k => k.startsWith('covers/')).length, 0);
});

test('mail waits for review and approval; nothing is queued before it', async () => {
  const { env, db, queue } = makeEnv();
  const spec = { title: 'Letter', mail: { to: address, from: { ...address, firstName: 'Justin' } } };
  const { id, deliveries } = await (await createTransmission(await sendRequest(spec, await samplePdf(1)), env, actor)).json();
  const mailId = deliveries[0].id;
  assert.equal(deliveries[0].status, 'awaiting_approval');
  assert.equal(queue.sent.length, 0);
  const review = await (await reviewMail(new Request(`https://example.test/x?mode=test`), env, actor, id, mailId)).json();
  assert.equal(review.available, true);
  const approve = body => approveMail(jsonRequest('/x', body), env, actor, id, mailId);
  assert.equal((await approve({ confirmed: true, mode: 'test', reviewHash: 'f'.repeat(64) })).status, 409, 'wrong hash');
  assert.equal((await approve({ confirmed: false, mode: 'test', reviewHash: review.reviewHash })).status, 400, 'no confirmation');
  assert.equal(queue.sent.length, 0);
  assert.equal((await approve({ confirmed: true, mode: 'test', reviewHash: review.reviewHash })).status, 202);
  assert.deepEqual(queue.sent, [{ transmissionId: id, channel: 'mail', deliveryId: mailId }]);
  assert.equal(db.prepare('SELECT status FROM dispatches WHERE id = ?').get(mailId).status, 'queued');
  assert.equal((await approve({ confirmed: true, mode: 'test', reviewHash: review.reviewHash })).status, 409, 'second approval');
  assert.equal(queue.sent.length, 1);
});

test('a review of test mode cannot be approved as live, and swapped keys are refused', async () => {
  const { env, queue } = makeEnv();
  const spec = { mail: { to: address, from: address } };
  const { id, deliveries } = await (await createTransmission(await sendRequest(spec, await samplePdf(1)), env, actor)).json();
  const review = await (await reviewMail(new Request('https://example.test/x?mode=test'), env, actor, id, deliveries[0].id)).json();
  const live = await approveMail(jsonRequest('/x', { confirmed: true, mode: 'live', reviewHash: review.reviewHash }), env, actor, id, deliveries[0].id);
  assert.equal(live.status, 409);
  const swapped = { ...env, POSTGRID_TEST_KEY: 'live_sk_abcdef' };
  const refused = await approveMail(jsonRequest('/x', { confirmed: true, mode: 'test', reviewHash: review.reviewHash }), swapped, actor, id, deliveries[0].id);
  assert.equal(refused.status, 503);
  assert.equal(queue.sent.length, 0);
});

test('records merge sent envelopes, inbound faxes and recordings newest first', async () => {
  const { env, db } = makeEnv();
  db.prepare("INSERT INTO inbound_fax_events (event_id, fax_id, event_type, occurred_at, received_at, object_key) VALUES ('e1', 'f1', 'fax.received', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z', 'inbound-fax/a/b.pdf')").run();
  db.prepare("INSERT INTO voice_events (event_id, event_type, call_control_id, occurred_at) VALUES ('v1', 'call.recording.saved', 'leg', '2026-01-02T00:00:00Z')").run();
  db.prepare("INSERT INTO voice_recordings (recording_id, event_id, call_control_id, object_key, content_type, kind, archived_at, from_number, direction, duration_secs) VALUES ('r1', 'v1', 'leg', 'voice/r1/x.mp3', 'audio/mpeg', 'voicemail', '2026-01-02 00:00:00', '+15125550100', 'inbound', 12)").run();
  await createTransmission(await sendRequest(faxSpec, await samplePdf(1)), env, actor);
  const { records } = await (await listRecords(env, actor, { inboundAllowed: true, voiceAllowed: true })).json();
  assert.deepEqual(records.map(r => r.type), ['transmission', 'recording', 'inbound_fax']);
  assert.equal(records[1].previewType, 'audio'); assert.equal(records[1].durationSecs, 12);
  const limited = (await (await listRecords(env, actor, { inboundAllowed: false, voiceAllowed: false })).json()).records;
  assert.deepEqual(limited.map(r => r.type), ['transmission']);
});

test('every new route requires a verified Access identity', async () => {
  const { env } = makeEnv({ ACCESS_AUDIENCE: 'expected', ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com' });
  const id = '11111111-1111-4111-8111-111111111111';
  const worker = createWorker();
  for (const [method, path] of [['POST', '/api/transmissions'], ['GET', '/api/transmissions'], ['GET', `/api/transmissions/${id}`], ['GET', `/api/transmissions/${id}/document`], ['POST', `/api/transmissions/${id}/mail/${id}/approve`], ['GET', `/api/transmissions/${id}/mail/${id}/review?mode=test`], ['GET', '/api/records'], ['GET', '/api/voice/calls'], ['GET', '/api/voice/recordings'], ['POST', `/api/voice/recordings/${id}/heard`], ['POST', '/api/cover-preview'], ['GET', '/api/settings'], ['PUT', '/api/settings']]) {
    assert.equal((await worker.fetch(new Request(`https://example.test${path}`, { method }), env)).status, 401, `${method} ${path}`);
    assert.equal((await worker.fetch(new Request(`https://example.test${path}`, { method, headers: { 'cf-access-jwt-assertion': 'forged' } }), env)).status, 401, `${method} ${path} forged`);
  }
});

test('email-only transmission uses the portal and appears in records without claiming delivery', async () => {
  const messages = [];
  const { env } = makeEnv({ PORTAL_ORIGIN: 'https://example.test', PORTAL_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', PORTAL_SENDER: 'sender@example.test', PORTAL_EMAIL: { send: async message => messages.push(message) } });
  const response = await createTransmission(await sendRequest({ email: { email: 'recipient@example.test', pinChannel: 'none' } }, await samplePdf(1)), env, actor);
  const result = await response.json();
  assert.equal(response.status, 202); assert.equal(result.deliveries[0].status, 'accepted'); assert.equal(messages.length, 1);
  const detail = await (await getTransmission(env, actor, result.id)).json();
  assert.equal(detail.deliveries[0].channel, 'email'); assert.equal(detail.deliveries[0].status, 'accepted');
  assert.equal((await (await listTransmissions(env, actor)).json()).transmissions[0].channels[0].channel, 'email');
  assert.equal((await getTransmission(env, 'someone-else', result.id)).status, 404);
});

test('email configuration failure is reported without a provider call', async () => {
  const { env } = makeEnv();
  const r = await createTransmission(await sendRequest({ email: { email: 'recipient@example.test', pinChannel: 'none' } }, await samplePdf(1)), env, actor);
  const result = await r.json();
  assert.equal(result.deliveries[0].status, 'failed'); assert.match(result.deliveries[0].error, /not configured/);
});
