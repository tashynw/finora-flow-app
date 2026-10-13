import { api } from '@/lib/api-client';

/** Folders the documents API accepts. The key is Folder/uuid.originalExtension. */
export const DOCUMENT_FOLDERS = {
  invoice: 'Invoice',
  estimate: 'Estimate',
  credit_note: 'CreditNote',
  receipt: 'Receipt',
  purchase_order: 'PurchaseOrder',
  statement: 'StatementOfAccount',
  remittance_advice: 'RemittanceAdvice',
  unknown: 'Other',
} as const;

export type DocumentFolderKind = keyof typeof DOCUMENT_FOLDERS;

type UploadLink = {
  uploadUrl: string;
  fields: Record<string, string>;
  fileKey: string;
  bucket: string;
};

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Presigned POST, then the file goes straight to object storage.
 * The server builds Invoice/<uuid>.pdf (and the other folders) from the
 * original filename so the browser never chooses the key.
 */
export async function uploadDocumentToS3(file: File, kind: DocumentFolderKind) {
  const uuid = crypto.randomUUID();
  const link = await api.post<UploadLink>('/documents/upload-url', {
    folder: DOCUMENT_FOLDERS[kind],
    uuid,
    filename: file.name,
    contentType: file.type || 'application/octet-stream',
  });

  const form = new FormData();
  for (const [key, value] of Object.entries(link.fields)) {
    form.append(key, value);
  }
  form.append('Content-Type', file.type || 'application/octet-stream');
  form.append('file', file, file.name);

  const uploaded = await fetch(link.uploadUrl, { method: 'POST', body: form });
  if (!uploaded.ok) {
    throw new Error(`Failed to upload ${file.name}`);
  }

  return {
    ...link,
    sha256: await sha256Hex(file),
    sizeBytes: file.size,
    contentType: file.type || 'application/octet-stream',
    filename: file.name,
  };
}
