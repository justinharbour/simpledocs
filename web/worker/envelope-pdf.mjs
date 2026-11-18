import { PDFArray, PDFDocument, PDFName } from 'pdf-lib';
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_PAGES } from '../shared/envelope.mjs';

// Page copying does not preserve all document-level semantics. Refuse common
// interactive/signed inputs instead of silently dropping fields or signatures.
// This is not a sanitizer, renderer, or proof that the source is safe to open.
function checkForCopy(pdf) {
  if (['AcroForm', 'Perms', 'Collection', 'OpenAction', 'AA', 'Names'].some(key => pdf.catalog.has(PDFName.of(key))) ||
      pdf.getPages().some(page => {
        const annotations = page.node.lookup(PDFName.of('Annots'));
        return (annotations && (!(annotations instanceof PDFArray) || annotations.size() > 0)) || page.node.has(PDFName.of('AA'));
      })) {
    throw new Error('A PDF with annotations, forms, signatures or interactive features cannot be combined. Export a flattened copy and try again.');
  }
}

export async function assembleEnvelope(files, copyForFax) {
  const combined = files.length > 1 ? await PDFDocument.create() : null;
  const documents = [];
  let pages = 0, bytes;
  for (const file of files) {
    bytes = new Uint8Array(await file.arrayBuffer());
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('Choose PDF files only.');
    let pdf, pageCount;
    try {
      pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
      pageCount = pdf.getPageCount();
      if (pageCount < 1) throw new Error();
    } catch { throw new Error('A PDF could not be read. Export an unencrypted copy and try again.'); }
    pages += pageCount;
    if (pages > MAX_DOCUMENT_PAGES) throw new Error(`Choose up to ${MAX_DOCUMENT_PAGES} pages in total.`);
    if (combined || copyForFax) checkForCopy(pdf);
    if (combined) {
      try {
        for (const page of await combined.copyPages(pdf, pdf.getPageIndices())) combined.addPage(page);
      } catch { throw new Error('The PDFs could not be combined. Export new copies and try again.'); }
    }
    documents.push({ name: [...file.name.replace(/\p{C}/gu, '')].slice(0, 200).join('').trim() || 'Document.pdf', pageCount });
  }
  if (combined) bytes = await combined.save();
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error('The combined PDF exceeds 5 MB. Choose smaller PDFs.');
  return { bytes, pages, documents };
}
