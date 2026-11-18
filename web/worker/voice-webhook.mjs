import { processVoicemail, isVoicemailRecording } from './voicemail.mjs';
import { pushLater } from './push.mjs';
import { recordCall, recordingMeta } from './voice-calls.mjs';
const MAX_BODY = 128 * 1024;
const MAX_AUDIO = 25 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = new Set(['call.initiated', 'call.ringing', 'call.answered', 'call.hangup', 'call.speak.ended', 'call.recording.saved', 'call.recording.transcription.saved']);
const MAX_TRANSCRIPT = 20000;

// Copies a transcript that arrived first onto the archived recording. Safe to repeat.
const applyTranscript = (db, id) => db.prepare("UPDATE voice_recordings SET transcript = (SELECT t.transcript FROM voice_transcripts t WHERE t.recording_id = voice_recordings.recording_id), transcript_at = datetime('now') WHERE recording_id = ? AND transcript IS NULL AND EXISTS (SELECT 1 FROM voice_transcripts t WHERE t.recording_id = voice_recordings.recording_id AND t.call_control_id = voice_recordings.call_control_id)").bind(id).run();
const reply = (status, message) => new Response(message, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

async function bounded(stream, limit) {
  if (!stream) throw new Error('missing body');
  const reader = stream.getReader(); const parts = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('too large'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

function decode64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('invalid base64');
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

async function verify(bytes, request, publicKey, now) {
  try {
    const timestamp = request.headers.get('telnyx-timestamp');
    const signature = decode64(request.headers.get('telnyx-signature-ed25519'));
    const key = decode64(publicKey);
    if (!timestamp || !/^\d{1,12}$/.test(timestamp) || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300 || signature.length !== 64 || key.length !== 32) return false;
    const prefix = new TextEncoder().encode(`${timestamp}|`);
    const message = new Uint8Array(prefix.length + bytes.length); message.set(prefix); message.set(bytes, prefix.length);
    const imported = await crypto.subtle.importKey('raw', key, 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', imported, signature, message);
  } catch { return false; }
}

// Only the documented Telnyx-owned S3 bucket is accepted. Never send credentials
// or follow redirects. Custom storage requires a separately reviewed integration.
function recordingUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 's3.amazonaws.com' && !url.port && !url.username && !url.password && url.pathname.startsWith('/telephony-recorder-prod/') ? url.href : null;
  } catch { return null; }
}

export async function handleVoiceWebhook(request, env, fetcher = fetch, now = Date.now()) {
  if (request.method !== 'POST') return reply(405, 'Method not allowed');
  if (!env.DB || !env.TELNYX_PUBLIC_KEY || !env.TELNYX_VOICE_CONNECTION_ID) return reply(503, 'Unavailable');
  let bytes;
  try { bytes = await bounded(request.body, MAX_BODY); } catch { return reply(413, 'Invalid body'); }
  if (!await verify(bytes, request, env.TELNYX_PUBLIC_KEY, now)) return reply(401, 'Unauthorized');
  let data, payload;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).data; payload = data.payload; } catch { return reply(400, 'Invalid event'); }
  const validString = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
  if (!data || !payload || !validString(data.id) || !TYPES.has(data.event_type) || !validString(payload.call_control_id) ||
      !validString(data.occurred_at) || !Number.isFinite(Date.parse(data.occurred_at)) || payload.connection_id !== env.TELNYX_VOICE_CONNECTION_ID) return reply(400, 'Invalid event');
  try {
    await env.DB.prepare('INSERT OR IGNORE INTO voice_events (event_id, event_type, call_control_id, occurred_at) VALUES (?, ?, ?, ?)').bind(data.id, data.event_type, payload.call_control_id, data.occurred_at).run();
    const event = await env.DB.prepare('SELECT event_type, call_control_id, occurred_at FROM voice_events WHERE event_id = ?').bind(data.id).first();
    if (!event || event.event_type !== data.event_type || event.call_control_id !== payload.call_control_id || event.occurred_at !== data.occurred_at) return reply(409, 'Event conflict');
    if (data.event_type === 'call.recording.transcription.saved') {
      const recording = payload.recording_id, text = typeof payload.transcription_text === 'string' ? payload.transcription_text.trim() : '';
      if (typeof recording !== 'string' || !UUID.test(recording)) return reply(400, 'Invalid recording');
      if (payload.status !== 'completed' || !text) return reply(200, 'Accepted');
      await env.DB.prepare('INSERT INTO voice_transcripts (recording_id, call_control_id, transcript) VALUES (?, ?, ?) ON CONFLICT(recording_id) DO NOTHING').bind(recording, payload.call_control_id, text.slice(0, MAX_TRANSCRIPT)).run();
      await applyTranscript(env.DB, recording);
      return reply(200, 'Accepted');
    }
    if (data.event_type !== 'call.recording.saved') {
      await processVoicemail(env, data, payload, fetcher);
      // The call log is secondary: it must never fail a webhook voicemail depends on.
      try { await recordCall(env.DB, data, payload); } catch { /* Telnyx retries are not needed for logging. */ }
      return reply(200, 'Accepted');
    }
    if (!env.FILES) return reply(503, 'Recording storage unavailable');
    const id = payload.recording_id;
    if (typeof id !== 'string' || !UUID.test(id)) return reply(400, 'Invalid recording');
    const existing = await env.DB.prepare('SELECT event_id, call_control_id FROM voice_recordings WHERE recording_id = ?').bind(id).first();
    if (existing) return existing.event_id === data.id && existing.call_control_id === payload.call_control_id ? reply(200, 'Accepted') : reply(409, 'Recording conflict');
    const format = recordingUrl(payload.recording_urls?.mp3) ? 'mp3' : recordingUrl(payload.recording_urls?.wav) ? 'wav' : null;
    if (!format) return reply(503, 'Unsupported recording location');
    const response = await fetcher(recordingUrl(payload.recording_urls[format]), { redirect: 'manual' });
    if (!response.ok) return reply(503, 'Recording unavailable');
    const audio = await bounded(response.body, MAX_AUDIO);
    if (!audio.length) return reply(503, 'Recording unavailable');
    // Different provider events must never overwrite an already archived object.
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data.id)));
    const eventHash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    const key = `voice/${id.toLowerCase()}/${eventHash}.${format}`;
    const contentType = format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    await env.FILES.put(key, audio, { httpMetadata: { contentType } });
    const kind = await isVoicemailRecording(env.DB, payload) ? 'voicemail' : 'recording';
    const meta = await recordingMeta(env.DB, payload);
    const inserted = await env.DB.prepare('INSERT OR IGNORE INTO voice_recordings (recording_id, event_id, call_control_id, object_key, content_type, kind, direction, from_number, to_number, duration_secs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, data.id, payload.call_control_id, key, contentType, kind, meta.direction, meta.from, meta.to, meta.duration).run();
    if (kind === 'voicemail' && inserted.meta?.changes === 1) pushLater(env, { kind: 'voicemail', id });
    const stored = await env.DB.prepare('SELECT event_id, call_control_id FROM voice_recordings WHERE recording_id = ?').bind(id).first();
    if (!stored || stored.event_id !== data.id || stored.call_control_id !== payload.call_control_id) return reply(409, 'Recording conflict');
    await applyTranscript(env.DB, id);
    return reply(200, 'Accepted');
  } catch { return reply(503, 'Temporarily unavailable'); }
}

