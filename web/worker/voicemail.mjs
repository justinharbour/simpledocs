// A dedicated Call Control application must route directly to voicemail. This
// is not a timeout/fallback implementation and must not compete with a phone.
import { fallbackConfig, isLegacyVoice, voicemailConfig } from './voicemail-config.mjs';

export async function processVoicemail(env, event, payload, fetcher = fetch) {
  if (env.VOICEMAIL_ENABLED !== 'true' || env.VOICE_INBOUND_ENABLED !== 'true' ||
      !env.FILES || !env.TELNYX_API_TOKEN || !/^\+[1-9]\d{1,14}$/.test(env.VOICEMAIL_NUMBER ?? '')) return;
  // Stored settings win; a settings read failure falls back to the environment greeting and default voice.
  let config;
  try { config = await voicemailConfig(env); } catch { config = fallbackConfig(env); }
  if (!config.greeting) return;
  const id = payload.call_control_id;
  if (event.event_type === 'call.initiated') {
    if (payload.direction !== 'incoming' || payload.to !== env.VOICEMAIL_NUMBER) return;
    const ended = await env.DB.prepare("SELECT event_id FROM voice_events WHERE call_control_id = ? AND event_type = 'call.hangup' LIMIT 1").bind(id).first();
    if (ended) return;
    await env.DB.prepare('INSERT OR IGNORE INTO voicemail_calls (call_control_id, marker) VALUES (?, ?)').bind(id, crypto.randomUUID()).run();
  }
  const voicemail = await env.DB.prepare('SELECT marker FROM voicemail_calls WHERE call_control_id = ?').bind(id).first();
  if (!voicemail) return;
  let action, body;
  const marker = btoa(`simpledocs-voicemail:${voicemail.marker}`);
  if (event.event_type === 'call.initiated' && payload.direction === 'incoming' && payload.to === env.VOICEMAIL_NUMBER) {
    action = 'answer'; body = { client_state: marker };
  } else if (event.event_type === 'call.answered' && payload.client_state === marker) {
    action = 'speak'; body = { client_state: marker, payload: config.greeting, payload_type: 'text', voice: config.voice, language: 'en-US' };
    // Telnyx documents service_level as the basic/premium switch for the legacy female/male voices only.
    if (isLegacyVoice(config.voice)) body.service_level = config.service_level;
  } else if (event.event_type === 'call.speak.ended' && payload.client_state === marker) {
    const speak = await env.DB.prepare("SELECT outcome FROM voicemail_commands WHERE call_control_id = ? AND action = 'speak'").bind(id).first();
    if (!speak) return;
    action = 'record_start'; body = { client_state: btoa(`simpledocs-voicemail-recording:${voicemail.marker}`), format: 'mp3', channels: 'single', play_beep: true, max_length: 120, transcription: true, transcription_engine: 'A', transcription_language: 'en-US' };
  } else return;
  const ended = await env.DB.prepare("SELECT event_id FROM voice_events WHERE call_control_id = ? AND event_type = 'call.hangup' LIMIT 1").bind(id).first();
  if (ended) return;
  const commandId = crypto.randomUUID();
  const claim = await env.DB.prepare('INSERT OR IGNORE INTO voicemail_commands (call_control_id, action, command_id, outcome) VALUES (?, ?, ?, ?)').bind(id, action, commandId, 'claimed').run();
  if ((claim.meta?.changes ?? claim.changes) !== 1) return;
  let outcome = 'unknown';
  try {
    const response = await fetcher(`https://api.telnyx.com/v2/calls/${encodeURIComponent(id)}/actions/${action}`, {
      method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${env.TELNYX_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, command_id: commandId }),
    });
    if (response.ok) outcome = 'accepted';
  } catch { /* Unknown outcome: never issue a second command automatically. */ }
  await env.DB.prepare('UPDATE voicemail_commands SET outcome = ? WHERE call_control_id = ? AND action = ?').bind(outcome, id, action).run();
}

export async function isVoicemailRecording(db, payload) {
  const call = await db.prepare('SELECT marker FROM voicemail_calls WHERE call_control_id = ?').bind(payload.call_control_id).first();
  if (!call || payload.client_state !== btoa(`simpledocs-voicemail-recording:${call.marker}`)) return false;
  const command = await db.prepare("SELECT outcome FROM voicemail_commands WHERE call_control_id = ? AND action = 'record_start'").bind(payload.call_control_id).first();
  return !!command;
}
