import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, degrees, decodePDFRawStream } from 'pdf-lib';
import { createWorker } from './index.mjs';
import { processDelivery } from './queue-consumer.mjs';
import { approveMail, createTransmission, getTransmission, getTransmissionFile, listRecords, listTransmissions, reviewMail } from './transmissions.mjs';
import { address, jsonRequest, makeEnv, samplePdf, sendRequest } from './test-env.mjs';
import { portal, revokeEmailDelivery } from './email-portal.mjs';
import { newPortalToken } from './portal-crypto.mjs';

const actor = 'owner';
const faxSpec = { title: 'Lease', fax: { recipients: ['(512) 555-0100', '512.555.0101'], cover: { enabled: true, to: 'Ada', message: 'Hello' } } };
const portalEnv = (messages = []) => makeEnv({ PORTAL_ENABLED: 'true', PORTAL_ORIGIN: 'https://example.test', PORTAL_KEY: newPortalToken(), PORTAL_SENDER: 'test@example.test', PORTAL_EMAIL: { send: async m => messages.push(m) } });
const emailSpec = { email: { email: 'recipient@example.test', pinChannel: 'none' } };
const emailRequest = async (spec = emailSpec) => sendRequest(spec, [await pdfFile('lease.pdf', [612])], undefined, 'emailDocuments');

async function pdfFile(name, widths, populated = false) {
  const pdf = await PDFDocument.create();
  pdf.setTitle('PRIVATE_SOURCE_METADATA');
  for (const [i, width] of widths.entries()) {
    const page = pdf.addPage([width, 792]);
    if (populated) {
      page.drawText(`Original page ${i + 1}`, { x: 12, y: 774 });
      const privatePageMetadata = pdf.context.flateStream(new TextEncoder().encode('PRIVATE_PAGE_METADATA'));
      page.node.set(PDFName.of('Metadata'), pdf.context.register(privatePageMetadata));
    }
  }
  return new File([await pdf.save()], name, { type: 'application/pdf' });
}

for (const stamped of [false, true]) test(`recipient receives ordered packet ${stamped ? 'with' : 'without'} headers, isolated and revocable`, async () => {
  const messages = [];
  const { env, objects } = portalEnv(messages);
  const response = await createTransmission(await sendRequest(emailSpec, [await pdfFile('z.pdf', [612, 600]), await pdfFile('a.pdf', [601])], undefined, stamped ? 'numberedEmailDocuments' : 'emailDocuments'), env, actor);
  const result = await response.json();
  assert.equal(result.deliveries[0].status, 'accepted');
  assert.deepEqual(result.documents.map(d => d.number), ['00000101', '00000102']);
  assert.equal((await getTransmission(env, 'other', result.id)).status, 404);
  const token = messages[0].text.match(/\/portal#([\w-]+)/)[1];
  const headers = { origin: 'https://example.test', 'cf-connecting-ip': '192.0.2.1', 'content-type': 'application/json' };
  const get = cookie => portal(new Request('https://example.test/portal/document', { headers: cookie ? { cookie } : {} }), env);
  assert.equal((await get()).status, 404);
  const exchange = await portal(new Request('https://example.test/portal/exchange', { method: 'POST', headers, body: JSON.stringify({ token }) }), env);
  const cookie = exchange.headers.get('set-cookie').split(';')[0];
  const bytes = new Uint8Array(await (await get(cookie)).arrayBuffer());
  assert.deepEqual(bytes, objects.get(`outbound/${result.id}/document.pdf`));
  const packet = await PDFDocument.load(bytes);
  assert.deepEqual(packet.getPages().map(p => p.getWidth()), [612, 600, 601]);
  if (stamped) for (const [i, page] of packet.getPages().entries()) assert.ok(pageContents(page).includes(hex(i < 2 ? 'Document 00000101' : 'Document 00000102')));
  const encrypted = [...objects.entries()].find(([key]) => key.startsWith('portal/'))[1];
  assert.notDeepEqual(encrypted, bytes);
  assert.equal((await revokeEmailDelivery(jsonRequest('/x', {}), env, 'other', result.id, result.deliveries[0].id)).status, 404);
  assert.equal((await revokeEmailDelivery(jsonRequest('/x', {}), env, actor, result.id, result.deliveries[0].id)).status, 200);
  assert.equal((await get(cookie)).status, 404);
});

test('email intent commits atomically with transmission and remains visible if invocation fails', async () => {
  const { env, db } = portalEnv();
  db.exec("CREATE TRIGGER fail_claim BEFORE UPDATE OF status ON email_attempts BEGIN SELECT RAISE(ABORT, 'injected'); END");
  await createTransmission(await emailRequest(), env, actor);
  const row = db.prepare('SELECT t.id, a.status FROM transmissions t JOIN email_attempts a ON a.transmission_id = t.id').get();
  assert.equal(row.status, 'pending');
  assert.equal((await (await getTransmission(env, actor, row.id)).json()).deliveries.find(d => d.channel === 'email').status, 'unknown');
});
test('failure inserting email intent rolls back the transmission batch', async () => {
  const { env, db } = portalEnv();
  db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON email_attempts BEGIN SELECT RAISE(ABORT, 'injected'); END");
  await assert.rejects(createTransmission(await emailRequest(), env, actor));
  assert.equal(db.prepare('SELECT count(*) AS n FROM transmissions').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM email_attempts').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM envelope_documents').get().n, 0);
});

