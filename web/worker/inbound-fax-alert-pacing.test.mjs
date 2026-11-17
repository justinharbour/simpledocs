import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { claimFaxAlertInterval } from './inbound-fax-alert-pacing.mjs';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../backend/core/migrations/0011_fax_alert_pacing.sql', import.meta.url), 'utf8'));
  const db = { prepare(sql) { return { bind(...args) { return { async first() { return sqlite.prepare(sql).get(...args) ?? null; } }; } }; } };
  return { db, sqlite };
}
test('durably permits only one claim per interval, including concurrent attempts', async () => {
  const { db, sqlite } = fixture();
  const options = { now: 100000, intervalMs: 60000 };
  const results = await Promise.all(Array.from({ length: 8 }, () => claimFaxAlertInterval(db, options)));
  assert.equal(results.filter(result => result === 'claimed').length, 1);
  assert.equal(results.filter(result => result === 'paced').length, 7);
  assert.equal(await claimFaxAlertInterval(db, { ...options, now: 159999 }), 'paced');
  assert.equal(await claimFaxAlertInterval(db, { ...options, now: 160000 }), 'claimed');
  assert.equal(sqlite.prepare('SELECT next_attempt_ms FROM fax_alert_pacing').get().next_attempt_ms, 220000);
});
test('invalid inputs and database failure fail closed', async () => {
  const { db } = fixture();
  for (const opts of [{ now: -1, intervalMs: 60000 }, { now: 1, intervalMs: 1 }, { now: Number.MAX_SAFE_INTEGER, intervalMs: 60000 }]) assert.equal(await claimFaxAlertInterval(db, opts), 'unavailable');
  assert.equal(await claimFaxAlertInterval({ prepare() { throw new Error('synthetic'); } }, { now: 1, intervalMs: 60000 }), 'unavailable');
});
