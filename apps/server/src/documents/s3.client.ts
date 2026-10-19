import { S3Client } from '@aws-sdk/client-s3';

const endpoint =
  process.env.S3_ENDPOINT ?? process.env.FINORA_S3_ENDPOINT_URL ?? undefined;

export const s3Client = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-2',
  credentials: {
    accessKeyId: process.env.ACCESS_KEY_ID ?? process.env.S3_ACCESS_KEY ?? '',
    secretAccessKey:
      process.env.SECRET_ACCESS_KEY ?? process.env.S3_SECRET_KEY ?? '',
  },
  ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
});

export function resolveDocumentsBucket(bucket?: string): string {
  const resolved = bucket ?? process.env.S3_DOCUMENTS_BUCKET;
  if (!resolved) {
    throw new Error('S3_DOCUMENTS_BUCKET is not set');
  }
  return resolved;
}
