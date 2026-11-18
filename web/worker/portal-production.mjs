import { importPortalKey } from './portal-crypto.mjs';
import { PORTAL_PATHS } from './portal-paths.mjs';

const recipientHost = 'simpledocs.justinharbour.com';
const legacyHost = 'simpledocs.justinharbour.dev';
const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, PORTAL_KEY, TELNYX_API_TOKEN, TELNYX_VERIFY_PROFILE_ID } = process.env;
if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID) throw Error('Missing Cloudflare deploy credentials');
await importPortalKey(PORTAL_KEY).catch(() => { throw Error('Configure the dedicated PORTAL_KEY repository secret: 32 random bytes encoded as base64url'); });
if (process.env.PORTAL_PREVIOUS_KEY) await importPortalKey(process.env.PORTAL_PREVIOUS_KEY).catch(() => { throw Error('Invalid optional PORTAL_PREVIOUS_KEY'); });
if (!TELNYX_API_TOKEN || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(TELNYX_VERIFY_PROFILE_ID ?? '')) throw Error('Configure the dedicated Simpledocs TELNYX_VERIFY_PROFILE_ID and TELNYX_API_TOKEN');

async function get(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw Error(`Preflight read failed: ${new URL(url).pathname} (${res.status})`);
  return res.json();
}
const account = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}`;
const cf = path => get(path.startsWith('/') ? `${account}${path}` : path, CLOUDFLARE_API_TOKEN);
const verify = await get(`https://api.telnyx.com/v2/verify_profiles/${TELNYX_VERIFY_PROFILE_ID}`, TELNYX_API_TOKEN);
const usCanadaOnly = channel => [...new Set(channel?.whitelisted_destinations)].sort().join(',') === 'CA,US';
if (verify.data?.id !== TELNYX_VERIFY_PROFILE_ID || !/^Simpledocs\b/i.test(verify.data.name ?? '') || verify.data.daily_spend_limit_enabled !== true || !(Number(verify.data.daily_spend_limit) > 0) || verify.data.webhook_url || verify.data.webhook_failover_url || !usCanadaOnly(verify.data.sms) || !usCanadaOnly(verify.data.call)) {
  throw Error('Verify requires a dedicated Simpledocs profile with a daily spend cap, US/Canada destinations only, and no external webhook');
}
const limits = (await cf('/email/sending/limits')).result;
if (limits?.recipient_mode !== 'arbitrary' || limits.usage?.over_quota !== false) throw Error('Cloudflare Email Sending needs arbitrary-recipient mode and available quota');
const root = 'https://api.cloudflare.com/client/v4/zones';
const zones = (await cf(`${root}?name=justinharbour.com&account.id=${CLOUDFLARE_ACCOUNT_ID}`)).result;
if (zones?.length !== 1) throw Error('Could not verify the sender zone');
const sending = `${root}/${zones[0].id}/email/sending/subdomains`;
const domain = (await cf(sending)).result?.find(x => x.name === 'mail.justinharbour.com' && x.enabled === true);
if (!domain || (await cf(`${sending}/${domain.id}/dns/status`)).result?.status !== 'ready') throw Error('Configure and verify Email Sending DNS for mail.justinharbour.com');

const apps = [];
let response, page = 1;
do {
  response = await cf(`/access/apps?per_page=100&page=${page++}`);
  apps.push(...response.result);
} while (page <= (response.result_info?.total_pages ?? 1));
const uri = app => [...new Set([app.domain, ...(app.destinations ?? []).map(d => d.uri), ...(app.self_hosted_domains ?? [])].filter(Boolean))];
for (const app of apps) {
  if (uri(app).some(d => [legacyHost, recipientHost].some(host => d.startsWith(`${host}/portal`)))) throw Error('Unexpected separate recipient Access application; use exact destination overrides');
}
if (process.argv.includes('--check-edge')) {
  const probe = async (host, path, accepted) => {
    const response = await fetch(`https://${host}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (!(await accepted(response))) throw Error(`Unexpected no-auth edge response for ${host}${path}: ${response.status}`);
  };
  const protectedRoute = r => [302, 401, 403].includes(r.status);
  await probe(recipientHost, '/portal', async r => r.ok && (await r.text()).includes('Access code from your email'));
  for (const path of PORTAL_PATHS.slice(1)) await probe(recipientHost, path, async r => r.status === 404 && (await r.json()).error === 'Unavailable');
  for (const host of [legacyHost, recipientHost]) {
    for (const path of ['/', '/api/transmissions', '/portal/adjacent', '/portal/document/']) await probe(host, path, protectedRoute);
  }
  for (const path of PORTAL_PATHS) await probe(legacyHost, path, protectedRoute);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Recipient portal release proof\n\n- Commit: \`${process.env.GITHUB_SHA}\`\n- Provider configuration: verified with production workflow credentials; no sends\n- Edge: canonical landing reachable; recipient session required; both owner hosts and non-recipient paths protected\n- Live email, SMS, and voice delivery: not run (separate authorization required)\n`);
  }
}
console.log('Portal production prerequisites verified without sending communications.');
