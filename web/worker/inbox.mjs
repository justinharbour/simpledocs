import { setHeard } from './voice-calls.mjs';
import { markThreadRead } from './sms.mjs';

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (value, status = 200) => Response.json(value, { status, headers });
const KINDS = ['fax', 'voicemail', 'call', 'sms'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9]\d{1,14}$/;
const isoTime = value => (typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(' ', 'T')}Z` : value ?? null);
const snippet = (text, max = 140) => { const t = String(text ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

const FAX_WHERE = "event_type = 'fax.received' AND object_key IS NOT NULL";
const FAX_UNREAD = "NOT EXISTS (SELECT 1 FROM inbox_reads r WHERE r.kind = 'fax' AND r.id = inbound_fax_events.event_id)";
const CALL_WHERE = "direction = 'inbound' AND outcome = 'missed'";
const CALL_UNREAD = "NOT EXISTS (SELECT 1 FROM inbox_reads r WHERE r.kind = 'call' AND r.id = calls.call_control_id)";

// Each loader returns up to `limit` newest items of one kind, in the shared item shape.
const loaders = {
  async fax(db, unread, limit) {
    const rows = await db.prepare(`SELECT event_id, fax_id, received_at, ${FAX_UNREAD} AS unread FROM inbound_fax_events WHERE ${FAX_WHERE}${unread ? ` AND ${FAX_UNREAD}` : ''} ORDER BY received_at DESC, event_id DESC LIMIT ?`).bind(limit).all();
    return (rows.results ?? []).map(r => ({ kind: 'fax', id: r.event_id, title: 'Fax received', preview: 'PDF document', at: isoTime(r.received_at), unread: !!r.unread, previewUrl: `/api/inbound-faxes/${r.event_id}/pdf?inline=1`, downloadUrl: `/api/inbound-faxes/${r.event_id}/pdf` }));
  },
  async voicemail(db, unread, limit) {
    const rows = await db.prepare(`SELECT recording_id, archived_at, from_number, to_number, duration_secs, heard_at, transcript FROM voice_recordings WHERE kind = 'voicemail'${unread ? ' AND heard_at IS NULL' : ''} ORDER BY archived_at DESC, recording_id DESC LIMIT ?`).bind(limit).all();
    return (rows.results ?? []).map(r => ({ kind: 'voicemail', id: r.recording_id, title: r.from_number ?? 'Unknown caller', preview: r.transcript ? snippet(r.transcript) : 'No transcript yet', at: isoTime(r.archived_at), unread: !r.heard_at, from: r.from_number, to: r.to_number, durationSecs: r.duration_secs, transcript: r.transcript, previewUrl: `/api/voice/recordings/${r.recording_id}`, downloadUrl: `/api/voice/recordings/${r.recording_id}?download=1` }));
  },
  async call(db, unread, limit) {
    const rows = await db.prepare(`SELECT call_control_id, from_number, to_number, started_at, hangup_cause, ${CALL_UNREAD} AS unread FROM calls WHERE ${CALL_WHERE}${unread ? ` AND ${CALL_UNREAD}` : ''} ORDER BY started_at DESC, call_control_id DESC LIMIT ?`).bind(limit).all();
    return (rows.results ?? []).map(r => ({ kind: 'call', id: r.call_control_id, title: r.from_number ?? 'Unknown caller', preview: 'Missed call, no voicemail left', at: r.started_at, unread: !!r.unread, from: r.from_number, to: r.to_number, hangupCause: r.hangup_cause }));
  },
  async sms(db, unread, limit) {
    const rows = await db.prepare(`SELECT m.peer, m.body, m.created_at,
      (SELECT COUNT(*) FROM sms_messages u WHERE u.peer = m.peer AND u.direction = 'inbound' AND u.read_at IS NULL) AS unread_count
      FROM sms_messages m WHERE m.id = (SELECT x.id FROM sms_messages x WHERE x.peer = m.peer AND x.direction = 'inbound' ORDER BY x.created_at DESC, x.id DESC LIMIT 1)
      ${unread ? "AND EXISTS (SELECT 1 FROM sms_messages u WHERE u.peer = m.peer AND u.direction = 'inbound' AND u.read_at IS NULL)" : ''}
      ORDER BY m.created_at DESC LIMIT ?`).bind(limit).all();
    return (rows.results ?? []).map(r => ({ kind: 'sms', id: r.peer, title: r.peer, preview: snippet(r.body), at: r.created_at, unread: r.unread_count > 0, unreadCount: r.unread_count, from: r.peer }));
  },
};

const counters = {
  fax: db => db.prepare(`SELECT COUNT(*) AS n FROM inbound_fax_events WHERE ${FAX_WHERE} AND ${FAX_UNREAD}`).first(),
  voicemail: db => db.prepare("SELECT COUNT(*) AS n FROM voice_recordings WHERE kind = 'voicemail' AND heard_at IS NULL").first(),
  call: db => db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE ${CALL_WHERE} AND ${CALL_UNREAD}`).first(),
  sms: db => db.prepare("SELECT COUNT(DISTINCT peer) AS n FROM sms_messages WHERE direction = 'inbound' AND read_at IS NULL").first(),
};

