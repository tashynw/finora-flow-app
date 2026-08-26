/**
 * A one-page PDF with a real text layer, built here rather than committed.
 *
 * The review workspace can only be tested against a document the reader can
 * actually read. A binary fixture would do that too, but nobody reviewing this
 * repository could see what the test document says, and a change to its wording
 * would arrive as an unreadable diff. Assembling the bytes means the document is
 * legible in the source and byte-identical on every run, which is what lets the
 * screens that display it have baselines.
 *
 * Deliberately minimal, and deliberately valid: cross-reference offsets are
 * computed rather than faked, because the reader's parser follows them and a
 * document it has to repair would be testing recovery instead of reading.
 */

/** Escapes the three characters that end a PDF string literal early. */
function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 64;
const FONT_SIZE = 11;
const LINE_HEIGHT = 18;

/**
 * A single-page document containing the given lines, one per line, in Helvetica.
 *
 * Helvetica because it is one of the fourteen fonts every PDF reader must
 * provide, so nothing has to be embedded and the file stays legible here.
 */
export function textPdf(lines: string[]): Buffer {
  const content =
    `BT /F1 ${FONT_SIZE} Tf ${MARGIN} ${PAGE_HEIGHT - MARGIN} Td ${LINE_HEIGHT} TL\n` +
    lines.map((line) => `(${escapeText(line)}) Tj T*\n`).join('') +
    'ET\n';

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]` +
      '/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>',
    `<</Length ${Buffer.byteLength(content, 'latin1')}>>\nstream\n${content}endstream`,
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const startxref = Buffer.byteLength(body, 'latin1');
  // Twenty bytes per entry exactly, including the trailing space before the
  // newline. A reader that seeks by offset within the table depends on it.
  const table = offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');

  const tail =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${table}` +
    `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\n` +
    `startxref\n${startxref}\n%%EOF\n`;

  return Buffer.from(body + tail, 'latin1');
}

/**
 * The invoice the review workspace is tested against.
 *
 * Every value a reviewer has to check is here for a reason. The title settles the
 * kind, the labelled fields are what the deterministic rules find, the amounts
 * add up so a genuine arithmetic warning would stand out as a failure, and the
 * bank details raise the one warning that cannot be cleared from the screen. A
 * tax registration number is deliberately absent, so the workspace has to cope
 * with a value that is simply not on the document.
 */
export const INVOICE_LINES = [
  'KINGSTON SUPPLIES LIMITED',
  '14 Trafalgar Road, Kingston 10, Jamaica',
  '',
  'TAX INVOICE',
  '',
  'Invoice Number: INV-4471',
  'Invoice Date: 2026-03-15',
  'Due Date: 2026-04-14',
  'Purchase Order: PO-99120',
  'Payment Terms: Net 30 days',
  '',
  'Description: Quarterly maintenance of network equipment',
  '',
  'Subtotal: JMD 100,000.00',
  'Tax: JMD 15,000.00',
  'Total: JMD 115,000.00',
  '',
  'Please remit to First Global Bank, account number 0012345678.',
];

export const INVOICE_PDF = textPdf(INVOICE_LINES);
