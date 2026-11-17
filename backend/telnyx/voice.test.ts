import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectVoiceEvent, voicePermissions, type VoiceEvent } from './voice.js';

const event = (type: VoiceEvent['type'], second: number): VoiceEvent => ({
  eventId: `event-${second}`, callControlId: 'leg-1', type, occurredAt: `2026-01-01T00:00:${String(second).padStart(2, '0')}Z`,
});

test('projects voice lifecycle without regressions or late events reopening a call', () => {
  let call = projectVoiceEvent(undefined, { ...event('call.initiated', 1), direction: 'inbound' });
  for (const e of [event('call.ringing', 2), event('call.answered', 3), event('call.hangup', 4)]) call = projectVoiceEvent(call, e);
  assert.equal(call.phase, 'ended');
  assert.deepEqual(projectVoiceEvent(call, event('call.answered', 3)), call);
  assert.deepEqual(projectVoiceEvent(call, event('call.ringing', 5)), call);
  assert.deepEqual(projectVoiceEvent(call, event('call.hangup', 4)), call);
});

test('out-of-order recording signal is not an archived voicemail', () => {
  let call = projectVoiceEvent(undefined, event('call.recording.saved', 5));
  call = projectVoiceEvent(call, event('call.hangup', 4));
  assert.equal(call.phase, 'ended');
  assert.equal(call.recording, 'provider_reported');
});

test('rejects invalid events, unrelated legs and conflicting directions', () => {
  const call = projectVoiceEvent(undefined, { ...event('call.answered', 2), direction: 'inbound' });
  assert.throws(() => projectVoiceEvent(call, { ...event('call.hangup', 3), callControlId: 'leg-2' }));
  assert.throws(() => projectVoiceEvent(call, { ...event('call.hangup', 3), direction: 'outbound' }));
  assert.throws(() => projectVoiceEvent(call, { ...event('call.hangup', 3), occurredAt: 'invalid' }));
});

test('voice permissions default closed and voicemail also requires inbound', () => {
  assert.deepEqual(voicePermissions({}), { inbound: false, outbound: false, voicemail: false });
  assert.equal(voicePermissions({ 'voice.voicemail': true }).voicemail, false);
  assert.deepEqual(voicePermissions({ 'voice.inbound': true, 'voice.voicemail': true }), { inbound: true, outbound: false, voicemail: true });
});
