// Provision the owner's Access application before attaching the Worker hostname.
// Existing applications are never modified or adopted implicitly.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const hostname = 'simpledocs.justinharbour.dev';
const policy = '36ee1f67-a91a-494c-b503-94bf48820ffa';
if (!account || !token) throw new Error('Cloudflare credentials are required');

async function api(path, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(`Cloudflare Access request failed: ${response.status} ${JSON.stringify(body.errors)}`);
  return body;
}

const base = `/accounts/${account}/access/apps`;
let page = 1;
let matches = [];
let result;
do {
  result = await api(`${base}?per_page=100&page=${page++}`);
  matches.push(...result.result.filter(app => app.domain === hostname || app.self_hosted_domains?.includes(hostname)));
} while (page <= (result.result_info?.total_pages ?? 1));
if (matches.length > 1) throw new Error('Multiple Access applications match the hostname');
if (!matches.length) {
  const created = await api(base, { method: 'POST', body: JSON.stringify({
    name: 'Simpledocs', type: 'self_hosted', domain: hostname,
    allowed_idps: ['bc4cede3-4ee0-4bd6-9393-34c10ca6a6d8'],
    policies: [{ id: policy, precedence: 1 }],
  }) });
  matches = [created.result];
}
const app = (await api(`${base}/${matches[0].id}`)).result;
const policyResponse = await api(`${base}/${app.id}/policies?per_page=100`);
const policies = policyResponse.result;
if (app.name !== 'Simpledocs' || app.type !== 'self_hosted' || app.domain !== hostname ||
    app.allowed_idps?.length !== 1 || app.allowed_idps[0] !== 'bc4cede3-4ee0-4bd6-9393-34c10ca6a6d8' ||
    (policyResponse.result_info?.total_pages ?? 1) > 1 || policies.length !== 1 || policies[0].id !== policy || policies[0].decision !== 'allow' ||
    typeof app.aud !== 'string' || !/^[a-f0-9]{64}$/i.test(app.aud)) {
  throw new Error('Access application does not match the expected policy; refusing deployment');
}
// Managed OAuth lets the native apps sign in through the same Access policy.
const oauth = {
  enabled: true,
  dynamic_client_registration: { enabled: true, allowed_uris: ['dev.justinharbour.simpledocs:/oauth/callback'] },
  grant: { access_token_lifetime: '15m', session_duration: '720h' },
};
await api(`${base}/${app.id}`, { method: 'PUT', body: JSON.stringify({
  ...app, policies: app.policies.map(p => ({ id: p.id, precedence: p.precedence })), oauth_configuration: oauth,
}) });
// Telnyx cannot authenticate through Access; these two paths verify Telnyx's
// Ed25519 signature in the Worker instead. Everything else stays behind Access.
for (const path of ['/webhooks/telnyx/fax', '/api/webhooks/telnyx/voice']) {
  const domain = `${hostname}${path}`;
  const found = [];
  let p = 1, r;
  do {
    r = await api(`${base}?per_page=100&page=${p++}`);
    found.push(...r.result.filter(a => a.domain === domain));
  } while (p <= (r.result_info?.total_pages ?? 1));
  if (!found.length) {
    await api(base, { method: 'POST', body: JSON.stringify({
      name: `Simpledocs Telnyx webhook ${path}`, type: 'self_hosted', domain,
      policies: [{ name: 'Telnyx webhook bypass', decision: 'bypass', include: [{ everyone: {} }], precedence: 1 }],
    }) });
  }
}
// Audience is public metadata, not a credential. GitHub output passes it to Wrangler.
const { appendFile } = await import('node:fs/promises');
await appendFile(process.env.GITHUB_OUTPUT, `audience=${app.aud}\n`);
