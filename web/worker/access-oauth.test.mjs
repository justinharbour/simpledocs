import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiredCallbacks, supportsNativeCallbacks } from './access-oauth.mjs';

test('requires both callback generations without rejecting additional settings', () => {
  const registration = { enabled: true, allowed_uris: [...requiredCallbacks, 'other:/callback'] };
  assert.equal(supportsNativeCallbacks({ enabled: true, dynamic_client_registration: registration, grant: { session_duration: 'custom' } }), true);
  assert.equal(supportsNativeCallbacks({ enabled: true, dynamic_client_registration: { ...registration, allowed_uris: [requiredCallbacks[0]] } }), false);
  assert.equal(supportsNativeCallbacks({ enabled: true, dynamic_client_registration: { ...registration, enabled: false } }), false);
  assert.equal(supportsNativeCallbacks(undefined), false);
});
