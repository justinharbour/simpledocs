import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availabilityOnline, validAvailability, handleAvailability } from './availability-policy.mjs';
import { makeEnv, jsonRequest } from './test-env.mjs';

test('manual modes and invalid policies fail closed', () => {
  assert.equal(availabilityOnline({ mode: 'online', timezone: 'UTC', intervals: [] }), true);
  assert.equal(availabilityOnline({ mode: 'offline', timezone: 'UTC', intervals: [] }), false);
  assert.equal(availabilityOnline({ mode: 'online', timezone: 'not/a-zone', intervals: [] }), false);
  assert.equal(validAvailability({ mode: 'schedule', timezone: 'UTC', intervals: [{ day: 1, start: '09:00', end: '09:00' }] }), false);
});

test('availability settings require same origin and round-trip as one policy', async () => {
  const { env } = makeEnv();
  const policy = { mode: 'schedule', timezone: 'UTC', intervals: [{ day: 1, start: '09:00', end: '17:00' }] };
  const cross = new Request('https://example.test/api/voice/availability', { method: 'PUT', headers: { origin: 'https://evil.test' }, body: JSON.stringify(policy) });
  assert.equal((await handleAvailability(cross, env)).status, 403);
  assert.equal((await handleAvailability(jsonRequest('/api/voice/availability', policy, 'PUT'), env)).status, 200);
  assert.deepEqual(await (await handleAvailability(new Request('https://example.test/api/voice/availability'), env)).json(), policy);
});

test('local schedules include the start and exclude the end across midnight and DST', () => {
  const schedule = { mode: 'schedule', timezone: 'America/New_York', intervals: [{ day: 6, start: '22:00', end: '03:00' }] };
  assert.equal(availabilityOnline(schedule, Date.parse('2026-03-08T03:00:00Z')), true);
  assert.equal(availabilityOnline(schedule, Date.parse('2026-03-08T06:59:00Z')), true);
  assert.equal(availabilityOnline(schedule, Date.parse('2026-03-08T07:00:00Z')), false);
  assert.equal(availabilityOnline(schedule, Date.parse('2026-03-08T02:59:00Z')), false);
});
