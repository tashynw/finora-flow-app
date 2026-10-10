/**
 * Read a document from the bytes already in memory.
 * A PDF with a text layer is read directly. A picture is recognised with
 * Tesseract in this process. A scan that yields no text is recorded as unread.
 */

export type DocumentKind = 'invoice' | 'estimate' | 'unknown';

export type DocumentReading = {
  text: string;
  pageCount: number;
  source: 'text_layer' | 'ocr' | 'plain_text' | 'none';
  notes: string[];
};

export type ClassifiedDocument = {
  kind: DocumentKind;
  confidence: number;
  notes: string[];
};

export type ExtractedFields = {
  currency: 'JMD' | 'USD' | null;
  totalMinorUnits: bigint | null;
  number: string | null;
};

const TITLE_WORD_LIMIT = 6;
const TITLE_BAND = 0.38;
const MAX_BYTES = 25 * 1024 * 1024;

const KIND_TITLES: Array<{ kind: Exclude<DocumentKind, 'unknown'>; pattern: RegExp }> = [
  { kind: 'invoice', pattern: /\bpro[ -]?forma\b/i },
  { kind: 'invoice', pattern: /\bcredit (note|memo|memorandum)\b/i },
  { kind: 'invoice', pattern: /\b(tax |sales |commercial )?invoice\b/i },
  { kind: 'estimate', pattern: /\b(quotation|quote|estimate|proposal)\b/i },
];

export function classifyDocument(text: string): ClassifiedDocument {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return {
      kind: 'unknown',
      confidence: 0,
      notes: ['There was no readable text to identify this document from.'],
    };
  }

  const band = Math.max(8, Math.ceil(lines.length * TITLE_BAND));
  const titles = lines.slice(0, band).filter((line) => line.split(/\s+/).length <= TITLE_WORD_LIMIT);
  const kinds = new Set<Exclude<DocumentKind, 'unknown'>>();
  for (const line of titles) {
    for (const rule of KIND_TITLES) {
      if (rule.pattern.test(line)) kinds.add(rule.kind);
    }
  }

  if (kinds.size === 0) {
    return {
      kind: 'unknown',
      confidence: 0,
      notes: ['No document title such as Invoice or Quotation was found near the top of the first page.'],
    };
  }
  if (kinds.size > 1) {
    return {
      kind: 'unknown',
      confidence: 0,
      notes: ['This document carries more than one title, so what it is cannot be decided from the document alone.'],
    };
  }
  return { kind: [...kinds][0], confidence: 0.8, notes: [] };
}

export function extractFields(text: string): ExtractedFields {
  const currency = /\bUSD\b/.test(text) ? 'USD' : /\bJMD\b/.test(text) ? 'JMD' : null;
  const amount = text.match(
    /(?:grand total|amount due|balance due|total)\s*[:\-]?\s*(?:JMD|USD|\$)?\s*([\d,]+(?:\.\d{2})?)/i,
  );
  const number = text.match(
    /(?:invoice|estimate|quotation|quote)\s*(?:no\.?|number|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i,
  );
  let totalMinorUnits: bigint | null = null;
  if (amount?.[1]) {
    const major = Number(amount[1].replace(/,/g, ''));
    if (Number.isFinite(major)) totalMinorUnits = BigInt(Math.round(major * 100));
  }
  return {
    currency,
    totalMinorUnits,
    number: number?.[1] ?? null,
  };
}

export function injectionFindings(text: string): string[] {
  const findings: string[] = [];
  if (/ignore (all |any )?(previous|prior) instructions/i.test(text)) {
    findings.push('The document asks the reader to ignore its instructions.');
  }
  return findings;
}

export async function readDocumentBytes(
  data: Buffer,
  contentType: string,
): Promise<DocumentReading> {
  if (data.length > MAX_BYTES) {
    return {
      text: '',
      pageCount: 0,
      source: 'none',
      notes: [`The file is above the ${MAX_BYTES.toLocaleString()} byte reading limit.`],
    };
  }

  const type = contentType.toLowerCase();
  if (type.startsWith('text/')) {
    return { text: data.toString('utf8'), pageCount: 1, source: 'plain_text', notes: [] };
  }

  if (type === 'application/pdf' || data.subarray(0, 5).toString() === '%PDF-') {
    return readPdf(data);
  }

  if (type.startsWith('image/')) {
    return recogniseImage(data);
  }

  return {
    text: '',
    pageCount: 0,
    source: 'none',
    notes: [`${contentType || 'This file type'} cannot be read.`],
  };
}

async function readPdf(data: Buffer): Promise<DocumentReading> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const extracted = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(extracted.text) ? extracted.text : [extracted.text];
    const text = pages.map((page) => page.trim()).filter(Boolean).join('\n\n');
    if (text) {
      return { text, pageCount: extracted.totalPages, source: 'text_layer', notes: [] };
    }
    const recognised = await recogniseImage(data);
    if (recognised.text.trim()) {
      return { ...recognised, pageCount: extracted.totalPages || recognised.pageCount };
    }
    return {
      text: '',
      pageCount: extracted.totalPages,
      source: 'none',
      notes: [
        'This PDF has pages but no text in them, so it is a scan or an image. Recognition did not recover any words.',
      ],
    };
  } catch (error) {
    return {
      text: '',
      pageCount: 0,
      source: 'none',
      notes: [
        `The PDF could not be opened. ${error instanceof Error ? error.message : 'Unknown error.'}`,
      ],
    };
  }
}

async function recogniseImage(data: Buffer): Promise<DocumentReading> {
  try {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng');
    try {
      const result = await worker.recognize(data);
      const text = result.data.text?.trim() ?? '';
      if (!text) {
        return {
          text: '',
          pageCount: 1,
          source: 'none',
          notes: ['Recognition ran and found no words.'],
        };
      }
      return { text, pageCount: 1, source: 'ocr', notes: [] };
    } finally {
      await worker.terminate();
    }
  } catch (error) {
    return {
      text: '',
      pageCount: 1,
      source: 'none',
      notes: [
        `Recognition failed. ${error instanceof Error ? error.message : 'Unknown error.'}`,
      ],
    };
  }
}
