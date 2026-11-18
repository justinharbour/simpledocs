import { applyFaxDeliveryEvent } from './fax-intents.mjs';
import { pushLater } from './push.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reply = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

// Poll the provider using its authenticated API. Never infer delivery from
// acceptance, a failed lookup, or a status belonging to another fax.
export async function handleFaxStatus(request, env, actor, id, fetcher = fetch) {
  if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
  if (!UUID.test(id)) return reply({ error: 'Invalid fax ID' }, 400);
  if (!env.DB) return reply({ error: 'Fax storage unavailable' }, 503);
  let row = await env.DB.prepare('SELECT status, provider_id FROM fax_intents WHERE id = ? AND actor_id = ?').bind(id, actor).first();
  if (!row) return reply({ error: 'Not found' }, 404);
  if (row.status === 'accepted' && row.provider_id && env.TELNYX_API_TOKEN) {
    try {
      const response = await fetcher(`https://api.telnyx.com/v2/faxes/${encodeURIComponent(row.provider_id)}`, {
        headers: { Authorization: `Bearer ${env.TELNYX_API_TOKEN}`, Accept: 'application/json' }, redirect: 'manual',
      });
      if (response.ok) {
        const data = (await response.json())?.data;
        if (data?.id === row.provider_id && ['delivered', 'failed'].includes(data.status)) {
          const applied = await applyFaxDeliveryEvent(env.DB, { providerId: row.provider_id, status: data.status });
          // Queued sends push from deliveries.mjs when the delivery turns failed.
          if (applied === 'updated' && data.status === 'failed' && !await env.DB.prepare('SELECT 1 AS found FROM dispatches WHERE id = ?').bind(id).first()) pushLater(env, { kind: 'fax-failed', id });
          row = await env.DB.prepare('SELECT status, provider_id FROM fax_intents WHERE id = ? AND actor_id = ?').bind(id, actor).first();
        }
      }
    } catch {
      // Keep the last known status; a later read may reconcile it.
    }
  }
  return reply({ id, status: row.status });
}
