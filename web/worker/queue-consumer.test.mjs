import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { handleQueue, processDelivery, reconcileDeliveries } from './queue-consumer.mjs';
import { applyOutboundFaxEvent } from './deliveries.mjs';
import { approveMail, createTransmission, getTransmission, reviewMail } from './transmissions.mjs';
import { address, approveTestFax, jsonRequest, makeEnv, samplePdf, sendRequest } from './test-env.mjs';

const actor = 'owner';
const faxSpec = { title: 'Lease', fax: { recipients: ['5125550100'], cover: { enabled: true } } };

async function fakeTelnyx({ upload = 200, fax = 200, faxStatus = 'queued' } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
    if (String(url).endsWith('/v2/media')) return new Response(JSON.stringify({ data: { media_name: init.body.get('media_name') } }), { status: upload });
    if (String(url).endsWith('/v2/faxes')) return fax === 200 ? new Response(JSON.stringify({ data: { id: 'fax-provider-1' } }), { status: 200 }) : new Response('{}', { status: fax });
    if (String(url).includes('/v2/faxes/')) return new Response(JSON.stringify({ data: { id: 'fax-provider-1', status: faxStatus } }));
    throw new Error(`unexpected ${url}`);
  };
  return { fetcher, calls };
}
const message = (body, attempts = 1) => ({ body, attempts, acked: false, retried: null, ack() { this.acked = true; }, retry(o) { this.retried = o; } });

async function queuedFax() {
  const ctx = makeEnv();
  const { id, deliveries } = await (await createTransmission(await sendRequest(faxSpec, await samplePdf(2)), ctx.env, actor)).json();
  await approveTestFax(ctx.env, actor, id, deliveries[0].id);
  return { ...ctx, body: { transmissionId: id, channel: 'fax', deliveryId: deliveries[0].id }, deliveryId: deliveries[0].id, id };
}
const status = (db, id) => db.prepare('SELECT status, provider_id, provider_status, error FROM dispatches WHERE id = ?').get(id);

test('fax: submits cover plus document once, and accepted is not delivered', async () => {
  const { env, db, body, deliveryId } = await queuedFax();
  const { fetcher, calls } = await fakeTelnyx();
  assert.equal(await processDelivery(env, body, 1, fetcher), 'ack');
  const row = status(db, deliveryId);
  assert.equal(row.status, 'accepted'); assert.equal(row.provider_id, 'fax-provider-1');
  const media = calls.find(c => c.url.endsWith('/v2/media')).body.get('media');
  assert.equal((await PDFDocument.load(new Uint8Array(await media.arrayBuffer()))).getPageCount(), 3, 'cover + 2 pages');
  assert.equal(db.prepare('SELECT status FROM fax_intents WHERE id = ?').get(deliveryId).status, 'accepted');
});

test('fax: redelivery of the same message never submits again', async () => {
  const { env, body } = await queuedFax();
  const { fetcher, calls } = await fakeTelnyx();
  await processDelivery(env, body, 1, fetcher);
  const before = calls.length;
  assert.equal(await processDelivery(env, body, 2, fetcher), 'ack');
  assert.equal(await processDelivery(env, body, 3, fetcher), 'ack');
  assert.equal(calls.length, before);
});

test('fax: redelivery after a crash between claim and status copy does not resubmit', async () => {
  const { env, db, body, deliveryId } = await queuedFax();
  const { fetcher, calls } = await fakeTelnyx();
  await processDelivery(env, body, 1, fetcher);
  db.prepare("UPDATE dispatches SET status = 'queued', provider_id = NULL WHERE id = ?").run(deliveryId);
  const before = calls.length;
  assert.equal(await processDelivery(env, body, 2, fetcher), 'ack');
  assert.equal(calls.length, before);
  assert.equal(status(db, deliveryId).status, 'accepted');
});

test('fax: a transient provider error retries with a delay and a later attempt succeeds', async () => {
  const { env, db, body, deliveryId } = await queuedFax();
  const down = await fakeTelnyx({ upload: 503 });
  const m = message(body);
  await handleQueue({ messages: [m] }, env, down.fetcher);
  assert.equal(m.acked, false); assert.ok(m.retried.delaySeconds >= 30);
  assert.equal(status(db, deliveryId).status, 'queued');
  assert.equal(db.prepare('SELECT count(*) AS n FROM fax_intents WHERE status = \'submitting\'').get().n, 0);
  const up = await fakeTelnyx();
  const again = message(body, 2);
  await handleQueue({ messages: [again] }, env, up.fetcher);
  assert.equal(again.acked, true);
  assert.equal(status(db, deliveryId).status, 'accepted');
});

