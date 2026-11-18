import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from './phone.mjs';

test('normalizes common formats', () => {
  for (const v of ['(213) 414-7728', '213-414-7728', '213.414.7728', '2134147728', '1 213 414 7728', '+1 (213) 414-7728', ' +12134147728 ']) assert.equal(normalizePhone(v), '+12134147728', v);
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
});

test('rejects garbage', () => {
  for (const v of ['', 'abc', '123', '+0123456789', '(113) 414-7728', '213-114-7728', '+1234567890123456', '213 414 7728 ext 5', null, undefined, 5]) assert.equal(normalizePhone(v), null, String(v));
});