export async function handleVoiceRecording(request, env, id) {
  if (request.method !== 'GET') return reply(405, 'Method not allowed');
  if (!UUID.test(id)) return reply(404, 'Not found');
  if (!env.DB || !env.FILES) return reply(503, 'Unavailable');
  try {
    const record = await env.DB.prepare('SELECT object_key, content_type FROM voice_recordings WHERE recording_id = ?').bind(id).first();
    if (!record) return reply(404, 'Not found');
    const object = await env.FILES.get(record.object_key);
    if (!object) return reply(503, 'Unavailable');
    const download = new URL(request.url).searchParams.get('download') === '1';
    const ext = record.content_type === 'audio/wav' ? 'wav' : 'mp3';
    return new Response(object.body, { headers: { 'Content-Type': record.content_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': download ? `attachment; filename="recording-${id}.${ext}"` : 'inline' } });
  } catch { return reply(503, 'Unavailable'); }
}

export async function listVoiceRecordings(request, env) {
  if (request.method !== 'GET') return reply(405, 'Method not allowed');
  if (!env.DB || !env.FILES) return reply(503, 'Unavailable');
  try {
    const rows = await env.DB.prepare('SELECT recording_id, archived_at, kind, direction, from_number, to_number, duration_secs, heard_at, transcript FROM voice_recordings ORDER BY archived_at DESC, recording_id DESC LIMIT 100').all();
    return Response.json({ recordings: rows.results }, { headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch { return reply(503, 'Unavailable'); }
}
