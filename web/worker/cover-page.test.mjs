import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { buildCoverPage, countPages, prependCover, DEFAULT_FROM_NUMBER } from './cover-page.mjs';
import { samplePdf } from './test-env.mjs';

const fields = { to: 'Ada Lovelace', toNumber: '+15125550100', from: 'Justin Harbour', fromNumber: DEFAULT_FROM_NUMBER, subject: 'Lease', message: 'Please sign and return.\nThank you.', date: '2026-11-16', pages: 2 };

test('cover page is a valid one-page PDF', async () => {
  const bytes = await buildCoverPage(fields);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
});

test('cover page tolerates unsupported characters and very long text', async () => {
  const bytes = await buildCoverPage({ ...fields, subject: '日本語 ✓ '.repeat(40), message: 'word '.repeat(2000), to: 'x'.repeat(500) });
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
});

test('cover is prepended before the document pages', async () => {
  const merged = await prependCover(await buildCoverPage(fields), await samplePdf(3));
  assert.equal(await countPages(merged), 4);
});

test('countPages rejects bytes that are not a PDF', async () => {
  await assert.rejects(countPages(new TextEncoder().encode('%PDF-not really')));
});
