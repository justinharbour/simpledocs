import { PDFArray, PDFDocument, PDFName, PDFPage, PDFRawStream, StandardFonts } from 'pdf-lib';
import { formatDocumentNumber, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_PAGES } from '../shared/envelope.mjs';

const HEADER_HEIGHT = 24;
const MAX_DECODED_CONTENT = 16 * 1024 * 1024;
const HEADER_UNSUPPORTED = 'Page headers cannot be added to this PDF. Export a flattened copy with standard, unrotated pages, or turn off page headers.';
const name = PDFName.of;

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

async function checkContentSize(page, budget) {
  if (!page.node.has(name('Contents'))) return false; // A blank page is still a page.
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map(ref => page.node.context.lookup(ref)) : [contents];
  for (const stream of streams) {
    if (!(stream instanceof PDFRawStream) || ['DecodeParms', 'F', 'FFilter', 'FDecodeParms'].some(key => stream.dict.has(name(key)))) throw new Error(HEADER_UNSUPPORTED);
    const filter = stream.dict.lookup(name('Filter'));
    if (!filter) budget.remaining -= stream.contents.byteLength;
    else {
      if (filter !== name('FlateDecode')) throw new Error(HEADER_UNSUPPORTED);
      const reader = new Blob([stream.contents]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          budget.remaining -= value.byteLength;
          if (budget.remaining < 0) break;
        }
      } finally { await reader.cancel(); }
    }
    if (budget.remaining < 0) throw new Error('The PDFs are too complex to add page headers. Export simpler copies or turn off page headers.');
  }
  return streams.length > 0;
}

async function prepareHeaderPage(original, budget) {
  const { x, y, width, height } = original.getMediaBox();
  const crop = original.getCropBox();
  // Embedding does not honor page rotation or page-level printing and blending
  // settings. Refuse ambiguous geometry, including a crop that hides content.
  if (original.getRotation().angle !== 0 || x !== 0 || y !== 0 || !Number.isFinite(width) || !Number.isFinite(height) || width < 144 || height < 144 || width > 1440 || height > 1440 ||
      crop.x !== x || crop.y !== y || crop.width !== width || crop.height !== height ||
      original.node.Resources()?.has(name('Properties')) ||
      ['UserUnit', 'Group', 'TrimBox', 'BleedBox', 'ArtBox', 'VP', 'PresSteps'].some(key => original.node.has(name(key)))) throw new Error(HEADER_UNSUPPORTED);
  if (!await checkContentSize(original, budget)) return { width, height, source: null };

  // Do not copy donor metadata, private page dictionaries, thumbnails or the
  // rest of the donor's page tree. Only the page's drawing and its resources
  // are needed in the form. Embedding is not a general PDF redaction tool.
  const node = original.node.clone();
  const resources = original.node.getInheritableAttribute(name('Resources'));
  for (const key of node.keys()) if (!['/Type', '/Contents', '/MediaBox'].includes(key.asString())) node.delete(key);
  node.set(name('MediaBox'), original.node.MediaBox());
  if (resources) node.set(name('Resources'), resources);
  return { width, height, source: PDFPage.of(node, original.ref, original.doc) };
}

async function addHeaderPages(out, pdf, budget) {
  const prepared = [];
  for (const original of pdf.getPages()) prepared.push(await prepareHeaderPage(original, budget));
  const withContent = prepared.filter(p => p.source);
  const embedded = await out.embedPages(withContent.map(p => p.source), withContent.map(({ width, height }) => ({ left: 0, bottom: 0, right: width, top: height })));
  // Embed now, before allocating an envelope number. A single embedPages call
  // shares copied fonts/images across the pages of a document.
  for (const form of embedded) await form.embed();
  let index = 0;
  return prepared.map(({ width, height, source }) => {
    const page = out.addPage([width, height]);
    if (source) {
      const scale = (height - HEADER_HEIGHT) / height;
      page.drawPage(embedded[index++], { x: (width - width * scale) / 2, y: 0, xScale: scale, yScale: scale });
    }
    return page;
  });
}

export async function assembleEnvelope(files, copyForFax, headers = false) {
  const combined = headers || files.length > 1 ? await PDFDocument.create() : null;
  const budget = { remaining: MAX_DECODED_CONTENT };
  const headerPages = [];
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
    if (headers) {
      if (['OCProperties', 'OutputIntents'].some(key => pdf.catalog.has(name(key)))) throw new Error(HEADER_UNSUPPORTED);
      const position = documents.length + 1;
      try {
        for (const page of await addHeaderPages(combined, pdf, budget)) headerPages.push({ page, position });
      } catch (error) {
        if (error?.message === HEADER_UNSUPPORTED || budget.remaining < 0) throw error;
        throw new Error(HEADER_UNSUPPORTED);
      }
    } else if (combined) {
      try {
        for (const page of await combined.copyPages(pdf, pdf.getPageIndices())) combined.addPage(page);
      } catch { throw new Error('The PDFs could not be combined. Export new copies and try again.'); }
    }
    documents.push({ name: [...file.name.replace(/\p{C}/gu, '')].slice(0, 200).join('').trim() || 'Document.pdf', pageCount });
  }
  if (headers) {
    const font = await combined.embedFont(StandardFonts.Helvetica);
    return { pages, documents, async stamp(envelopeNumber) {
      let stamped;
      try {
        for (const { page, position } of headerPages) {
          page.drawText(`Document ${formatDocumentNumber(envelopeNumber, position)}`, { x: 12, y: page.getHeight() - 16, size: 9, font });
        }
        stamped = await combined.save();
      } catch { throw new Error(HEADER_UNSUPPORTED); }
      if (stamped.byteLength > MAX_DOCUMENT_BYTES) throw new Error('The PDF with page headers exceeds 5 MB. Choose smaller PDFs or turn off page headers.');
      return stamped;
    } };
  }
  if (combined) bytes = await combined.save();
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error('The combined PDF exceeds 5 MB. Choose smaller PDFs.');
  return { bytes, pages, documents };
}
