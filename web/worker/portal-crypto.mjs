// Primitives for the recipient portal. This module is not a route and does not
// grant access by itself. Callers must enforce durable, atomic one-time use.
const encoder = new TextEncoder();
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

export function newPortalToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function portalTokenHash(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new TypeError('Invalid token');
  // Domain separation prevents accidental reuse of this digest in another flow.
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`simpledocs:portal:v1:${token}`));
  return base64url(new Uint8Array(digest));
}

// The key is a dedicated, 32-byte random secret, not a password. The same key
// must remain available for decryption until all associated objects expire.
export async function importPortalKey(encoded) {
  if (typeof encoded !== 'string' || !TOKEN_PATTERN.test(encoded)) throw new TypeError('Invalid portal key');
  const bytes = decode(encoded);
  if (bytes.length !== 32 || base64url(bytes) !== encoded) throw new TypeError('Invalid portal key');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function associatedData(deliveryId, documentId) {
  if (typeof deliveryId !== 'string' || typeof documentId !== 'string' || !deliveryId || !documentId || deliveryId.length > 200 || documentId.length > 200) throw new TypeError('Invalid context');
  return encoder.encode(JSON.stringify(['simpledocs:portal-document:v1', deliveryId, documentId]));
}

export async function encryptPortalDocument(key, plaintext, deliveryId, documentId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: associatedData(deliveryId, documentId), tagLength: 128 }, key, plaintext);
  return { version: 1, iv: base64url(iv), ciphertext: new Uint8Array(ciphertext) };
}

export async function decryptPortalDocument(key, object, deliveryId, documentId) {
  if (object?.version !== 1 || typeof object.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(object.iv)) throw new TypeError('Invalid encrypted document');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(object.iv), additionalData: associatedData(deliveryId, documentId), tagLength: 128 }, key, object.ciphertext));
}
