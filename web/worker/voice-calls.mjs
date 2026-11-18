const DIRECTIONS = { incoming: 'inbound', inbound: 'inbound', outgoing: 'outbound', outbound: 'outbound' };
const num = value => (typeof value === 'string' && value.length <= 64 ? value : null);
const secondsBetween = (from, to) => {
  const a = Date.parse(from), b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 1000) : null;
};

// Idempotent and order-independent: Telnyx may redeliver or reorder events.
export async function recordCall(db, event, payload) {
  const id = payload.call_control_id, at = event.occurred_at, now = new Date().toISOString();
  const direction = DIRECTIONS[payload.direction] ?? 'inbound';
  await db.prepare('INSERT INTO calls (call_control_id, direction, from_number, to_number, started_at, outcome, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(call_control_id) DO NOTHING')
    .bind(id, direction, num(payload.from), num(payload.to), at, 'ringing', now).run();
  if (event.event_type === 'call.initiated') {
    // An earlier-arriving later event may have created the row with a later start.
    await db.prepare('UPDATE calls SET started_at = ?, updated_at = ? WHERE call_control_id = ? AND started_at > ?').bind(at, now, id, at).run();
  } else if (event.event_type === 'call.answered') {
    await db.prepare("UPDATE calls SET answered_at = COALESCE(answered_at, ?), outcome = CASE WHEN outcome = 'ringing' THEN 'answered' ELSE outcome END, updated_at = ? WHERE call_control_id = ?").bind(at, now, id).run();
  } else if (event.event_type === 'call.hangup') {
    const call = await db.prepare('SELECT direction, started_at, answered_at, ended_at FROM calls WHERE call_control_id = ?').bind(id).first();
    if (!call || call.ended_at) return;
    const voicemail = await db.prepare('SELECT 1 AS yes FROM voicemail_calls WHERE call_control_id = ?').bind(id).first();
    const duration = call.answered_at ? secondsBetween(call.answered_at, at) : 0;
    const outcome = voicemail ? 'voicemail' : call.answered_at ? 'answered' : call.direction === 'inbound' ? 'missed' : 'no answer';
    await db.prepare('UPDATE calls SET ended_at = ?, duration_secs = ?, hangup_cause = ?, outcome = ?, updated_at = ? WHERE call_control_id = ? AND ended_at IS NULL')
      .bind(at, duration, num(payload.hangup_cause), outcome, now, id).run();
  }
}

export async function recordingMeta(db, payload) {
  const call = await db.prepare('SELECT direction, from_number, to_number FROM calls WHERE call_control_id = ?').bind(payload.call_control_id).first();
  const duration = secondsBetween(payload.recording_started_at, payload.recording_ended_at);
  return {
    direction: call?.direction ?? DIRECTIONS[payload.direction] ?? null,
    from: call?.from_number ?? num(payload.from), to: call?.to_number ?? num(payload.to),
    duration,
  };
}

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export async function listCalls(request, env) {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers });
  if (!env.DB) return new Response('Unavailable', { status: 503, headers });
  try {
    const rows = await env.DB.prepare('SELECT call_control_id, direction, from_number, to_number, started_at, answered_at, ended_at, duration_secs, hangup_cause, outcome FROM calls ORDER BY started_at DESC, call_control_id DESC LIMIT 100').bind().all();
    return Response.json({ calls: (rows.results ?? []).map(r => ({ id: r.call_control_id, direction: r.direction, from: r.from_number, to: r.to_number, startedAt: r.started_at, answeredAt: r.answered_at, endedAt: r.ended_at, durationSecs: r.duration_secs, hangupCause: r.hangup_cause, outcome: r.outcome })) }, { headers });
  } catch { return new Response('Unavailable', { status: 503, headers }); }
}

export async function markHeard(request, env, id) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers });
  if (request.headers.get('origin') !== new URL(request.url).origin) return new Response('Invalid origin', { status: 403, headers });
  if (!env.DB) return new Response('Unavailable', { status: 503, headers });
  try {
    await env.DB.prepare('UPDATE voice_recordings SET heard_at = COALESCE(heard_at, ?) WHERE recording_id = ?').bind(new Date().toISOString(), id).run();
    return Response.json({ id, heard: true }, { headers });
  } catch { return new Response('Unavailable', { status: 503, headers }); }
}
