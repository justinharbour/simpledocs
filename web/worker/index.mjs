import { createRemoteJWKSet, jwtVerify } from 'jose';
import { handleDraft } from './drafts.mjs';
import { handleFaxStatus } from './fax-status.mjs';
import { handleFaxSend } from './fax-send.mjs';
import { handleVoiceWebhook, handleVoiceRecording, listVoiceRecordings } from './voice-webhook.mjs';
import { handleVoiceSession } from './voice-session.mjs';

// Static Assets do not propagate ctx.access. Verify the Access assertion against
// the configured team's keys instead; never trust an unverified identity header.
const keySets = new Map();
export async function verifyAccess(token, issuer, audience, keys) {
  const { payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email'] });
  if (typeof payload.email !== 'string' || !payload.email.trim() || typeof payload.sub !== 'string' || !payload.sub.trim()) throw new Error('Missing identity');
  return payload.sub;
}
export function createWorker(resolveKeys = issuer => {
  if (!keySets.has(issuer)) keySets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));
  return keySets.get(issuer);
}) {
  return {
  async fetch(request, env) {
    const url = new URL(request.url);
    // This one endpoint uses Telnyx's signature, not a browser Access JWT.
    if (url.pathname === '/api/webhooks/telnyx/voice') return handleVoiceWebhook(request, env);
    const expected = env.ACCESS_AUDIENCE;
    const issuer = env.ACCESS_TEAM_DOMAIN;
    const token = request.headers.get('cf-access-jwt-assertion');
    if (typeof expected !== 'string' || !expected.trim() || typeof issuer !== 'string' || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !token) {
      return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } });
    }
    let actor;
    try {
      actor = await verifyAccess(token, issuer, expected, resolveKeys(issuer));
    } catch {
      return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/api/voice/session') return handleVoiceSession(request, env, actor);
    if (url.pathname === '/api/voice/recordings' || url.pathname.startsWith('/api/voice/recordings/')) {
      if (!env.VOICE_OWNER_SUBJECT || actor !== env.VOICE_OWNER_SUBJECT) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/api/voice/recordings') return listVoiceRecordings(request, env);
    const recording = /^\/api\/voice\/recordings\/([^/]+)$/.exec(url.pathname);
    if (recording) return handleVoiceRecording(request, env, recording[1]);
    const fax = /^\/api\/faxes\/([^/]+)$/.exec(url.pathname);
    if (fax) return request.method === 'POST' ? handleFaxSend(request, env, actor, fax[1]) : handleFaxStatus(request, env, actor, fax[1]);
    const draft = /^\/api\/mail-drafts\/([^/]+)$/.exec(url.pathname);
    if (draft) return handleDraft(request, env.DB, actor, draft[1]);
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return new Response('Not implemented', { status: 501, headers: { 'Cache-Control': 'no-store' } });
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'private, no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  };
}
export default createWorker();
