import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/errors.js';

const REQUIRED = ['date', 'merchant', 'amount', 'cardholder'] as const;

export type StatementLine = {
  sourceRow: number;
  postedOn: string;
  merchant: string;
  cardholder: string;
  amountMinorUnits: bigint;
  category: string | null;
  externalReference: string | null;
  description: string | null;
};

/**
 * The same rules as the Python statement reader. A bad row refuses the file.
 */
export function parseStatementCsv(text: string): StatementLine[] {
  if (!text.trim()) {
    throw new DomainException('The statement file is empty.');
  }

  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) {
    throw new DomainException('The statement file is empty.');
  }

  const headers = new Map<string, number>();
  header.forEach((name, index) => {
    const key = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (key) headers.set(key, index);
  });

  const missing = REQUIRED.filter((column) => !headers.has(column));
  if (missing.length) {
    throw new DomainException(
      `The statement is missing required columns. Missing: ${missing.join(', ')}.`,
    );
  }

  const lines: StatementLine[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const raw = rows[index];
    if (!raw || raw.every((cell) => cell.trim() === '')) continue;
    const sourceRow = index + 1;
    lines.push(readRow(raw, headers, sourceRow));
  }

  if (lines.length === 0) {
    throw new DomainException('The statement file has no transactions.');
  }
  return lines;
}

function readRow(raw: string[], headers: Map<string, number>, sourceRow: number): StatementLine {
  const cell = (column: string) => (raw[headers.get(column) ?? -1] ?? '').trim();
  const optional = (column: string) => {
    if (!headers.has(column)) return null;
    return cell(column) || null;
  };

  const postedOn = cell('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(postedOn) || Number.isNaN(Date.parse(`${postedOn}T00:00:00Z`))) {
    throw new DomainException(`Row ${sourceRow}: the date must be YYYY-MM-DD.`);
  }

  const merchant = cell('merchant');
  if (!merchant) throw new DomainException(`Row ${sourceRow}: the merchant is blank.`);
  if (merchant.length > 300) {
    throw new DomainException(`Row ${sourceRow}: the merchant name is too long.`);
  }

  const cardholder = cell('cardholder');
  if (!cardholder) throw new DomainException(`Row ${sourceRow}: the cardholder is blank.`);
  if (cardholder.length > 120) {
    throw new DomainException(`Row ${sourceRow}: the cardholder name is too long.`);
  }

  const amountMinorUnits = minorUnits(cell('amount'), sourceRow);
  const category = optional('category')?.slice(0, 120) ?? null;
  const reference = optional('reference');

  return {
    sourceRow,
    postedOn,
    merchant,
    cardholder,
    amountMinorUnits,
    category,
    externalReference: reference ? reference.slice(0, 80) : null,
    description: optional('description'),
  };
}

function minorUnits(raw: string, sourceRow: number): bigint {
  const cleaned = raw.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new DomainException(`Row ${sourceRow}: the amount is not a number.`);
  }
  const negative = cleaned.startsWith('-');
  const [whole, fraction = ''] = cleaned.replace('-', '').split('.');
  const digits = `${fraction}000`;
  let cents = BigInt(whole) * 100n + BigInt(digits.slice(0, 2));
  if (digits[2] >= '5') cents += 1n;
  return negative ? -cents : cents;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function decodeStatement(buffer: Buffer): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return text.replace(/^\uFEFF/, '');
  } catch {
    throw new DomainException(
      'The statement file must be UTF-8 text.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
