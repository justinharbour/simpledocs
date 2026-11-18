import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureAccess } from './access-app.mjs';
import { PORTAL_PATHS } from './portal-paths.mjs';

const old = 'simpledocs.justinharbour.dev', next = 'simpledocs.justinharbour.com';
const paths = ['/webhooks/telnyx/fax', '/api/webhooks/telnyx/voice', '/api/webhooks/telnyx/messaging'];
function fixture() {
  const apps = [{ id: 'owner', name: 'Simpledocs', type: 'self_hosted', domain: old, destinations: [{ type: 'public', uri: old }], allowed_idps: ['bc4cede3-4ee0-4bd6-9393-34c10ca6a6d8'], aud: 'a'.repeat(64), oauth_configuration: { enabled: true, dynamic_client_registration: { enabled: true, allowed_uris: ['dev.justinharbour.simpledocs:/oauth/callback'] } }, policies: [{ id: '36ee1f67-a91a-494c-b503-94bf48820ffa', precedence: 1 }] }, ...paths.map((path, i) => ({ id: `b${i}`, name: `Simpledocs Telnyx webhook ${path}`, type: 'self_hosted', domain: old + path, destinations: [{ type: 'public', uri: old + path }], policies: [{ id: `p${i}`, precedence: 1 }] }))];
  const policies = { owner: [{ id: '36ee1f67-a91a-494c-b503-94bf48820ffa', decision: 'allow' }] };
  paths.forEach((_, i) => { policies[`b${i}`] = [{ decision: 'bypass', include: [{ everyone: {} }], exclude: [], require: [] }]; });
  const writes = [];
  async function api(path, options = {}) {
    const id = path.match(/^\/access\/apps\/([^/?]+)/)?.[1];
    if (!id) return { result: structuredClone(apps), result_info: { total_pages: 1 } };
    if (path.includes('/policies')) return { result: structuredClone(policies[id]), result_info: { total_pages: 1 } };
    const index = apps.findIndex(a => a.id === id);
    if (options.method === 'PUT') { writes.push(id); apps[index] = JSON.parse(options.body); }
    return { result: structuredClone(apps[index]) };
  }
  return { apps, policies, writes, api };
}
test('extends existing apps with matching paths before owner and preserves audience and OAuth', async () => {
  const f = fixture();
  f.apps[0].oauth_configuration.dynamic_client_registration.allowed_uris.push('other-app:/oauth/callback');
  assert.equal(await configureAccess(f.api), 'a'.repeat(64));
  assert.deepEqual(f.writes, ['b0', 'b1', 'b2', 'owner']);
  assert.deepEqual(f.apps[0].destinations.map(d => d.uri), [old, next]);
  assert.equal(f.apps[0].eager_redirect_cookie_setting, false);
  assert.deepEqual(f.apps[0].oauth_configuration.dynamic_client_registration.allowed_uris, ['dev.justinharbour.simpledocs:/oauth/callback', 'other-app:/oauth/callback', 'com.justinharbour.simpledocs:/oauth/callback']);
  assert.deepEqual(f.apps[1].destinations.map(d => d.uri), [old + paths[0], next + paths[0]]);
  await configureAccess(f.api);
  assert.equal(f.apps[0].oauth_configuration.dynamic_client_registration.allowed_uris.filter(uri => uri === 'com.justinharbour.simpledocs:/oauth/callback').length, 1);
});
test('rejects invalid ownership or legacy OAuth before any write', async () => {
  for (const mutate of [
    f => { f.apps[0].allowed_idps = ['unexpected']; },
    f => { f.apps[0].oauth_configuration.dynamic_client_registration.allowed_uris = []; },
    f => { f.apps[0].oauth_configuration.dynamic_client_registration.enabled = false; },
    f => { f.apps[0].oauth_configuration.dynamic_client_registration.allowed_uris.push('dev.justinharbour.simpledocs:/oauth/callback'); },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(configureAccess(f.api), /Unexpected owner/);
    assert.deepEqual(f.writes, []);
  }
});
test('fails closed on changed OAuth, authentication, policies or overrides in readback', async () => {
  for (const mutate of [
    app => { app.oauth_configuration.dynamic_client_registration.allowed_uris.pop(); },
    app => { app.allowed_idps = ['unexpected']; },
    app => { app.session_duration = '1h'; },
    app => { app.destinations[0].overrides = [{ path_pattern: '/*', behavior: 'public' }]; },
  ]) {
    const f = fixture();
    f.apps[0].session_duration = '24h';
    const api = async (path, options) => {
      const result = await f.api(path, options);
      if (path === '/access/apps/owner' && !options && f.writes.includes('owner')) mutate(result.result);
      return result;
    };
    await assert.rejects(configureAccess(api));
  }
  const f = fixture();
  const api = async (path, options) => {
    const result = await f.api(path, options);
    if (path === '/access/apps/owner/policies?per_page=100' && f.writes.includes('owner')) result.result[0].include = [{ everyone: {} }];
    return result;
  };
  await assert.rejects(configureAccess(api), /policies changed/);
});
test('refuses a concurrent change before owner write', async () => {
  const f = fixture();
  let reads = 0;
  const api = async (path, options) => {
    const result = await f.api(path, options);
    if (path === '/access/apps/owner' && !options && ++reads === 2) result.result.allowed_idps = ['unexpected'];
    return result;
  };
  await assert.rejects(configureAccess(api), /changed before update/);
  assert.ok(!f.writes.includes('owner'));
});
test('fails before writes on conflicting target or unsafe webhook policy', async () => {
  const f = fixture();
  f.apps.push({ id: 'conflict', domain: next });
  await assert.rejects(configureAccess(f.api));
  assert.deepEqual(f.writes, []);
  const g = fixture(); g.policies.b0[0].decision = 'allow';
  await assert.rejects(configureAccess(g.api));
  assert.deepEqual(g.writes, []);
});
test('fails closed if readback changes audience', async () => {
  const f = fixture();
  const api = async (path, options) => { const r = await f.api(path, options); if (path === '/access/apps/owner' && !options && f.writes.includes('owner')) r.result.aud = 'b'.repeat(64); return r; };
  await assert.rejects(configureAccess(api), /audience/);
});

test('publishes exact portal paths on the production destination only and preserves them on redeploy', async () => {
  const f = fixture();
  await configureAccess(f.api);
  f.writes.length = 0;
  await configureAccess(f.api, true);
  assert.deepEqual(f.writes, ['owner']);
  const overrides = PORTAL_PATHS.map(path_pattern => ({ path_pattern, behavior: 'public' }));
  assert.deepEqual(f.apps[0].destinations, [{ type: 'public', uri: old }, { type: 'public', uri: next, overrides }]);
  await configureAccess(f.api);
  assert.deepEqual(f.apps[0].destinations[1].overrides, overrides);
  f.apps[0].destinations[1].overrides = [{ path_pattern: '/portal/*', behavior: 'public' }];
  f.writes.length = 0;
  await assert.rejects(configureAccess(f.api, true), /Unexpected Access destinations/);
  assert.deepEqual(f.writes, []);
});
