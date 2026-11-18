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
if (verify.data?.id !== TELNYX_VERIFY_PROFILE_ID || !/^Simpledocs\b/i.test(verify.data.name ?? '') || verify.data.daily_spend_limit_enabled !== true || !(Number(verify.data.daily_spend_limit) > 0) || verify.data.webhook_url || verify.data.webhook_failover_url) {
  throw Error('Verify requires a dedicated Simpledocs profile with a daily spend cap and no external webhook');
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
for (const path of PORTAL_PATHS) {
  const expected = recipientHost + path;
  const matched = apps.filter(a => uri(a).includes(expected));
  if (matched.length !== 1 || matched[0].type !== 'self_hosted' || uri(matched[0]).length !== 1 || matched[0].destinations?.some(d => d.type !== 'public' || d.overrides?.length)) throw Error(`Configure one Access application for ${expected} only`);
  const policy = await cf(`/access/apps/${matched[0].id}/policies?per_page=100`);
  const p = policy.result?.[0];
  if ((policy.result_info?.total_pages ?? 1) !== 1 || policy.result?.length !== 1 || p.decision !== 'bypass' || JSON.stringify(p.include) !== '[{"everyone":{}}]' || p.require?.length || p.exclude?.length) throw Error(`Unexpected Access policy for ${expected}`);
}
for (const app of apps) {
  if (uri(app).some(d => d.startsWith(`${legacyHost}/portal`) || (d.startsWith(`${recipientHost}/portal`) && !PORTAL_PATHS.some(path => d === recipientHost + path)))) throw Error('Unexpected overlapping or legacy-host recipient Access application');
}
console.log('Portal production prerequisites verified without sending communications.');