const pageContents = page => Buffer.from(decodePDFRawStream(page.node.Contents().lookup(0)).decode()).toString('ascii');
const hex = value => Buffer.from(value).toString('hex').toUpperCase();

for (const headers of [false, true]) test(`ordered fax and mail payloads ${headers ? 'with' : 'without'} page headers`, async () => {
  const { env, objects, queue } = makeEnv();
  const spec = { fax: { recipients: [faxSpec.fax.recipients[0]], cover: { includeNumbers: true } }, mail: { to: address, from: address } };
  // Duplicate filenames do not collapse distinct parts; order is not sorted by name or page count.
  const files = [await pdfFile('z.pdf', [612, 600], true), await pdfFile('a.pdf', [601], true), await pdfFile('a.pdf', [602])];
  const response = await createTransmission(await sendRequest(spec, files, undefined, headers ? 'numberedDocuments' : 'documents'), env, actor);
  assert.equal(response.status, 202);
  const { id, envelopeNumber, documents, deliveries } = await response.json();
  assert.equal(envelopeNumber, '000001');
  assert.deepEqual(documents, [
    { name: 'z.pdf', pageCount: 2, position: 1, number: '00000101' },
    { name: 'a.pdf', pageCount: 1, position: 2, number: '00000102' },
    { name: 'a.pdf', pageCount: 1, position: 3, number: '00000103' },
  ]);
  const detail = await (await getTransmission(env, actor, id)).json();
  assert.deepEqual(detail.documents, documents);
  assert.equal(detail.envelopeNumber, envelopeNumber);
  const source = objects.get(`outbound/${id}/document.pdf`);
  const expectedNumbers = [documents[0].number, documents[0].number, documents[1].number, documents[2].number];
  const checkPacket = (pdf, cover = false) => {
    const pages = pdf.getPages().slice(cover ? 1 : 0);
    assert.deepEqual(pages.map(p => p.getWidth()), [612, 600, 601, 602]);
    for (const [i, page] of pages.entries()) {
      if (!headers) {
        assert.ok(i === 3 || !pageContents(page).includes(hex('Document ')));
        continue;
      }
      const text = pageContents(page);
      assert.ok(text.includes(hex(`Document ${expectedNumbers[i]}`)));
      assert.equal(text.includes('/EmbeddedPdfPage-'), i < 3, 'the blank page gets the header only');
      assert.equal(page.node.has(PDFName.of('Metadata')), false);
      if (i < 3) {
        const xobjects = page.node.Resources().lookup(PDFName.of('XObject'));
        const form = xobjects.lookup(xobjects.keys()[0]);
        const original = Buffer.from(decodePDFRawStream(form).decode()).toString('ascii');
        assert.ok(original.includes(hex(`Original page ${i === 1 ? 2 : 1}`)));
        assert.ok(text.includes('1 0 0 1 12 776 Tm'), 'the header starts above the 768-point content area');
      }
    }
  };
  const packet = await PDFDocument.load(source, { updateMetadata: false });
  checkPacket(packet);
  assert.notEqual(packet.getTitle(), 'PRIVATE_SOURCE_METADATA');
  if (headers) {
    const streams = packet.context.enumerateIndirectObjects().map(([, object]) => object).filter(object => object.contents);
    assert.ok(streams.every(stream => !Buffer.from(decodePDFRawStream(stream).decode()).includes('PRIVATE_PAGE_METADATA')));
  }
  const doc = await getTransmissionFile(env, actor, id, 'document');
  assert.deepEqual(new Uint8Array(await doc.arrayBuffer()), source);
  assert.equal(queue.sent.length, 1);

  const mailId = deliveries.find(d => d.channel === 'mail').id;
  const review = await (await reviewMail(new Request('https://example.test/x?mode=test'), env, actor, id, mailId)).json();
  assert.equal(review.pageCount, 4);
  assert.equal((await approveMail(jsonRequest('/x', { confirmed: true, mode: 'test', reviewHash: review.reviewHash }), env, actor, id, mailId)).status, 202);
  const calls = [];
  const checked = [];
  const fetcher = async (url, { body }) => {
    calls.push(url);
    if (url === 'https://api.telnyx.com/v2/media') {
      const faxPdf = await PDFDocument.load(await body.get('media').arrayBuffer());
      checkPacket(faxPdf, true);
      const content = pageContents(faxPdf.getPage(0));
      for (const number of [envelopeNumber, ...documents.map(d => d.number)]) {
        assert.ok(content.includes(hex(number)));
      }
      checked.push('fax');
      return Response.json({ data: { media_name: body.get('media_name') } });
    }
    if (url === 'https://api.telnyx.com/v2/faxes') return Response.json({ data: { id: 'fax_synthetic' } }, { status: 202 });
    if (url === 'https://api.postgrid.com/print-mail/v1/letters') {
      const pdf = new Uint8Array(await body.get('pdf').arrayBuffer());
      assert.deepEqual(pdf, source, 'exact PDF bound to the mail review');
      checkPacket(await PDFDocument.load(pdf));
      checked.push('mail');
      return Response.json({ object: 'letter', id: 'letter_synthetic' }, { status: 201 });
    }
    throw new Error(`Unexpected local test URL: ${url}`);
  };
  for (const message of queue.sent) assert.equal(await processDelivery(env, message, 1, fetcher), 'ack');
  assert.deepEqual(calls, ['https://api.telnyx.com/v2/media', 'https://api.telnyx.com/v2/faxes', 'https://api.postgrid.com/print-mail/v1/letters']);
  assert.deepEqual(checked, ['fax', 'mail']);
});

