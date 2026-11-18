import { recoverInboundFax } from './inbound-fax.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
function authorized(actor, configured) {
  if (configured === undefined) return typeof actor === 'string' && actor.length > 0;
  try {
    const subjects = JSON.parse(configured);
    return typeof actor === 'string' && Array.isArray(subjects) && subjects.length > 0 && subjects.every(s => typeof s === 'string' && s.length > 0 && s === s.trim()) && subjects.includes(actor);
  } catch { return false; }
}

// This handler is reached only after the Worker has verified the Access JWT.
export async function handleFaxOperator(request, env, actor, eventId, recover = recoverInboundFax) {
  if (!authorized(actor, env.INBOUND_FAX_OPERATOR_SUBJECTS)) return reply({ error: 'Forbidden' }, 403);
  if (env.TELNYX_FAX_RECOVERY_ENABLED !== 'true' || env.TELNYX_INBOUND_FAX_ENABLED !== 'true' || !env.DB) return reply({ error: 'Recovery unavailable' }, 503);
  if (!eventId) {
    if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
    try {
      const rows = await env.DB.prepare('SELECT event_id, fax_id, occurred_at, received_at FROM inbound_fax_unarchived ORDER BY received_at, event_id LIMIT 100').all();
      if (!rows.success || !Array.isArray(rows.results)) throw Error();
      return reply({ pending: rows.results });
    } catch { return reply({ error: 'Recovery unavailable' }, 503); }
  }
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ error: 'Forbidden' }, 403);
  if (!UUID.test(eventId)) return reply({ error: 'Not found' }, 404);
  try {
    const archived = await recover(env, eventId);
    return archived ? reply({ status: 'archived' }) : reply({ error: 'Recovery did not complete; pending receipt requires investigation' }, 503);
  } catch { return reply({ error: 'Recovery unavailable' }, 503); }
}
