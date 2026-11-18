// A dedicated Call Control application routes incoming calls here. When the browser softphone is
// online the call is first transferred to it for RING_SECS; if nobody answers, voicemail answers
// the original (still unanswered) leg. When the phone is offline voicemail answers immediately.
import { fallbackConfig, isLegacyVoice, voicemailConfig } from './voicemail-config.mjs';
import { phoneOnline } from './voice-presence.mjs';
import { availabilityOnline, loadAvailability } from './availability-policy.mjs';
import { assistantForCall } from './ai-voicemail.mjs';

const RING_SECS = 20;
const RING = 'simpledocs-ring:';
const RING_LEG = 'simpledocs-ring-leg:';

// The marker on a leg created by our transfer, or null. Telnyx echoes target_leg_client_state on that leg's events.
export function ringLegMarker(clientState) {
  try {
    const text = typeof clientState === 'string' ? atob(clientState) : '';
    return text.startsWith(RING_LEG) ? text.slice(RING_LEG.length) : null;
  } catch { return null; }
}

// True only when the marker belongs to a call we actually rang the softphone for.
export async function isRingLeg(db, clientState) {
  const marker = ringLegMarker(clientState);
  if (!marker) return false;
  const row = await db.prepare('SELECT r.call_control_id FROM voicemail_calls c JOIN voicemail_rings r ON r.call_control_id = c.call_control_id WHERE c.marker = ?').bind(marker).first();
  return !!row;
}

const auth = env => ({ Authorization: `Bearer ${env.TELNYX_API_TOKEN}`, 'Content-Type': 'application/json' });

// Returns true when the softphone is being rung (or already was), so voicemail must wait for the outcome.
async function ring(env, id, marker, payload, fetcher) {
  try { if (!env.TELNYX_WEBRTC_CREDENTIAL_ID || !availabilityOnline(await loadAvailability(env.DB)) || !await phoneOnline(env.DB)) return false; } catch { return false; }
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO voicemail_rings (call_control_id, outcome) VALUES (?, 'claimed')").bind(id).run();
  if ((claim.meta?.changes ?? claim.changes) !== 1) return true;
  let outcome = 'rejected';
  let username = null;
  try {
    const credential = await fetcher(`https://api.telnyx.com/v2/telephony_credentials/${encodeURIComponent(env.TELNYX_WEBRTC_CREDENTIAL_ID)}`, { redirect: 'manual', headers: auth(env) });
    if (credential.ok) username = (await credential.json())?.data?.sip_username;
  } catch { /* No lookup, no transfer: voicemail answers now. */ }
  if (typeof username === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(username)) {
    outcome = 'unknown';
    try {
      const body = { to: `sip:${username}@sip.telnyx.com`, timeout_secs: RING_SECS, client_state: btoa(`${RING}${marker}`), target_leg_client_state: btoa(`${RING_LEG}${marker}`), command_id: crypto.randomUUID() };
      // Present the caller's number; Telnyx treats it as verified because it is on an active inbound call to us.
      if (/^\+[1-9]\d{1,14}$/.test(payload.from ?? '')) { body.from = payload.from; body.diversion = payload.to; }
      const response = await fetcher(`https://api.telnyx.com/v2/calls/${encodeURIComponent(id)}/actions/transfer`, { method: 'POST', redirect: 'manual', headers: auth(env), body: JSON.stringify(body) });
      outcome = response.ok ? 'accepted' : 'rejected';
    } catch { /* Unknown outcome: never issue a second command automatically. */ }
  }
  await env.DB.prepare('UPDATE voicemail_rings SET outcome = ? WHERE call_control_id = ?').bind(outcome, id).run();
  return outcome !== 'rejected';
}

async function command(env, id, action, body, fetcher) {
  const ended = await env.DB.prepare("SELECT event_id FROM voice_events WHERE call_control_id = ? AND event_type = 'call.hangup' LIMIT 1").bind(id).first();
  if (ended) return;
  const commandId = crypto.randomUUID();
  const ai = action === 'ai_assistant_start';
  const claim = ai ? await env.DB.prepare('INSERT OR IGNORE INTO ai_voicemail_commands (call_control_id, command_id, outcome) VALUES (?, ?, ?)').bind(id, commandId, 'claimed').run() : await env.DB.prepare('INSERT OR IGNORE INTO voicemail_commands (call_control_id, action, command_id, outcome) VALUES (?, ?, ?, ?)').bind(id, action, commandId, 'claimed').run();
  if ((claim.meta?.changes ?? claim.changes) !== 1) return;
  let outcome = 'unknown';
  try {
    const response = await fetcher(`https://api.telnyx.com/v2/calls/${encodeURIComponent(id)}/actions/${action}`, {
      method: 'POST', redirect: 'manual', headers: auth(env),
      body: JSON.stringify({ ...body, command_id: commandId }),
    });
    outcome = response.ok ? 'accepted' : ai && response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown';
  } catch { /* Unknown outcome: never issue a second command automatically. */ }
  if (ai) await env.DB.prepare('UPDATE ai_voicemail_commands SET outcome = ? WHERE call_control_id = ?').bind(outcome, id).run();
  else await env.DB.prepare('UPDATE voicemail_commands SET outcome = ? WHERE call_control_id = ? AND action = ?').bind(outcome, id, action).run();
  return outcome;
}

