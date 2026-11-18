import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';

const dir = new URL('../../backend/core/migrations/', import.meta.url);

// A D1-shaped wrapper over node:sqlite with every real migration applied.
export function makeEnv(extra = {}) {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, dir), 'utf8'));
  const run = (sql, args) => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; };
  const DB = {
    prepare(sql) {
      const bound = args => ({
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async run() { return run(sql, args); },
        async all() { return { success: true, results: db.prepare(sql).all(...args) }; },
      });
      return { ...bound([]), bind: (...args) => bound(args) };
    },
  };
  const objects = new Map();
  const FILES = {
    async put(key, value) { objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value)); },
    async get(key) { const v = objects.get(key); return v ? { body: new Blob([v]).stream(), arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) } : null; },
  };
  const queue = { sent: [], failNext: false, async send(message) { if (this.failNext) throw new Error('queue down'); this.sent.push(message); } };
  const env = {
    DB, FILES, DELIVERIES: queue,
    FAX_ENABLED: 'true', MAIL_ENABLED: 'true', TELNYX_API_TOKEN: 'token', TELNYX_FAX_CONNECTION_ID: 'conn', TELNYX_FAX_FROM: '+12134147728',
    POSTGRID_TEST_KEY: 'test_sk_abcdef', POSTGRID_LIVE_KEY: 'live_sk_abcdef',
    ...extra,
  };
  return { env, db, objects, queue };
}

export async function samplePdf(pages = 2) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([612, 792]).drawText(`Page ${i + 1}`, { x: 72, y: 700 });
  return pdf.save();
}

export const address = { firstName: 'Ada', lastName: 'Lovelace', addressLine1: '1 Main St', city: 'Austin', provinceOrState: 'TX', postalOrZip: '78701', countryCode: 'US' };

export async function sendRequest(spec, pdf, url = 'https://example.test/api/transmissions') {
  const form = new FormData();
  form.set('document', new File([pdf], 'lease.pdf', { type: 'application/pdf' }));
  form.set('spec', JSON.stringify(spec));
  return new Request(url, { method: 'POST', body: form, headers: { origin: new URL(url).origin } });
}

export const jsonRequest = (path, body, method = 'POST') => new Request(`https://example.test${path}`, { method, body: JSON.stringify(body), headers: { origin: 'https://example.test', 'content-type': 'application/json' } });
