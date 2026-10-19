import { DomainException } from '../common/errors.js';

/** S3 folder for each classified document. Unclassified files use Other. */
export const DOCUMENT_FOLDERS = [
  'Invoice',
  'Estimate',
  'CreditNote',
  'Receipt',
  'PurchaseOrder',
  'StatementOfAccount',
  'RemittanceAdvice',
  'Other',
] as const;

export type DocumentFolder = (typeof DOCUMENT_FOLDERS)[number];

const KIND_FOLDER: Record<string, DocumentFolder> = {
  invoice: 'Invoice',
  estimate: 'Estimate',
  credit_note: 'CreditNote',
  receipt: 'Receipt',
  purchase_order: 'PurchaseOrder',
  statement: 'StatementOfAccount',
  remittance_advice: 'RemittanceAdvice',
  unknown: 'Other',
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function folderForKind(kind: string): DocumentFolder {
  return KIND_FOLDER[kind] ?? 'Other';
}

/** Extension taken from the original filename, such as pdf. */
export function originalExtension(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return 'bin';
  const ext = base.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) return 'bin';
  return ext;
}

export function documentObjectKey(
  folder: string,
  uuid: string,
  filename: string,
): string {
  if (!DOCUMENT_FOLDERS.includes(folder as DocumentFolder)) {
    throw new DomainException('That document folder is not allowed.');
  }
  if (!UUID.test(uuid)) {
    throw new DomainException('A document id must be a UUID.');
  }
  return `${folder}/${uuid}.${originalExtension(filename)}`;
}
