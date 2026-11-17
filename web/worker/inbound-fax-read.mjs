const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (value, status = 200) => Response.json(value, { status, headers });

// Subjects are explicitly authorized for this shared inbox, independently of
// merely possessing an Access assertion. No client-provided actor is accepted.
function authorized(actor, configured) {
  try {
    const subjects = JSON.parse(configured);
    return typeof actor === 'string' && Array.isArray(subjects) && subjects.length > 0 && subjects.every(s => typeof s === 'string' && s.trim() === s && s.length > 0) && subjects.includes(actor);
  } catch { return false; }
}

export async function handleInboundFaxRead(request, env, actor, eventId) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!authorized(actor, env.INBOUND_FAX_ALLOWED_SUBJECTS)) return json({ error: 'Forbidden' }, 403);
  if (!env.DB || (eventId && !env.FAX_MEDIA)) return json({ error: 'Storage unavailable' }, 503);
  if (eventId && !UUID.test(eventId)) return json({ error: 'Not found' }, 404);
  try {
    if (!eventId) {
      const result = await env.DB.prepare("SELECT event_id, fax_id, occurred_at, received_at FROM inbound_fax_events WHERE event_type = 'fax.received' AND object_key IS NOT NULL ORDER BY received_at DESC, event_id DESC LIMIT 100").all();
      if (!result.success || !Array.isArray(result.results)) throw new Error();
      return json({ records: result.results.map(row => ({ id: row.event_id, faxId: row.fax_id, occurredAt: row.occurred_at, receivedAt: row.received_at })) });
    }
    const row = await env.DB.prepare("SELECT object_key FROM inbound_fax_events WHERE event_id = ? AND event_type = 'fax.received'").bind(eventId).first();
    if (!row?.object_key) return json({ error: 'Not found' }, 404);
    // Object keys are internal DB references, not caller-controlled paths.
    if (!/^inbound-fax\/[0-9a-f-]{36}\/[0-9a-f-]{36}(?:\/[0-9a-f]{64})?\.pdf$/i.test(row.object_key)) throw new Error();
    const object = await env.FAX_MEDIA.get(row.object_key);
    if (!object?.body) return json({ error: 'Media unavailable' }, 503);
    return new Response(object.body, { headers: { ...headers, 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="fax.pdf"', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
  } catch { return json({ error: 'Storage unavailable' }, 503); }
}