test('fax: a permanent failure marks the row failed with a safe reason and acks', async () => {
  const { env, db, body, deliveryId } = await queuedFax();
  const { fetcher } = await fakeTelnyx({ upload: 400 });
  const m = message(body);
  await handleQueue({ messages: [m] }, env, fetcher);
  assert.equal(m.acked, true); assert.equal(m.retried, null);
  const row = status(db, deliveryId);
  assert.equal(row.status, 'failed');
  assert.match(row.error, /no fax was sent/);
  assert.equal(row.error.includes('token'), false);
});

test('fax: a provider rejection fails; an ambiguous outcome is unknown, never delivered', async () => {
  const rejected = await queuedFax();
  await processDelivery(rejected.env, rejected.body, 1, (await fakeTelnyx({ fax: 422 })).fetcher);
  assert.equal(status(rejected.db, rejected.deliveryId).status, 'failed');
  const ambiguous = await queuedFax();
  await processDelivery(ambiguous.env, ambiguous.body, 1, (await fakeTelnyx({ fax: 500 })).fetcher);
  assert.equal(status(ambiguous.db, ambiguous.deliveryId).status, 'unknown');
});

test('fax: retries are bounded', async () => {
  const { env, db, body, deliveryId } = await queuedFax();
  const { fetcher } = await fakeTelnyx({ upload: 503 });
  assert.equal(await processDelivery(env, body, 6, fetcher), 'ack');
  assert.equal(status(db, deliveryId).status, 'failed');
});

test('delivered only comes from a provider-reported terminal status', async () => {
  const { env, db, body, deliveryId } = await queuedFax();
  await processDelivery(env, body, 1, (await fakeTelnyx()).fetcher);
  await applyOutboundFaxEvent(env, 'fax.sending.started', 'fax-provider-1');
  assert.equal(status(db, deliveryId).status, 'accepted');
  const detail = await (await getTransmission(env, actor, body.transmissionId, (await fakeTelnyx({ faxStatus: 'sending' })).fetcher)).json();
  assert.equal(detail.deliveries[0].status, 'accepted'); assert.equal(detail.settled, false);
  await applyOutboundFaxEvent(env, 'fax.delivered', 'fax-provider-1');
  assert.equal(status(db, deliveryId).status, 'delivered');
  await applyOutboundFaxEvent(env, 'fax.failed', 'fax-provider-1');
  assert.equal(status(db, deliveryId).status, 'delivered', 'terminal rows do not change');
  const timeline = db.prepare('SELECT status, detail FROM timeline WHERE delivery_id = ? ORDER BY id').all(deliveryId);
  assert.deepEqual([...new Set(timeline.map(r => r.status))], ['awaiting_approval', 'queued', 'accepted', 'delivered']);
  assert.ok(timeline.some(r => r.detail === 'sending.started'), 'provider progress is kept as detail');
});

test('detail polling reconciles an accepted fax with the provider', async () => {
  const { env, db, body, deliveryId } = await queuedFax();
  await processDelivery(env, body, 1, (await fakeTelnyx()).fetcher);
  const detail = await (await getTransmission(env, actor, body.transmissionId, (await fakeTelnyx({ faxStatus: 'delivered' })).fetcher)).json();
  assert.equal(detail.deliveries[0].status, 'delivered'); assert.equal(detail.settled, true);
  assert.equal(status(db, deliveryId).status, 'delivered');
});

async function approvedMail(mode = 'test') {
  const ctx = makeEnv();
  const { id, deliveries } = await (await createTransmission(await sendRequest({ mail: { to: address, from: address } }, await samplePdf(1)), ctx.env, actor)).json();
  const mailId = deliveries[0].id;
  const review = await (await reviewMail(new Request(`https://example.test/x?mode=${mode}`), ctx.env, actor, id, mailId)).json();
  await approveMail(jsonRequest('/x', { confirmed: true, mode, reviewHash: review.reviewHash }), ctx.env, actor, id, mailId);
  return { ...ctx, id, mailId, body: { transmissionId: id, channel: 'mail', deliveryId: mailId } };
}
function fakePostgrid(letterStatus = 'ready', createStatus = 201) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', key: init.headers?.['X-API-Key'], body: init.body });
    if ((init.method ?? 'GET') === 'POST') return createStatus === 201 ? new Response(JSON.stringify({ object: 'letter', id: 'letter_abc123' }), { status: 201 }) : new Response('{}', { status: createStatus });
    return new Response(JSON.stringify({ id: 'letter_abc123', status: letterStatus }));
  };
  return { fetcher, calls };
}

