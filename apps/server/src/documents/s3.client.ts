import { S3Client } from '@aws-sdk/client-s3';

export const s3Client = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-2',
  credentials: {
    accessKeyId: process.env.ACCESS_KEY_ID!,
    secretAccessKey: process.env.SECRET_ACCESS_KEY!,
  },
});

export function resolveDocumentsBucket(bucket?: string): string {
  const resolved = bucket ?? process.env.S3_DOCUMENTS_BUCKET;
  if (!resolved) {
    throw new Error('S3_DOCUMENTS_BUCKET is not set');
  }
  return resolved;
}