test('header opt-in fails before storage or queueing for rotated, cropped, or interactive pages', async () => {
  const { env, db, objects, queue } = makeEnv();
  const spec = { mail: { to: address, from: address } };
  for (const edit of [
    (_pdf, page) => page.setRotation(degrees(90)),
    (_pdf, page) => page.setCropBox(0, 0, 400, 600),
    (pdf, page) => pdf.getForm().createTextField('input').addToPage(page),
  ]) {
    const pdf = await PDFDocument.create();
    edit(pdf, pdf.addPage());
    const response = await createTransmission(await sendRequest(spec, [new File([await pdf.save()], 'Example.pdf')], undefined, 'numberedDocuments'), env, actor);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /page headers|interactive/);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM envelope_numbers').get().n, 0);
  assert.equal(objects.size, 0);
  assert.equal(queue.sent.length, 0);
});

test('one unnumbered PDF is unchanged; opting in stamps one PDF without adding a page', async () => {
  const { env, objects } = makeEnv();
  const spec = { mail: { to: address, from: address } };
  const bytes = await samplePdf(2);
  const plain = await (await createTransmission(await sendRequest(spec, bytes), env, actor)).json();
  assert.deepEqual(objects.get(`outbound/${plain.id}/document.pdf`), bytes);
  const stamped = await (await createTransmission(await sendRequest(spec, [new File([bytes], 'Example.pdf')], undefined, 'numberedDocuments'), env, actor)).json();
  const pdf = await PDFDocument.load(objects.get(`outbound/${stamped.id}/document.pdf`));
  assert.equal(pdf.getPageCount(), 2);
  for (const page of pdf.getPages()) assert.ok(pageContents(page).includes(hex('Document 00000201')));
});

test('header processing rejects oversized decoded streams and mixed upload fields without sending', async () => {
  const { env, objects, queue } = makeEnv();
  const spec = { fax: { ...faxSpec.fax, cover: { enabled: false } } };
  const pdf = await PDFDocument.create();
  const stream = pdf.context.flateStream(new Uint8Array(16 * 1024 * 1024 + 1).fill(32));
  pdf.addPage().node.addContentStream(pdf.context.register(stream));
  const file = new File([await pdf.save()], 'Example.pdf');
  const request = await sendRequest(spec, [file], undefined, 'numberedDocuments');
  const response = await createTransmission(request, env, actor);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /too complex/);
  const form = new FormData();
  form.set('spec', JSON.stringify(spec));
  form.set('document', file);
  form.set('numberedDocuments', file);
  const url = 'https://example.test/api/transmissions';
  const mixed = new Request(url, { method: 'POST', body: form, headers: { origin: new URL(url).origin } });
  assert.equal((await createTransmission(mixed, env, actor)).status, 400);
  assert.equal(objects.size, 0);
  assert.equal(queue.sent.length, 0);
});

