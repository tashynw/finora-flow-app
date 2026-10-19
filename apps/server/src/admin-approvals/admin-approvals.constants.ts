import {
  ApprovalLevel,
  ApprovalRecordType,
  Currency,
} from '../generated/prisma/index.js';

export const RECORD_TYPE_SLUGS = ['estimate', 'invoice', 'purchase_order'] as const;

export type RecordTypeSlug = (typeof RECORD_TYPE_SLUGS)[number];

export const RECORD_TYPE_LABELS: Record<RecordTypeSlug, string> = {
  estimate: 'Estimates',
  invoice: 'Invoices',
  purchase_order: 'Purchase orders',
};

export const SLUG_TO_RECORD_TYPE: Record<RecordTypeSlug, ApprovalRecordType> = {
  estimate: ApprovalRecordType.ESTIMATE,
  invoice: ApprovalRecordType.INVOICE,
  purchase_order: ApprovalRecordType.PURCHASE_ORDER,
};

export const RECORD_TYPE_TO_SLUG: Record<ApprovalRecordType, RecordTypeSlug> = {
  [ApprovalRecordType.ESTIMATE]: 'estimate',
  [ApprovalRecordType.INVOICE]: 'invoice',
  [ApprovalRecordType.PURCHASE_ORDER]: 'purchase_order',
};

export const LEVEL_LABELS: Record<ApprovalLevel, string> = {
  [ApprovalLevel.UNIT_HEAD]: 'Unit head',
  [ApprovalLevel.MANAGER]: 'Manager',
  [ApprovalLevel.HOD]: 'Head of department',
  [ApprovalLevel.COO]: 'COO',
};

export const SLUG_TO_LEVEL: Record<string, ApprovalLevel> = {
  unit_head: ApprovalLevel.UNIT_HEAD,
  manager: ApprovalLevel.MANAGER,
  hod: ApprovalLevel.HOD,
  coo: ApprovalLevel.COO,
};

export function parseRecordTypeSlug(slug: string): ApprovalRecordType {
  const normalized = slug.trim().toLowerCase() as RecordTypeSlug;
  const mapped = SLUG_TO_RECORD_TYPE[normalized];
  if (mapped) return mapped;
  const upper = slug.trim().toUpperCase();
  if ((Object.values(ApprovalRecordType) as string[]).includes(upper)) {
    return upper as ApprovalRecordType;
  }
  throw new Error(
    `There is no approval matrix for '${slug}'. Choose one of: ${RECORD_TYPE_SLUGS.join(', ')}.`,
  );
}

export function parseApprovalLevel(level: string): ApprovalLevel {
  const normalized = level.trim().toLowerCase();
  const mapped = SLUG_TO_LEVEL[normalized];
  if (mapped) return mapped;
  const upper = level.trim().toUpperCase().replace(/-/g, '_');
  if ((Object.values(ApprovalLevel) as string[]).includes(upper)) {
    return upper as ApprovalLevel;
  }
  throw new Error(`Unknown approval level '${level}'.`);
}

export function parseCurrency(code: string): Currency {
  const upper = code.trim().toUpperCase();
  if (upper === Currency.JMD || upper === Currency.USD) return upper as Currency;
  throw new Error(`Currency must be JMD or USD.`);
}

export function formatMoney(minor: bigint, currency: string): string {
  const major = Number(minor) / 100;
  return `${currency} ${major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
