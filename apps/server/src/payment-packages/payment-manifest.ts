import { createHash } from 'node:crypto';
import type { Currency, InvoiceStatus } from '../generated/prisma/index.js';
import { formatMinorUnits } from '../common/money-format.js';

export type ManifestLine = {
  invoiceId: string;
  reference: string;
  invoiceNumber: string | null;
  vendorId: string | null;
  vendorName: string;
  totalMinorUnits: bigint;
  currency: Currency;
  dueDate: Date | null;
  invoiceStatus: InvoiceStatus;
};

const MANIFEST_COLUMNS = [
  'Row',
  'Package',
  'Payment date',
  'Payment method',
  'Our reference',
  'Supplier',
  'Their invoice number',
  'Invoice date due',
  'Currency',
  'Amount',
] as const;

const ROW_LINE = 'Invoice';
const ROW_TOTAL = 'Total';

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
  wire: 'Wire',
  direct_debit: 'Direct debit',
};

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(cells: (string | number)[]): string {
  return cells.map((c) => csvEscape(String(c))).join('\n');
}

function totalsByCurrency(lines: ManifestLine[]): Map<string, bigint> {
  const map = new Map<string, bigint>();
  for (const line of lines) {
    const key = line.currency;
    map.set(key, (map.get(key) ?? 0n) + line.totalMinorUnits);
  }
  return map;
}

export function renderManifest(input: {
  packageReference: string;
  paymentMethod: string;
  intendedPaymentDate: Date;
  lines: ManifestLine[];
}): { content: string; digest: string; lineCount: number } {
  const ordered = [...input.lines].sort((a, b) => {
    const vn = a.vendorName.localeCompare(b.vendorName, undefined, {
      sensitivity: 'base',
    });
    if (vn !== 0) return vn;
    return a.reference.localeCompare(b.reference);
  });

  const dateWritten = input.intendedPaymentDate.toISOString().slice(0, 10);
  const methodWritten =
    PAYMENT_METHOD_LABELS[input.paymentMethod] ?? input.paymentMethod;

  const rows: string[] = [MANIFEST_COLUMNS.join(',')];

  for (const line of ordered) {
    rows.push(
      [
        ROW_LINE,
        input.packageReference,
        dateWritten,
        methodWritten,
        line.reference,
        line.vendorName,
        line.invoiceNumber ?? '',
        line.dueDate ? line.dueDate.toISOString().slice(0, 10) : '',
        line.currency,
        formatMinorUnits(line.totalMinorUnits, line.currency, false),
      ].map((c) => csvEscape(String(c))).join(','),
    );
  }

  for (const [currency, total] of totalsByCurrency(ordered)) {
    rows.push(
      [
        ROW_TOTAL,
        input.packageReference,
        dateWritten,
        methodWritten,
        '',
        '',
        '',
        '',
        currency,
        formatMinorUnits(total, currency, false),
      ].map((c) => csvEscape(String(c))).join(','),
    );
  }

  const content = rows.join('\n');
  const digest = createHash('sha256').update(content, 'utf8').digest('hex');
  return { content, digest, lineCount: ordered.length };
}

export function validateSubmissionReference(reference: string): string {
  const cleaned = reference.trim().replace(/\s+/g, ' ');
  if (cleaned.length < 3) {
    throw new Error(
      'Give the reference the bank returned for this submission.',
    );
  }
  if (cleaned.length > 120) {
    throw new Error('A submission reference cannot be longer than 120 characters.');
  }
  return cleaned;
}