test('blocks excessive, non-PDF and interactive multipart inputs before allocating a number or writing objects', async () => {
  const { env, db, objects, queue } = makeEnv();
  const plain = await pdfFile('normal.pdf', [612]);
  const interactive = await PDFDocument.create();
  const page = interactive.addPage();
  interactive.getForm().createTextField('name').addToPage(page);
  const formFile = new File([await interactive.save()], 'form.pdf');
  const big = new File([new Uint8Array(3 * 1024 * 1024)], 'large.pdf');
  const long = await pdfFile('long.pdf', Array(100).fill(612));
  for (const [files, error] of [
    [Array(11).fill(plain), /1 to 10/],
    [[plain, new File(['x'], 'fake.pdf')], /PDF files only/],
    [[big, big], /5 MB/],
    [[long, plain], /100 pages/],
    [[formFile], /interactive/],
  ]) {
    const response = await createTransmission(await sendRequest(faxSpec, files), env, actor);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, error);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM envelope_numbers').get().n, 0);
  assert.equal(objects.size, 0);
  assert.equal(queue.sent.length, 0);
});

test('legacy records remain readable by UUID and are not renumbered', async () => {
  const { env, db } = makeEnv();
  const id = crypto.randomUUID(), key = `outbound/${id}/document.pdf`;
  const now = new Date().toISOString();
  db.prepare('INSERT INTO transmissions VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, actor, 'Legacy', key, 1, now, now);
  const bytes = await samplePdf(1);
  await env.FILES.put(key, bytes);
  const detail = await (await getTransmission(env, actor, id)).json();
  assert.equal(detail.envelopeNumber, null);
  assert.deepEqual(detail.documents, []);
  assert.deepEqual(new Uint8Array(await (await getTransmissionFile(env, actor, id, 'document')).arrayBuffer()), bytes);
});

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
  const { env } = portalEnv(messages);
  const response = await createTransmission(await emailRequest(), env, actor);
  const result = await response.json();
  assert.equal(response.status, 202); assert.equal(result.deliveries[0].status, 'accepted'); assert.equal(messages.length, 1);
  const detail = await (await getTransmission(env, actor, result.id)).json();
  assert.equal(detail.deliveries[0].channel, 'email'); assert.equal(detail.deliveries[0].status, 'accepted');
  assert.equal(detail.settled, true);
  assert.equal((await (await listTransmissions(env, actor)).json()).transmissions[0].channels[0].channel, 'email');
  assert.equal((await getTransmission(env, 'someone-else', result.id)).status, 404);
});

test('disabled, cross-origin, and legacy-field email submission cannot write or enqueue any channel', async () => {
  const messages = [];
  const { env, objects, db, queue } = portalEnv(messages);
  const mixed = { ...emailSpec, ...faxSpec };
  const foreign = await emailRequest(mixed);
  foreign.headers.set('origin', 'https://elsewhere.test');
  assert.equal((await createTransmission(foreign, env, actor)).status, 403);
  assert.equal((await createTransmission(await sendRequest(mixed, await samplePdf(1)), env, actor)).status, 400);
  env.PORTAL_ENABLED = 'false';
  assert.equal((await createTransmission(await emailRequest(mixed), env, actor)).status, 503);
  assert.equal(db.prepare('SELECT count(*) AS n FROM transmissions').get().n, 0);
  assert.equal(objects.size, 0);
  assert.equal(queue.sent.length + messages.length, 0);
});

test('Worker recipient routes never authorize adjacent paths or owner APIs', async () => {
  const { env } = portalEnv();
  const worker = createWorker();
  for (const path of ['/portal/', '/portal%2fstatus', '/portal/status/extra', '/portal/../api/records', '/api/portal-capability', '/api/transmissions', `/api/transmissions/${crypto.randomUUID()}/email`]) {
    assert.equal((await worker.fetch(new Request(`https://example.test${path}`), env)).status, 401, path);
  }
  assert.equal((await worker.fetch(new Request('https://example.test/portal'), env)).status, 200);
  assert.equal((await worker.fetch(new Request('https://example.test/portal/status'), env)).status, 404);
});
