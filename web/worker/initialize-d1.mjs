// One-time initialization. Never adopt or migrate a pre-existing database.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error('Cloudflare credentials required');
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database`;
const result = await fetch(`${base}?name=simpledocs-d1-prod&per_page=100`, { headers: { Authorization: `Bearer ${token}` } });
const data = await result.json();
if (!result.ok || !data.success || !Array.isArray(data.result) || (data.result_info?.total_pages ?? 1) > 1) throw new Error('D1 inventory failed');
if (data.result.some(db => db.name === 'simpledocs-d1-prod')) throw new Error('Database already exists; refusing to adopt or change it');
const wrangler = './node_modules/.bin/wrangler';
execFileSync(wrangler, ['d1', 'create', 'simpledocs-d1-prod', '--update-config=false'], { stdio: 'inherit' });
const lookup = await fetch(`${base}?name=simpledocs-d1-prod&per_page=100`, { headers: { Authorization: `Bearer ${token}` } });
const created = await lookup.json();
const matches = created.result?.filter(db => db.name === 'simpledocs-d1-prod') ?? [];
if (!lookup.ok || !created.success || matches.length !== 1 || !/^[0-9a-f-]{36}$/i.test(matches[0].uuid)) throw new Error('Could not uniquely verify created database');
const databaseId = matches[0].uuid;
writeFileSync('wrangler.d1-initialize.json', JSON.stringify({ name: 'simpledocs-migrations', compatibility_date: '2026-11-16', d1_databases: [{ binding: 'DB', database_name: 'simpledocs-d1-prod', database_id: databaseId, migrations_dir: '../backend/core/migrations' }] }));
execFileSync(wrangler, ['d1', 'migrations', 'apply', 'simpledocs-d1-prod', '--remote', '--config', 'wrangler.d1-initialize.json'], { stdio: 'inherit' });
execFileSync(wrangler, ['d1', 'migrations', 'list', 'simpledocs-d1-prod', '--remote', '--config', 'wrangler.d1-initialize.json'], { stdio: 'inherit' });
const output = execFileSync(wrangler, ['d1', 'execute', 'simpledocs-d1-prod', '--remote', '--config', 'wrangler.d1-initialize.json', '--json', '--command', "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"], { encoding: 'utf8' });
const names = JSON.parse(output)[0].results.map(row => row.name);
for (const name of ['d1_migrations', 'document_revisions', 'jobs', 'deliveries', 'submission_intents', 'proofs', 'approvals', 'provider_events', 'audit_events', 'mail_drafts', 'fax_intents']) {
  if (!names.includes(name)) throw new Error(`Missing table ${name}`);
}
console.log(`Verified tables: ${names.join(', ')}`);
console.log(`Initialized database ID: ${databaseId}`);
