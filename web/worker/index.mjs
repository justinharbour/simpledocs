import { createRemoteJWKSet, jwtVerify } from 'jose';
import { handleDraft } from './drafts.mjs';
import { handleFaxStatus } from './fax-status.mjs';
import { handleFaxSend } from './fax-send.mjs';
import { handleInboundFax } from './inbound-fax.mjs';
import { handleInboundFaxRead, inboundFaxAllowed } from './inbound-fax-read.mjs';
import { handleQueue, reconcileDeliveries } from './queue-consumer.mjs';
import { approveEmail, approveFax, approveMail, createTransmission, getTransmission, getTransmissionFile, handleCoverPreview, handleSettings, listRecipients, listRecords, listTransmissions, reviewEmail, reviewFax, reviewMail, handleMailReceipt } from './transmissions.mjs';
import { listCalls, markHeard } from './voice-calls.mjs';
import { handleFaxOperator } from './inbound-fax-operator.mjs';
import { handleMail, listUnresolvedMail } from './mail-send.mjs';
import { handleVoiceWebhook, handleVoiceRecording, listVoiceRecordings } from './voice-webhook.mjs';
import { handleVoiceSession } from './voice-session.mjs';
import { handlePresence } from './voice-presence.mjs';
import { handleAvailability } from './availability-policy.mjs';
import { handleSms, handleSmsWebhook } from './sms.mjs';
import { handleInbox } from './inbox.mjs';
import { handleVoicemailSettings } from './voicemail-config.mjs';
import { sendPendingFaxAlert } from './inbound-fax-alert.mjs';
import { handlePushDevices, notifyPush, withPush } from './push.mjs';
import { cleanupPortal, createEmailDelivery, portal, revokeEmailDelivery } from './email-portal.mjs';
import { PORTAL_PATHS } from './portal-paths.mjs';
import { tvActor, tvApprove, tvDevices, tvPairStart, tvPoll, tvPreview, tvRevoke } from './tv-pairing.mjs';
import { tvApi } from './tv-api.mjs';

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
  async scheduled(_event, env, ctx) {
    const result = await sendPendingFaxAlert(env);
    // Operational status only; never log provider errors or fax data.
    if (result === 'unavailable') console.error('Pending fax alert unavailable');
    if (result === 'accepted') await notifyPush(env, { kind: 'fax-attention' });
    try { await reconcileDeliveries(withPush(env, ctx)); } catch { console.error('Delivery reconcile unavailable'); }
    try { await cleanupPortal(env); } catch { console.error('Portal cleanup unavailable'); }
  },
  queue(batch, env, ctx) { return handleQueue(batch, withPush(env, ctx)); },
  async fetch(request, env, ctx) {
    env = withPush(env, ctx);
    const url = new URL(request.url);
    if (url.pathname === '/webhooks/telnyx/fax') return handleInboundFax(request, env);
    // This one endpoint uses Telnyx's signature, not a browser Access JWT.
    if (url.pathname === '/api/webhooks/telnyx/voice') return handleVoiceWebhook(request, env);
    if (url.pathname === '/api/webhooks/telnyx/messaging') return handleSmsWebhook(request, env);
    // These exact paths use recipient sessions rather than owner Access identity.
    if (PORTAL_PATHS.includes(url.pathname) && url.origin === env.PORTAL_ORIGIN) return portal(request, env);
    // Pairing is unauthenticated (rate-limited). /tv/api/* uses a TV bearer token, never an Access identity.
    if (url.pathname === '/tv/pair/start') return tvPairStart(request, env);
    if (url.pathname === '/tv/pair/poll') return tvPoll(request, env);
    if (url.pathname === '/tv/api' || url.pathname.startsWith('/tv/api/')) return tvApi(request, env);
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
    if (url.pathname === '/api/tv/pair/lookup') return tvPreview(request, env, actor);
    if (url.pathname === '/api/tv/pair/approve') return tvApprove(request, env, actor);
    if (url.pathname === '/api/tv/devices') return tvDevices(request, env, actor);
    const tvRevokeRoute = /^\/api\/tv\/devices\/([^/]+)\/revoke$/.exec(url.pathname);
    if (tvRevokeRoute) return tvRevoke(request, env, actor, tvRevokeRoute[1]);
    if (url.pathname === '/api/faxes/unresolved') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      try {
        if (!env.DB) throw new Error();
        const rows = await env.DB.prepare("SELECT id, status, created_at FROM fax_intents WHERE actor_id = ? AND status IN ('submitting', 'unknown', 'accepted') ORDER BY created_at, id").bind(actor).all();
        if (!rows.success || !Array.isArray(rows.results)) throw new Error();
        return Response.json({ intents: rows.results }, { headers: { 'Cache-Control': 'no-store' } });
      } catch { return Response.json({ error: 'Fax status unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
    }
    const pushRoute = /^\/api\/push\/devices(?:\/([^/]+))?$/.exec(url.pathname);
    if (pushRoute) return handlePushDevices(request, env, actor, pushRoute[1]);
    if (url.pathname === '/api/inbound-faxes') return handleInboundFaxRead(request, env, actor);
    if (url.pathname === '/api/inbound-fax-recovery') return handleFaxOperator(request, env, actor);
    const faxRecovery = /^\/api\/inbound-fax-recovery\/([^/]+)$/.exec(url.pathname);
    if (faxRecovery) return handleFaxOperator(request, env, actor, faxRecovery[1]);
    const inboundPdf = /^\/api\/inbound-faxes\/([^/]+)\/pdf$/.exec(url.pathname);
    if (inboundPdf) return handleInboundFaxRead(request, env, actor, inboundPdf[1]);
    if (url.pathname === '/api/mail-unresolved') return listUnresolvedMail(request, env, actor);
    const mail = /^\/api\/mail-drafts\/([^/]+)\/(review|send|status|acknowledge)$/.exec(url.pathname);
    if (mail) return handleMail(request, env, actor, mail[1], mail[2]);
    if (url.pathname === '/api/voice/session') return handleVoiceSession(request, env, actor);
    const voiceOwner = !env.VOICE_OWNER_SUBJECT || actor === env.VOICE_OWNER_SUBJECT;
    if ((url.pathname === '/api/voice/recordings' || url.pathname.startsWith('/api/voice/recordings/') || url.pathname === '/api/voice/calls') && !voiceOwner) {
      return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    const ownerOnly = url.pathname === '/api/voice/presence' || url.pathname === '/api/voice/availability' || url.pathname.startsWith('/api/sms/');
    if (ownerOnly && !voiceOwner) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    if (url.pathname === '/api/voice/presence') return handlePresence(request, env);
    if (url.pathname === '/api/voice/availability') return handleAvailability(request, env);
    if (url.pathname.startsWith('/api/sms/')) return handleSms(request, env);
    if (url.pathname === '/api/inbox' || url.pathname.startsWith('/api/inbox/')) {
      return handleInbox(request, env, { fax: inboundFaxAllowed(actor, env.INBOUND_FAX_ALLOWED_SUBJECTS), voice: voiceOwner });
    }
    if (url.pathname === '/api/voice/calls') return listCalls(request, env);
    if (url.pathname === '/api/voice/recordings') return listVoiceRecordings(request, env);
    const heard = /^\/api\/voice\/recordings\/([^/]+)\/heard$/.exec(url.pathname);
    if (heard) return markHeard(request, env, heard[1]);
    const recording = /^\/api\/voice\/recordings\/([^/]+)$/.exec(url.pathname);
    if (recording) return handleVoiceRecording(request, env, recording[1]);
    if (url.pathname === '/api/settings/voicemail') return voiceOwner ? handleVoicemailSettings(request, env) : new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    if (url.pathname === '/api/settings') return handleSettings(request, env, actor);
    if (url.pathname === '/api/cover-preview') return handleCoverPreview(request, env);
    if (url.pathname === '/api/recipients') return listRecipients(request, env, actor);
    if (url.pathname === '/api/transmissions') return request.method === 'POST' ? createTransmission(request, env, actor) : request.method === 'GET' ? listTransmissions(env, actor) : new Response('Method not allowed', { status: 405 });
    if (url.pathname === '/api/records') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      return listRecords(env, actor, { inboundAllowed: inboundFaxAllowed(actor, env.INBOUND_FAX_ALLOWED_SUBJECTS), voiceAllowed: voiceOwner });
    }
    const emailReview = /^\/api\/transmissions\/([^/]+)\/email\/(review|approve)$/.exec(url.pathname);
    if (emailReview) return (emailReview[2] === 'review' ? reviewEmail : approveEmail)(request, env, actor, emailReview[1]);
    const emailDelivery = /^\/api\/transmissions\/([^/]+)\/email(?:\/([^/]+)\/revoke)?$/.exec(url.pathname);
    if (emailDelivery) return emailDelivery[2] ? revokeEmailDelivery(request, env, actor, emailDelivery[1], emailDelivery[2]) : createEmailDelivery(request, env, actor, emailDelivery[1]);
    const transmissionFile = /^\/api\/transmissions\/([^/]+)\/(document|cover|packet)(?:\/([^/]+))?$/.exec(url.pathname);
    if (transmissionFile) return request.method === 'GET' ? getTransmissionFile(env, actor, transmissionFile[1], transmissionFile[2], transmissionFile[3]) : new Response('Method not allowed', { status: 405 });
    const mailReceipt = /^\/api\/transmissions\/([^/]+)\/mail\/([^/]+)\/receipt$/.exec(url.pathname);
    if (mailReceipt) return handleMailReceipt(request, env, actor, mailReceipt[1], mailReceipt[2]);
    const transmissionMail = /^\/api\/transmissions\/([^/]+)\/mail\/([^/]+)\/(review|approve)$/.exec(url.pathname);
    if (transmissionMail) return (transmissionMail[3] === 'review' ? reviewMail : approveMail)(request, env, actor, transmissionMail[1], transmissionMail[2]);
    const transmissionFax = /^\/api\/transmissions\/([^/]+)\/fax\/([^/]+)\/(review|approve)$/.exec(url.pathname);
    if (transmissionFax) return (transmissionFax[3] === 'review' ? reviewFax : approveFax)(request, env, actor, transmissionFax[1], transmissionFax[2]);
    const transmission = /^\/api\/transmissions\/([^/]+)$/.exec(url.pathname);
    if (transmission) return request.method === 'GET' ? getTransmission(env, actor, transmission[1]) : new Response('Method not allowed', { status: 405 });
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
