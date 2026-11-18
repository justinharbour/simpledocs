import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptPortalDocument, encryptPortalDocument, importPortalKey, newPortalToken, portalTokenHash } from './portal-crypto.mjs';

test('tokens are random, URL-safe, and hashed with validation', async () => {
  const a = newPortalToken();
  const b = newPortalToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(await portalTokenHash(a), await portalTokenHash(a));
  assert.notEqual(await portalTokenHash(a), await portalTokenHash(b));
  await assert.rejects(portalTokenHash('short'));
});

test('encrypted documents are bound to their delivery and document context', async () => {
  const key = await importPortalKey(newPortalToken());
  const text = new TextEncoder().encode('private document');
  const first = await encryptPortalDocument(key, text, 'delivery', 'document');
  const second = await encryptPortalDocument(key, text, 'delivery', 'document');
  assert.notEqual(first.iv, second.iv);
  assert.deepEqual(await decryptPortalDocument(key, first, 'delivery', 'document'), text);
  await assert.rejects(decryptPortalDocument(key, first, 'another', 'document'));
  await assert.rejects(decryptPortalDocument(key, first, 'delivery', 'another'));
  first.ciphertext[0] ^= 1;
  await assert.rejects(decryptPortalDocument(key, first, 'delivery', 'document'));
  await assert.rejects(importPortalKey('password'));
});
