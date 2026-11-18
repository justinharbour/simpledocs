import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const DEFAULT_FROM_NUMBER = '+12134147728';
export const DEFAULT_SENDER_NAME = 'Justin Harbour';

// pdf-lib's standard fonts only encode WinAnsi, so anything else is replaced.
const clean = (value, max) => String(value ?? '').replace(/[\r\t]+/g, ' ').replace(/[^\n\x20-\x7e\xa0-\xff]/g, '?').slice(0, max);

function wrap(text, font, size, width) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

export async function buildCoverPage({ to, toNumber, from, fromNumber, subject, message, date, pages, numbering }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const left = 56, width = 500, ink = rgb(0.1, 0.1, 0.1), muted = rgb(0.4, 0.4, 0.4);
  page.drawText('FAX', { x: left, y: 700, size: 44, font: bold, color: ink });
  page.drawLine({ start: { x: left, y: 684 }, end: { x: left + width, y: 684 }, thickness: 1.5, color: ink });
  const rows = [
    ['To', [clean(to, 120), clean(toNumber, 40)].filter(Boolean).join('  ')],
    ['From', [clean(from, 120), clean(fromNumber, 40)].filter(Boolean).join('  ')],
    ['Date', clean(date, 60)],
    ['Pages', pages ? `${Number(pages) + 1} including cover` : ''],
    ['Subject', clean(subject, 200)],
    ['Envelope', numbering?.envelopeNumber],
    ['Documents', numbering?.documentNumbers.join('  ')],
  ];
  let y = 652;
  for (const [label, value] of rows) {
    if (!value) continue;
    page.drawText(label.toUpperCase(), { x: left, y, size: 9, font: bold, color: muted });
    const lines = wrap(value, regular, 13, width - 90).slice(0, 3);
    lines.forEach((line, i) => page.drawText(line, { x: left + 90, y: y - i * 16, size: 13, font: regular, color: ink }));
    y -= Math.max(1, lines.length) * 16 + 14;
  }
  const body = clean(message, 2000).trim();
  if (body) {
    y -= 8;
    page.drawLine({ start: { x: left, y: y + 12 }, end: { x: left + width, y: y + 12 }, thickness: 0.5, color: muted });
    y -= 12;
    const lines = wrap(body, regular, 12, width);
    const slots = Math.max(0, Math.min(28, 1 + Math.floor((y - 48) / 16)));
    for (const [i, line] of lines.slice(0, slots).entries()) {
      page.drawText(i === slots - 1 && lines.length > slots ? '...' : line, { x: left, y: y - i * 16, size: 12, font: regular, color: ink });
    }
  }
  return pdf.save();
}

export async function countPages(bytes) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  return pdf.getPageCount();
}

export async function prependCover(coverBytes, documentBytes) {
  const out = await PDFDocument.create();
  for (const bytes of [coverBytes, documentBytes]) {
    const source = await PDFDocument.load(bytes, { updateMetadata: false });
    const copied = await out.copyPages(source, source.getPageIndices());
    copied.forEach(page => out.addPage(page));
  }
  return out.save();
}
