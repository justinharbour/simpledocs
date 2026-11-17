import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { prepareFax, sendPreparedFax, applyFaxDeliveryEvent } from './fax-intents.mjs';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../backend/core/migrations/0003_fax_intents.sql', import.meta.url), 'utf8'));
  return { prepare(sql) { return { bind(...args) { return {
    async first() { return db.prepare(sql).get(...args); },
    async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
  }; } }; } };
}
const id = '11111111-1111-4111-8111-111111111111';
const intent = { id, actor: 'owner', destination: '+12025550102', mediaName: 'document.pdf' };
const config = { enabled: true, token: 'test', connectionId: 'test', from: '+12025550101' };

it('blocks distinct IDs for an actor with an unresolved send, but isolates other actors', async () => {
  const db = database();
  const second = '22222222-2222-4222-8222-222222222222';
  const third = '33333333-3333-4333-8333-333333333333';
  await prepareFax(db, intent);
  await prepareFax(db, { ...intent, id: second });
  await prepareFax(db, { ...intent, id: third, actor: 'other' });
  let calls = 0;
  const submit = async () => { calls++; return { outcome: 'unknown' }; };
  const results = await Promise.all([id, second].map(candidate => sendPreparedFax(db, { id: candidate, actor: 'owner', config, confirmed: true }, submit)));
  assert.equal(calls, 1);
  assert.deepEqual(results.map(r => r.outcome).sort(), ['not_claimed', 'unknown']);
  assert.equal((await sendPreparedFax(db, { id: third, actor: 'other', config, confirmed: true }, submit)).outcome, 'unknown');
});

it('claims once under concurrent confirmation and preserves actor isolation', async () => {
  const db = database();
  assert.equal(await prepareFax(db, intent), true);
  assert.equal(await prepareFax(db, intent), false);
  assert.deepEqual(await sendPreparedFax(db, { id, actor: 'other', config, confirmed: true }), { outcome: 'not_claimed' });
  let calls = 0;
  const send = async () => { calls++; return { outcome: 'accepted', providerId: 'provider-1' }; };
  const results = await Promise.all([sendPreparedFax(db, { id, actor: 'owner', config, confirmed: true }, send), sendPreparedFax(db, { id, actor: 'owner', config, confirmed: true }, send)]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map(x => x.outcome).sort(), ['accepted', 'not_claimed']);
});

it('does not claim without confirmation or enabled valid configuration', async () => {
  const db = database(); await prepareFax(db, intent);
  for (const options of [{ config, confirmed: false }, { config: { ...config, enabled: false }, confirmed: true }, { config: { ...config, token: '' }, confirmed: true }]) {
    assert.deepEqual(await sendPreparedFax(db, { id, actor: 'owner', ...options }), { outcome: 'unavailable' });
  }
  assert.deepEqual(await sendPreparedFax(db, { id, actor: 'owner', config, confirmed: true }, async () => ({ outcome: 'rejected' })), { outcome: 'rejected' });
});

it('records uncertain outcome and refuses to submit again', async () => {
  const db = database(); await prepareFax(db, intent);
  assert.deepEqual(await sendPreparedFax(db, { id, actor: 'owner', config, confirmed: true }, async () => { throw Error('lost response'); }), { outcome: 'unknown' });
  assert.deepEqual(await sendPreparedFax(db, { id, actor: 'owner', config, confirmed: true }), { outcome: 'not_claimed' });
  assert.equal((await db.prepare('SELECT status FROM fax_intents WHERE id = ?').bind(id).first()).status, 'unknown');
});

it('applies only matched terminal events and does not regress a delivered fax', async () => {
  const db = database(); await prepareFax(db, intent);
  assert.equal(await applyFaxDeliveryEvent(db, { providerId: 'provider-1', status: 'delivered' }), 'unmatched');
  await sendPreparedFax(db, { id, actor: 'owner', config, confirmed: true }, async () => ({ outcome: 'accepted', providerId: 'provider-1' }));
  assert.equal(await applyFaxDeliveryEvent(db, { providerId: 'provider-1', status: 'delivered' }), 'updated');
  assert.equal(await applyFaxDeliveryEvent(db, { providerId: 'provider-1', status: 'delivered' }), 'duplicate');
  assert.equal(await applyFaxDeliveryEvent(db, { providerId: 'provider-1', status: 'failed' }), 'conflict');
  assert.equal((await db.prepare('SELECT status FROM fax_intents WHERE id = ?').bind(id).first()).status, 'delivered');
  await assert.rejects(() => applyFaxDeliveryEvent(db, { providerId: 'provider-1', status: 'queued' }), TypeError);
});
