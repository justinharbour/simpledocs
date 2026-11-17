import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { sendPendingFaxAlert } from './inbound-fax-alert.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const file of ['0007_inbound_fax_events.sql', '0010_inbound_fax_pending.sql']) db.exec(readFileSync(new URL(`../../backend/core/migrations/${file}`, import.meta.url), 'utf8'));
  const sent = [];
  const env = { FAX_ALERTS_ENABLED: 'true', FAX_ALERT_AFTER_SECONDS: '300', FAX_ALERT_SENDER: 'noreply@example.test', FAX_ALERT_RECIPIENT: 'operator@example.test', FAX_ALERT_EMAIL: { async send(message) { sent.push(message); } }, DB: { prepare(sql) { return { bind(...args) { return { async first() { return db.prepare(sql).get(...args); } }; } }; } } };
  return { db, sent, env };
}
const now = Date.parse('2026-01-01T00:10:00.000Z');
test('alerts only for aged unarchived receipts and does not leak fax data', async () => {
  const { db, sent, env } = fixture();
  db.prepare('INSERT INTO inbound_fax_pending VALUES (?, ?, ?, ?)').run('event-identifier', 'fax-identifier', '2026-01-01T00:00:00.000Z', '2026-01-01T00:06:00.000Z');
  assert.equal(await sendPendingFaxAlert(env, { now }), 'none');
  db.prepare('UPDATE inbound_fax_pending SET received_at = ?').run('2026-01-01T00:05:00.000Z');
  assert.equal(await sendPendingFaxAlert(env, { now }), 'accepted');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'operator@example.test');
  assert.ok(!JSON.stringify(sent).includes('fax-identifier'));
  db.prepare("INSERT INTO inbound_fax_events VALUES ('event-identifier', 'fax-identifier', 'fax.received', 'then', 'now', 'object')").run();
  assert.equal(await sendPendingFaxAlert(env, { now }), 'none');
});
test('fails closed on missing configuration and delivery failure', async () => {
  const { db, sent, env } = fixture();
  db.prepare("INSERT INTO inbound_fax_pending VALUES ('event', 'fax', 'then', '2026-01-01T00:00:00.000Z')").run();
  assert.equal(await sendPendingFaxAlert({ ...env, FAX_ALERTS_ENABLED: 'false' }, { now }), 'disabled');
  for (const override of [{ FAX_ALERT_RECIPIENT: '' }, { FAX_ALERT_AFTER_SECONDS: '0' }, { FAX_ALERT_SENDER: 'bad\r\naddress' }, { FAX_ALERT_EMAIL: null }]) assert.equal(await sendPendingFaxAlert({ ...env, ...override }, { now }), 'unavailable');
  assert.equal(sent.length, 0);
  assert.equal(await sendPendingFaxAlert({ ...env, FAX_ALERT_EMAIL: { async send() { throw Error('synthetic'); } } }, { now }), 'unavailable');
});

test('database errors and malformed query results never send an alert', async () => {
  const { env, sent } = fixture();
  for (const first of [
    async () => { throw new Error('synthetic sensitive database detail'); },
    async () => null,
    async () => ({ count: -1 }),
    async () => ({ count: '1' }),
  ]) {
    const DB = { prepare() { return { bind() { return { first }; } }; } };
    assert.equal(await sendPendingFaxAlert({ ...env, DB }, { now }), 'unavailable');
  }
  assert.equal(sent.length, 0);
});

test('multiple pending receipts produce only one generic message per invocation', async () => {
  const { db, sent, env } = fixture();
  const insert = db.prepare('INSERT INTO inbound_fax_pending VALUES (?, ?, ?, ?)');
  insert.run('event-one', 'private-fax-one', 'then', '2026-01-01T00:00:00.000Z');
  insert.run('event-two', 'private-fax-two', 'then', '2026-01-01T00:01:00.000Z');
  assert.equal(await sendPendingFaxAlert(env, { now }), 'accepted');
  assert.equal(sent.length, 1);
  const content = JSON.stringify(sent[0]);
  for (const secret of ['event-one', 'event-two', 'private-fax-one', 'private-fax-two']) assert.ok(!content.includes(secret));
});
