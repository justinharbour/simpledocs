import { tvActor } from './tv-pairing.mjs';
import { inboundFaxAllowed } from './inbound-fax-read.mjs';
import { loadAvailability, availabilityOnline } from './availability-policy.mjs';
import { phoneOnline } from './voice-presence.mjs';

// Read-only TV API. Every route needs a valid TV bearer token; the token resolves
// to the owner actor, and the same owner rules as the web app apply.
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (body, status = 200) => Response.json(body, { status, headers });
const PAGE = 50;
const DOC = /^(t|f):([0-9a-f-]{36})$/i;
const isoTime = value => (typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(' ', 'T')}Z` : value ?? null);
async function dashboard(env, actor) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const faxAllowed = inboundFaxAllowed(actor, env.INBOUND_FAX_ALLOWED_SUBJECTS);
  const voiceAllowed = !env.VOICE_OWNER_SUBJECT || actor === env.VOICE_OWNER_SUBJECT;
  const calls = voiceAllowed ? await env.DB.prepare('SELECT outcome, COUNT(*) AS n FROM calls WHERE started_at >= ? GROUP BY outcome').bind(since).all() : { results: [] };
  const byOutcome = Object.fromEntries((calls.results ?? []).map(r => [r.outcome, r.n]));
  // A missed hangup webhook would leave a row ringing; only recent unended calls count as live.
  if (voiceAllowed) byOutcome.ringing = (await env.DB.prepare("SELECT COUNT(*) AS n FROM calls WHERE outcome = 'ringing' AND ended_at IS NULL AND started_at >= ?").bind(new Date(Date.now() - 120000).toISOString()).first())?.n ?? 0;
  const unreadFax = faxAllowed ? (await env.DB.prepare("SELECT COUNT(*) AS n FROM inbound_fax_events WHERE event_type = 'fax.received' AND object_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inbox_reads r WHERE r.kind = 'fax' AND r.id = inbound_fax_events.event_id)").first())?.n ?? 0 : 0;
  const unreadVoicemail = voiceAllowed ? (await env.DB.prepare("SELECT COUNT(*) AS n FROM voice_recordings WHERE kind = 'voicemail' AND heard_at IS NULL").first())?.n ?? 0 : 0;
  const pendingApprovals = (await env.DB.prepare("SELECT COUNT(*) AS n FROM dispatches d JOIN transmissions t ON t.id = d.transmission_id WHERE t.actor_id = ? AND d.status = 'awaiting_approval'").bind(actor).first())?.n ?? 0;
  const recentSends = await env.DB.prepare("SELECT t.id, t.title, t.created_at, d.channel, d.status FROM dispatches d JOIN transmissions t ON t.id = d.transmission_id WHERE t.actor_id = ? ORDER BY t.created_at DESC, d.id LIMIT 8").bind(actor).all();
  const policy = await loadAvailability(env.DB);
  const online = await phoneOnline(env.DB);
  return reply({
    generatedAt: new Date().toISOString(),
    phone: { online, availability: policy ? (availabilityOnline(policy) ? 'online' : 'offline') : 'unknown' },
    calls: { last24h: { ringing: byOutcome.ringing ?? 0, answered: byOutcome.answered ?? 0, missed: byOutcome.missed ?? 0, voicemail: byOutcome.voicemail ?? 0 } },
    inbox: { unreadFax, unreadVoicemail },
    pendingApprovals,
    recentSends: (recentSends.results ?? []).map(r => ({ id: r.id, title: r.title, createdAt: r.created_at, channel: r.channel, status: r.status })),
  });
}

// Cursor is an ISO time of the last item shown. Items are merged newest-first across sources.
async function activity(env, actor, url) {
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && !Number.isFinite(Date.parse(cursor))) return reply({ error: 'Invalid cursor' }, 400);
  const before = cursor ?? '9999-12-31T23:59:59.999Z';
  const faxAllowed = inboundFaxAllowed(actor, env.INBOUND_FAX_ALLOWED_SUBJECTS);
  const voiceAllowed = !env.VOICE_OWNER_SUBJECT || actor === env.VOICE_OWNER_SUBJECT;
  const [calls, voice, faxes, sends] = await Promise.all([
    voiceAllowed ? env.DB.prepare("SELECT call_control_id AS id, direction, from_number, started_at AS at, outcome FROM calls WHERE started_at < ? ORDER BY started_at DESC LIMIT ?").bind(before, PAGE).all() : { results: [] },
    voiceAllowed ? env.DB.prepare("SELECT recording_id AS id, from_number, archived_at AS at, kind FROM voice_recordings WHERE replace(archived_at, ' ', 'T') < ? ORDER BY archived_at DESC LIMIT ?").bind(before, PAGE).all() : { results: [] },
    faxAllowed ? env.DB.prepare("SELECT event_id AS id, received_at AS at FROM inbound_fax_events WHERE event_type = 'fax.received' AND object_key IS NOT NULL AND received_at < ? ORDER BY received_at DESC LIMIT ?").bind(before, PAGE).all() : { results: [] },
    env.DB.prepare('SELECT id, title, created_at AS at FROM transmissions WHERE actor_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?').bind(actor, before, PAGE).all(),
  ]);
  const items = [
    ...(calls.results ?? []).map(r => ({ kind: 'call', id: r.id, at: r.at, title: r.from_number ?? 'Unknown caller', outcome: r.outcome, direction: r.direction })),
    ...(voice.results ?? []).map(r => ({ kind: r.kind === 'voicemail' ? 'voicemail' : 'recording', id: r.id, at: isoTime(r.at), title: r.from_number ?? 'Unknown caller' })),
    ...(faxes.results ?? []).map(r => ({ kind: 'fax', id: r.id, at: r.at, title: 'Fax received' })),
    ...(sends.results ?? []).map(r => ({ kind: 'send', id: r.id, at: r.at, title: r.title })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, PAGE);
  const next = items.length === PAGE ? items[items.length - 1].at : null;
  return reply({ items, nextCursor: next });
}

async function documents(env, actor, url) {
  const type = url.searchParams.get('type');
  if (type && !['outbound', 'inbound'].includes(type)) return reply({ error: 'Unknown type' }, 400);
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  if ((from && !Number.isFinite(Date.parse(from))) || (to && !Number.isFinite(Date.parse(to)))) return reply({ error: 'Invalid date' }, 400);
  const lower = from ?? '0000-01-01', upper = to ?? '9999-12-31T23:59:59.999Z';
  const cursor = url.searchParams.get('cursor') ?? '9999-12-31T23:59:59.999Z';
  const out = [];
  if (!type || type === 'outbound') {
    const rows = await env.DB.prepare('SELECT id, title, page_count, created_at FROM transmissions WHERE actor_id = ? AND created_at >= ? AND created_at <= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?').bind(actor, lower, upper, cursor, PAGE).all();
    out.push(...(rows.results ?? []).map(r => ({ id: `t:${r.id}`, type: 'outbound', title: r.title, pageCount: r.page_count, at: r.created_at })));
  }
  if (!type || type === 'inbound') {
    if (inboundFaxAllowed(actor, env.INBOUND_FAX_ALLOWED_SUBJECTS)) {
      const rows = await env.DB.prepare("SELECT event_id, received_at FROM inbound_fax_events WHERE event_type = 'fax.received' AND object_key IS NOT NULL AND received_at >= ? AND received_at <= ? AND received_at < ? ORDER BY received_at DESC LIMIT ?").bind(lower, upper, cursor, PAGE).all();
      out.push(...(rows.results ?? []).map(r => ({ id: `f:${r.event_id}`, type: 'inbound', title: 'Fax received', pageCount: null, at: r.received_at })));
    }
  }
  const items = out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, PAGE);
  return reply({ items, nextCursor: items.length === PAGE ? items[items.length - 1].at : null });
}

async function documentPdf(env, actor, id) {
  const match = DOC.exec(id);
  if (!match || !env.DB || !env.FILES) return reply({ error: 'Not found' }, 404);
  let key = null;
  if (match[1] === 't') {
    const row = await env.DB.prepare('SELECT source_key FROM transmissions WHERE id = ? AND actor_id = ?').bind(match[2], actor).first();
    key = row?.source_key ?? null;
  } else if (inboundFaxAllowed(actor, env.INBOUND_FAX_ALLOWED_SUBJECTS)) {
    const row = await env.DB.prepare("SELECT object_key FROM inbound_fax_events WHERE event_id = ? AND event_type = 'fax.received' AND object_key IS NOT NULL").bind(match[2]).first();
    key = row?.object_key ?? null;
  }
  if (!key) return reply({ error: 'Not found' }, 404);
  const object = await env.FILES.get(key);
  if (!object) return reply({ error: 'Not found' }, 404);
  return new Response(object.body ?? await object.arrayBuffer(), { headers: { ...headers, 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="document.pdf"' } });
}

export async function tvApi(request, env) {
  if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
  if (!env.DB) return reply({ error: 'Storage unavailable' }, 503);
  const actor = await tvActor(request, env);
  if (!actor) return reply({ error: 'Unauthorized' }, 401);
  const url = new URL(request.url);
  try {
    if (url.pathname === '/tv/api/dashboard') return await dashboard(env, actor);
    if (url.pathname === '/tv/api/activity') return await activity(env, actor, url);
    if (url.pathname === '/tv/api/documents') return await documents(env, actor, url);
    const pdf = /^\/tv\/api\/documents\/([^/]+)\/pdf$/.exec(url.pathname);
    if (pdf) return await documentPdf(env, actor, pdf[1]);
    return reply({ error: 'Not found' }, 404);
  } catch { return reply({ error: 'Unavailable' }, 503); }
}