// Returns true when the event belongs to the softphone leg, which must not appear in the call log.
export async function processVoicemail(env, event, payload, fetcher = fetch) {
  if (env.VOICEMAIL_ENABLED !== 'true' || env.VOICE_INBOUND_ENABLED !== 'true' ||
      !env.FILES || !env.TELNYX_API_TOKEN || !/^\+[1-9]\d{1,14}$/.test(env.VOICEMAIL_NUMBER ?? '')) return false;
  const legMarker = ringLegMarker(payload.client_state);
  if (legMarker) {
    const call = await env.DB.prepare('SELECT call_control_id FROM voicemail_calls WHERE marker = ?').bind(legMarker).first();
    if (!call) return true;
    if (event.event_type === 'call.answered') {
      // The softphone picked up, so the caller's leg counts as answered even if Telnyx sends it no event of its own.
      const at = new Date().toISOString();
      await env.DB.prepare("UPDATE calls SET answered_at = COALESCE(answered_at, ?), outcome = CASE WHEN outcome = 'ringing' THEN 'answered' ELSE outcome END, updated_at = ? WHERE call_control_id = ?").bind(event.occurred_at, at, call.call_control_id).run();
      return true;
    }
    if (event.event_type !== 'call.hangup') return true;
    // Answered means the softphone took the call; anything else (timeout, declined, cancelled) means voicemail.
    const answered = await env.DB.prepare("SELECT event_id FROM voice_events WHERE call_control_id = ? AND event_type = 'call.answered' LIMIT 1").bind(payload.call_control_id).first();
    if (answered) return true;
    let config;
    try { config = await voicemailConfig(env); } catch { config = fallbackConfig(env); }
    if (config.greeting) await command(env, call.call_control_id, 'answer', { client_state: btoa(`simpledocs-voicemail:${legMarker}`) }, fetcher);
    return true;
  }
  // Stored settings win; a settings read failure falls back to the environment greeting and default voice.
  let config;
  try { config = await voicemailConfig(env); } catch { config = fallbackConfig(env); }
  if (!config.greeting) return false;
  const id = payload.call_control_id;
  if (event.event_type === 'call.initiated') {
    if (payload.direction !== 'incoming' || payload.to !== env.VOICEMAIL_NUMBER) return false;
    const ended = await env.DB.prepare("SELECT event_id FROM voice_events WHERE call_control_id = ? AND event_type = 'call.hangup' LIMIT 1").bind(id).first();
    if (ended) return false;
    await env.DB.prepare('INSERT OR IGNORE INTO voicemail_calls (call_control_id, marker) VALUES (?, ?)').bind(id, crypto.randomUUID()).run();
  }
  const voicemail = await env.DB.prepare('SELECT marker FROM voicemail_calls WHERE call_control_id = ?').bind(id).first();
  if (!voicemail) return false;
  const marker = btoa(`simpledocs-voicemail:${voicemail.marker}`);
  if (event.event_type === 'call.initiated' && payload.direction === 'incoming' && payload.to === env.VOICEMAIL_NUMBER) {
    if (await ring(env, id, voicemail.marker, payload, fetcher)) return false;
    await command(env, id, 'answer', { client_state: marker }, fetcher);
  } else if (event.event_type === 'call.answered' && payload.client_state === marker) {
    // An ambiguous start must not also start recording over a potentially live assistant.
    // Only a definite provider rejection permits the traditional greeting fallback.
    const prior = await env.DB.prepare('SELECT outcome FROM ai_voicemail_commands WHERE call_control_id = ?').bind(id).first();
    if (prior && prior.outcome !== 'rejected') return false;
    if (!prior) {
      let assistant = null;
      try { assistant = await assistantForCall(env, id); } catch { /* use ordinary voicemail */ }
      if (assistant === false) return false;
      if (assistant) {
        const result = await command(env, id, 'ai_assistant_start', { assistant, client_state: marker }, fetcher);
        if (result !== 'rejected') return false;
      }
    }
    const body = { client_state: marker, payload: config.greeting, payload_type: 'text', voice: config.voice, language: 'en-US' };
    // Telnyx documents service_level as the basic/premium switch for the legacy female/male voices only.
    if (isLegacyVoice(config.voice)) body.service_level = config.service_level;
    await command(env, id, 'speak', body, fetcher);
  } else if (event.event_type === 'call.speak.ended' && payload.client_state === marker) {
    const speak = await env.DB.prepare("SELECT outcome FROM voicemail_commands WHERE call_control_id = ? AND action = 'speak'").bind(id).first();
    if (!speak) return false;
    await command(env, id, 'record_start', { client_state: btoa(`simpledocs-voicemail-recording:${voicemail.marker}`), format: 'mp3', channels: 'single', play_beep: true, max_length: 120, transcription: true, transcription_engine: 'A', transcription_language: 'en-US' }, fetcher);
  }
  return false;
}

export async function isVoicemailRecording(db, payload) {
  const call = await db.prepare('SELECT marker FROM voicemail_calls WHERE call_control_id = ?').bind(payload.call_control_id).first();
  if (!call || payload.client_state !== btoa(`simpledocs-voicemail-recording:${call.marker}`)) return false;
  const command = await db.prepare("SELECT outcome FROM voicemail_commands WHERE call_control_id = ? AND action = 'record_start'").bind(payload.call_control_id).first();
  return !!command;
}
