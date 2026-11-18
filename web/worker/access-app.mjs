// Configure Access before Wrangler exposes either hostname. Never adopt an
// unexpected application, policy, destination, or OAuth configuration.
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PORTAL_PATHS } from './portal-paths.mjs';

const hosts = ['simpledocs.justinharbour.dev', 'simpledocs.justinharbour.com'];
const paths = ['/webhooks/telnyx/fax', '/api/webhooks/telnyx/voice', '/api/webhooks/telnyx/messaging'];
const policy = '36ee1f67-a91a-494c-b503-94bf48820ffa';
const idp = 'bc4cede3-4ee0-4bd6-9393-34c10ca6a6d8';
const callback = 'dev.justinharbour.simpledocs:/oauth/callback';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const portalOverrides = PORTAL_PATHS.map(path_pattern => ({ path_pattern, behavior: 'public' }));
const exactPortalOverrides = overrides => overrides?.length === PORTAL_PATHS.length && PORTAL_PATHS.every(path => overrides.some(rule => rule.path_pattern === path && rule.behavior === 'public'));
function destinations(app, allowed, required, ownerApp = false) {
  const ds = app.destinations;
  if (!Array.isArray(ds) || ds.some(d => d.type !== 'public' || !allowed.includes(d.uri) || ((d.overrides?.length ?? 0) !== 0 && !(ownerApp && d.uri === hosts[1] && exactPortalOverrides(d.overrides)))) ||
      new Set(ds.map(d => d.uri)).size !== ds.length || !required.every(uri => ds.some(d => d.uri === uri))) throw Error('Unexpected Access destinations');
}
function owner(app, policies, required) {
  destinations(app, hosts, required, true);
  if (app.name !== 'Simpledocs' || app.type !== 'self_hosted' || app.domain !== hosts[0] ||
      !same(app.allowed_idps, [idp]) || policies.length !== 1 || policies[0].id !== policy || policies[0].decision !== 'allow' ||
      typeof app.aud !== 'string' || !/^[a-f0-9]{64}$/i.test(app.aud) || !app.oauth_configuration?.enabled ||
      !app.oauth_configuration.dynamic_client_registration?.enabled || !app.oauth_configuration.dynamic_client_registration.allowed_uris?.includes(callback)) throw Error('Unexpected owner Access configuration');
}
function bypass(app, policies, path, required) {
  const allowed = hosts.map(host => host + path);
  destinations(app, allowed, required);
  if (app.name !== `Simpledocs Telnyx webhook ${path}` || app.type !== 'self_hosted' || app.domain !== allowed[0] ||
      policies.length !== 1 || policies[0].decision !== 'bypass' || !same(policies[0].include, [{ everyone: {} }]) ||
      (policies[0].exclude?.length ?? 0) || (policies[0].require?.length ?? 0)) throw Error('Unexpected webhook Access configuration');
}
export async function configureAccess(api, publishPortal = false) {
  const base = '/access/apps';
  async function list() {
    let page = 1, all = [], r;
    do { r = await api(`${base}?per_page=100&page=${page++}`); all.push(...r.result); } while (page <= (r.result_info?.total_pages ?? 1));
    return all;
  }
  const all = await list();
  const specs = [{ path: '', check: owner }, ...paths.map(path => ({ path, check: bypass }))];
  const selected = [];
  for (const spec of specs) {
    const expected = hosts.map(h => h + spec.path);
    const found = all.filter(a => a.domain === expected[0] || a.destinations?.some(d => d.uri === expected[0]));
    if (found.length !== 1 || all.some(a => a.id !== found[0]?.id && (a.domain === expected[1] || a.destinations?.some(d => d.uri === expected[1])))) throw Error('Missing or conflicting Access application');
    const app = (await api(`${base}/${found[0].id}`)).result;
    const response = await api(`${base}/${app.id}/policies?per_page=100`);
    if ((response.result_info?.total_pages ?? 1) > 1) throw Error('Unexpected policy pagination');
    const validate = required => spec.path ? spec.check(app, response.result, spec.path, required) : spec.check(app, response.result, required);
    validate([expected[0]]);
    selected.push({ ...spec, app, expected });
  }
  // Add webhook destinations first; no hostname is routed to the Worker yet.
  for (const item of [...selected.slice(1), selected[0]]) {
    const { app, expected, path, check } = item;
    const publish = !path && (publishPortal || app.destinations.some(d => d.uri === hosts[1] && exactPortalOverrides(d.overrides)));
    if (publishPortal && path) continue;
    const updated = { ...app, destinations: expected.map(uri => ({ type: 'public', uri, ...(publish && uri === hosts[1] ? { overrides: portalOverrides } : {}) })), policies: app.policies.map(p => ({ id: p.id, precedence: p.precedence })) };
    if (!path) updated.eager_redirect_cookie_setting = false;
    await api(`${base}/${app.id}`, { method: 'PUT', body: JSON.stringify(updated) });
    const confirmed = (await api(`${base}/${app.id}`)).result;
    const ps = await api(`${base}/${app.id}/policies?per_page=100`);
    if ((ps.result_info?.total_pages ?? 1) > 1) throw Error('Unexpected policy pagination');
    if (path) check(confirmed, ps.result, path, expected); else {
      check(confirmed, ps.result, expected);
      if (confirmed.aud !== app.aud || !same(confirmed.oauth_configuration, app.oauth_configuration) || confirmed.eager_redirect_cookie_setting !== false) throw Error('Access audience or OAuth changed');
      if (publish && !exactPortalOverrides(confirmed.destinations.find(d => d.uri === hosts[1])?.overrides)) throw Error('Exact recipient Access overrides were not retained');
    }
  }
  return selected[0].app.aud;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token || !process.env.GITHUB_OUTPUT) throw Error('Cloudflare credentials and GitHub output are required');
  async function api(path, options = {}) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    const body = await response.json();
    if (!response.ok || !body.success) throw Error(`Cloudflare Access request failed: ${response.status} ${JSON.stringify(body.errors)}`);
    return body;
  }
  const audience = await configureAccess(api, process.argv.includes('--publish-portal'));
  await appendFile(process.env.GITHUB_OUTPUT, `audience=${audience}\n`);
}