test('mail: an unapproved row on the queue is never submitted', async () => {
  const ctx = makeEnv();
  const { id, deliveries } = await (await createTransmission(await sendRequest({ mail: { to: address, from: address } }, await samplePdf(1)), ctx.env, actor)).json();
  const { fetcher, calls } = fakePostgrid();
  const body = { transmissionId: id, channel: 'mail', deliveryId: deliveries[0].id };
  assert.equal(await processDelivery(ctx.env, body, 1, fetcher), 'ack');
  assert.equal(calls.length, 0);
  ctx.db.prepare("UPDATE dispatches SET status = 'queued' WHERE id = ?").run(deliveries[0].id);
  assert.equal(await processDelivery(ctx.env, body, 1, fetcher), 'ack');
  assert.equal(calls.length, 0, 'queued without approval metadata is refused');
  assert.equal(status(ctx.db, deliveries[0].id).status, 'failed');
});

test('mail: approved test mail uses the test key and sends the PDF; redelivery does not duplicate', async () => {
  const { env, db, body, mailId } = await approvedMail('test');
  const { fetcher, calls } = fakePostgrid();
  assert.equal(await processDelivery(env, body, 1, fetcher), 'ack');
  const post = calls.find(c => c.method === 'POST');
  assert.equal(post.key, 'test_sk_abcdef');
  assert.ok(post.body.get('pdf') instanceof Blob);
  assert.equal(post.body.get('to[firstName]'), 'Ada');
  assert.equal(status(db, mailId).status, 'accepted');
  await processDelivery(env, body, 2, fetcher);
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

test('mail: PostGrid completed is shown as completed, never delivered', async () => {
  const { env, db, body, mailId } = await approvedMail('test');
  await processDelivery(env, body, 1, fakePostgrid('ready').fetcher);
  const processing = await (await getTransmission(env, actor, body.transmissionId, fakePostgrid('printing').fetcher)).json();
  assert.equal(processing.deliveries[0].status, 'accepted'); assert.equal(processing.deliveries[0].providerStatus, 'printing');
  const done = await (await getTransmission(env, actor, body.transmissionId, fakePostgrid('completed').fetcher)).json();
  assert.equal(done.deliveries[0].status, 'completed');
  assert.notEqual(status(db, mailId).status, 'delivered');
});

test('mail: a live review cannot send with the test key, and a PostGrid rejection releases the claim', async () => {
  const live = await approvedMail('live');
  const { fetcher, calls } = fakePostgrid();
  await processDelivery(live.env, live.body, 1, fetcher);
  assert.equal(calls.find(c => c.method === 'POST').key, 'live_sk_abcdef');
  const rejected = await approvedMail('test');
  await processDelivery(rejected.env, rejected.body, 1, fakePostgrid('ready', 422).fetcher);
  assert.equal(status(rejected.db, rejected.mailId).status, 'failed');
  assert.equal(rejected.db.prepare('SELECT count(*) AS n FROM mail_intents').get().n, 0);
});

test('cron re-enqueues stale queued rows and re-polls open ones', async () => {
  const { env, db, queue, deliveryId, id } = await queuedFax();
  const later = Date.now() + 10 * 60 * 1000;
  await reconcileDeliveries(env, fetch, later);
  assert.deepEqual(queue.sent.slice(-1), [{ transmissionId: id, channel: 'fax', deliveryId }]);
  const before = queue.sent.length;
  await reconcileDeliveries(env, fetch, Date.now());
  assert.equal(queue.sent.length, before, 'fresh rows are left alone');
  await processDelivery(env, { transmissionId: id, channel: 'fax', deliveryId }, 1, (await fakeTelnyx()).fetcher);
  await reconcileDeliveries(env, (await fakeTelnyx({ faxStatus: 'delivered' })).fetcher, later);
  assert.equal(status(db, deliveryId).status, 'delivered');
  await reconcileDeliveries(env, fetch, later + 25 * 60 * 60 * 1000);
});

test('approval still succeeds when the queue is down; the cron picks the row up', async () => {
  const ctx = makeEnv();
  ctx.queue.failNext = true;
  const response = await createTransmission(await sendRequest(faxSpec, await samplePdf(1)), ctx.env, actor);
  assert.equal(response.status, 202);
  const { id, deliveries } = await response.json();
  await approveTestFax(ctx.env, actor, id, deliveries[0].id);
  assert.equal(ctx.db.prepare("SELECT status FROM dispatches").get().status, 'queued');
});

async function approvedCertified(mailingClass) {
  const ctx = makeEnv();
  const { id, deliveries } = await (await createTransmission(await sendRequest({ mail: { to: address, from: address, mailingClass } }, await samplePdf(1)), ctx.env, actor)).json();
  const mailId = deliveries[0].id;
  const review = await (await reviewMail(new Request('https://example.test/x?mode=test'), ctx.env, actor, id, mailId)).json();
  assert.equal(review.summary.mailingClass, mailingClass, 'the class is part of the reviewed summary');
  await approveMail(jsonRequest('/x', { confirmed: true, mode: 'test', reviewHash: review.reviewHash }), ctx.env, actor, id, mailId);
  return { ...ctx, id, mailId, body: { transmissionId: id, channel: 'mail', deliveryId: mailId } };
}
const trackedLetter = (extra = {}) => ({ id: 'letter_abc123', status: 'completed', trackingNumber: '9407111899223197428490', url: 'https://signed.example/preview.pdf',
  statusEvents: [{ status: 'ready', date: '2026-11-01T00:00:00Z' }, { status: 'completed', date: '2026-11-03T00:00:00Z' }],
  imbStatus: 'entered_mail_stream', imbDate: '2026-11-04T00:00:00Z', imbZIPCode: '78701', imbEvents: [{ status: 'entered_mail_stream', date: '2026-11-04T00:00:00Z', zipCode: '78701', scanCode: 'SD' }], ...extra });

test('mail: certified return receipt is sent as that mailing class and its tracking is stored with an R2 snapshot', async () => {
  const { env, db, objects, body, mailId, id } = await approvedCertified('certified_return_receipt');
  const calls = [];
  let letter = { id: 'letter_abc123', status: 'ready' };
  const fetcher = async (url, init = {}) => {
    calls.push({ method: init.method ?? 'GET', body: init.body });
    if ((init.method ?? 'GET') === 'POST') return new Response(JSON.stringify({ object: 'letter', id: 'letter_abc123' }), { status: 201 });
    return new Response(JSON.stringify(letter));
  };
  await processDelivery(env, body, 1, fetcher);
  assert.equal(calls.find(c => c.method === 'POST').body.get('mailingClass'), 'certified_return_receipt');
  letter = trackedLetter();
  const detail = await (await getTransmission(env, actor, id, fetcher)).json();
  const tracking = detail.deliveries[0].tracking;
  assert.equal(detail.deliveries[0].status, 'completed');
  assert.equal(tracking.trackingNumber, '9407111899223197428490');
  assert.match(tracking.trackingUrl, /tools\.usps\.com.*9407111899223197428490/);
  assert.equal(tracking.returnReceiptRequested, true);
  assert.equal(tracking.returnReceipt, null);
  assert.equal(tracking.imbEvents[0].zipCode, '78701');
  assert.equal(tracking.statusEvents.length, 2);
  const snapshots = [...objects.keys()].filter(k => k.startsWith(`outbound/${id}/mail/${mailId}/tracking/`));
  assert.ok(snapshots.length >= 1);
  const stored = JSON.parse(new TextDecoder().decode(objects.get(snapshots.at(-1))));
  assert.equal(stored.letter.trackingNumber, '9407111899223197428490');
  assert.equal(stored.letter.url, undefined, 'the expiring preview link is not stored');
  assert.equal(db.prepare('SELECT tracking_number FROM mail_tracking WHERE delivery_id = ?').get(mailId).tracking_number, '9407111899223197428490');
});

test('mail: cron keeps polling completed letters for later USPS scans, without rewriting unchanged snapshots', async () => {
  const { env, db, objects, body, mailId, id } = await approvedCertified('certified');
  let letter = { id: 'letter_abc123', status: 'completed' };
  const fetcher = async (url, init = {}) => (init.method ?? 'GET') === 'POST' ? new Response(JSON.stringify({ object: 'letter', id: 'letter_abc123' }), { status: 201 }) : new Response(JSON.stringify(letter));
  await processDelivery(env, body, 1, fetcher);
  await getTransmission(env, actor, id, fetcher);
  assert.equal(db.prepare('SELECT status FROM dispatches WHERE id = ?').get(mailId).status, 'completed');
  letter = trackedLetter({ imbStatus: 'out_for_delivery', imbDate: '2026-11-05T00:00:00Z' });
  const later = Date.now() + 7 * 60 * 60 * 1000;
  await reconcileDeliveries(env, fetcher, later);
  const row = db.prepare('SELECT tracking_number, imb_status FROM mail_tracking WHERE delivery_id = ?').get(mailId);
  assert.deepEqual({ ...row }, { tracking_number: '9407111899223197428490', imb_status: 'out_for_delivery' });
  const count = () => [...objects.keys()].filter(k => k.includes('/tracking/')).length;
  const before = count();
  db.prepare("UPDATE mail_tracking SET checked_at = '2000-01-01T00:00:00.000Z' WHERE delivery_id = ?").run(mailId);
  await reconcileDeliveries(env, fetcher, later + 1000);
  assert.equal(count(), before, 'unchanged tracking is not snapshotted again');
});
