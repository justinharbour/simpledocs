import { prepareFax, sendPreparedFax } from './fax-intents.mjs';
import { submitFax } from './telnyx-fax.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9]\d{1,14}$/;
const limit = 5 * 1024 * 1024;
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export async function handleFaxSend(request, env, actor, id, fetcher = fetch) {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ error: 'Invalid origin' }, 403);
  if (!UUID.test(id)) return reply({ error: 'Invalid fax ID' }, 400);
  const config = { enabled: env.FAX_ENABLED === 'true', token: env.TELNYX_API_TOKEN, connectionId: env.TELNYX_FAX_CONNECTION_ID, from: env.TELNYX_FAX_FROM };
  if (!env.DB || !config.enabled || !config.token || !config.connectionId || !E164.test(config.from ?? '')) return reply({ error: 'Fax sending unavailable' }, 503);
  const reader = request.body?.getReader();
  if (!reader) return reply({ error: 'Missing document' }, 400);
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit + 65536) { await reader.cancel(); return reply({ error: 'Document too large' }, 413); }
    chunks.push(value);
  }
  let form;
  try { form = await new Response(new Blob(chunks), { headers: { 'Content-Type': request.headers.get('content-type') || '' } }).formData(); }
  catch { return reply({ error: 'Invalid form' }, 400); }
  const destination = form.get('destination');
  const document = form.get('document');
  if (form.get('confirmed') !== 'true' || typeof destination !== 'string' || !E164.test(destination) ||
      !(document instanceof File) || document.size === 0 || document.size > limit || document.type !== 'application/pdf') return reply({ error: 'Provide a PDF, destination, and paid-send confirmation' }, 400);
  const bytes = new Uint8Array(await document.arrayBuffer());
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') return reply({ error: 'Invalid PDF' }, 400);

  // A unique media name prevents one user's document from replacing another's.
  // Upload is not a fax send; only the subsequent atomic claim can send.
  const existing = await env.DB.prepare('SELECT status FROM fax_intents WHERE id = ? AND actor_id = ?').bind(id, actor).first();
  if (existing) return reply({ id, status: existing.status }, 409);
  const mediaName = `simpledocs-${crypto.randomUUID()}.pdf`;
  const upload = new FormData();
  upload.set('media', document, 'document.pdf');
  upload.set('media_name', mediaName);
  upload.set('ttl_secs', '172800');
  try {
    const response = await fetcher('https://api.telnyx.com/v2/media', { method: 'POST', headers: { Authorization: `Bearer ${config.token}` }, body: upload, redirect: 'error' });
    if (!response.ok || (await response.json())?.data?.media_name !== mediaName) return reply({ error: 'Document upload failed; no fax was sent' }, 502);
  } catch { return reply({ error: 'Document upload failed; no fax was sent' }, 502); }
  if (!await prepareFax(env.DB, { id, actor, destination, mediaName })) return reply({ error: 'Fax ID already used' }, 409);
  const result = await sendPreparedFax(env.DB, { id, actor, config, confirmed: true }, input => submitFax(input, fetcher));
  return reply({ id, status: result.outcome }, result.outcome === 'accepted' ? 202 : 200);
}