// Existence checks keep a stray id from creating read rows; each returns the id's validity.
const exists = {
  fax: async (db, id) => UUID.test(id) && !!await db.prepare(`SELECT 1 AS y FROM inbound_fax_events WHERE event_id = ? AND ${FAX_WHERE}`).bind(id).first(),
  call: async (db, id) => !!await db.prepare(`SELECT 1 AS y FROM calls WHERE call_control_id = ? AND ${CALL_WHERE}`).bind(id).first(),
  voicemail: async (db, id) => UUID.test(id) && !!await db.prepare("SELECT 1 AS y FROM voice_recordings WHERE recording_id = ? AND kind = 'voicemail'").bind(id).first(),
  sms: async (db, id) => E164.test(id) && !!await db.prepare("SELECT 1 AS y FROM sms_messages WHERE peer = ? AND direction = 'inbound' LIMIT 1").bind(id).first(),
};

async function setRead(db, kind, id, read) {
  if (kind === 'voicemail') await setHeard(db, id, read);
  else if (kind === 'sms') await markThreadRead(db, id, read);
  else if (read) await db.prepare('INSERT OR IGNORE INTO inbox_reads (kind, id, read_at) VALUES (?, ?, ?)').bind(kind, id, new Date().toISOString()).run();
  else await db.prepare('DELETE FROM inbox_reads WHERE kind = ? AND id = ?').bind(kind, id).run();
}

async function readAll(db, kind) {
  const now = new Date().toISOString();
  if (kind === 'fax') await db.prepare(`INSERT OR IGNORE INTO inbox_reads (kind, id, read_at) SELECT 'fax', event_id, ? FROM inbound_fax_events WHERE ${FAX_WHERE}`).bind(now).run();
  else if (kind === 'call') await db.prepare(`INSERT OR IGNORE INTO inbox_reads (kind, id, read_at) SELECT 'call', call_control_id, ? FROM calls WHERE ${CALL_WHERE}`).bind(now).run();
  else if (kind === 'voicemail') await db.prepare("UPDATE voice_recordings SET heard_at = ? WHERE kind = 'voicemail' AND heard_at IS NULL").bind(now).run();
  else await db.prepare("UPDATE sms_messages SET read_at = ? WHERE direction = 'inbound' AND read_at IS NULL").bind(now).run();
}

// `allowed` says which kinds this actor may see: fax follows the inbound-fax allow list, voice and SMS the voice owner.
export async function handleInbox(request, env, allowed) {
  if (!env.DB) return json({ error: 'Storage unavailable' }, 503);
  const url = new URL(request.url);
  const visible = KINDS.filter(k => (k === 'fax' ? allowed.fax : allowed.voice));
  try {
    if (url.pathname === '/api/inbox') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const type = url.searchParams.get('type');
      if (type && !KINDS.includes(type)) return json({ error: 'Unknown type' }, 400);
      const filter = url.searchParams.get('filter') ?? 'all';
      if (!['all', 'unread'].includes(filter)) return json({ error: 'Unknown filter' }, 400);
      const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);
      const kinds = visible.filter(k => !type || k === type);
      const lists = await Promise.all(kinds.map(k => loaders[k](env.DB, filter === 'unread', limit)));
      const items = lists.flat().sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.id).localeCompare(String(a.id))).slice(0, limit);
      return json({ items });
    }
    if (url.pathname === '/api/inbox/count') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const byKind = Object.fromEntries(KINDS.map(k => [k, 0]));
      for (const k of visible) byKind[k] = (await counters[k](env.DB))?.n ?? 0;
      return json({ unread: Object.values(byKind).reduce((a, b) => a + b, 0), byKind });
    }
    const isPost = request.method === 'POST';
    const mutates = /^\/api\/inbox\/(read-all|[^/]+\/[^/]+\/(read|unread))$/.test(url.pathname);
    if (mutates && !isPost) return json({ error: 'Method not allowed' }, 405);
    if (mutates && request.headers.get('origin') !== url.origin) return json({ error: 'Invalid origin' }, 403);
    if (url.pathname === '/api/inbox/read-all') {
      const kind = url.searchParams.get('kind');
      if (kind && !KINDS.includes(kind)) return json({ error: 'Unknown type' }, 400);
      for (const k of visible.filter(v => !kind || v === kind)) await readAll(env.DB, k);
      return json({ ok: true });
    }
    const item = /^\/api\/inbox\/([^/]+)\/([^/]+)\/(read|unread)$/.exec(url.pathname);
    if (!item) return json({ error: 'Not found' }, 404);
    const kind = item[1];
    let id;
    try { id = decodeURIComponent(item[2]); } catch { return json({ error: 'Not found' }, 404); }
    if (!visible.includes(kind) || !await exists[kind](env.DB, id)) return json({ error: 'Not found' }, 404);
    await setRead(env.DB, kind, id, item[3] === 'read');
    return json({ kind, id, unread: item[3] === 'unread' });
  } catch { return json({ error: 'Inbox unavailable' }, 503); }
}
