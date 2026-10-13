import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetBucketCorsCommand,
  GetObjectCommand,
  PutBucketCorsCommand,
  type CORSRule,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { resolveDocumentsBucket, s3Client } from './s3.client.js';

export type CreateUploadLinkInput = {
  key: string;
  contentType: string;
  contentMd5?: string;
  bucket?: string;
  expiresIn?: number;
};

export type CreateViewUrlInput = {
  key: string;
  bucket?: string;
  expiresIn?: number;
};

export type DeleteObjectInput = {
  key: string;
  bucket?: string;
};

const corsReady = new Set<string>();

function browserOrigins(): string[] {
  const origins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
  for (const key of ['WEB_ORIGIN', 'WEB_APP_URL'] as const) {
    const value = process.env[key];
    if (value) origins.add(value.replace(/\/$/, ''));
  }
  return [...origins];
}

/**
 * A presigned POST can store the file and still answer 204 without
 * Access-Control-Allow-Origin. The browser then hides that response and
 * `fetch` throws "Failed to fetch", so the inbox never records the document.
 */
async function allowBrowserUploads(bucket: string) {
  if (corsReady.has(bucket)) return;

  const origins = browserOrigins();
  let existing: CORSRule[] = [];
  try {
    const current = await s3Client.send(new GetBucketCorsCommand({ Bucket: bucket }));
    existing = current.CORSRules ?? [];
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name !== 'NoSuchCORSConfiguration') throw error;
  }

  const covered = new Set(existing.flatMap((rule) => rule.AllowedOrigins ?? []));
  const missing = origins.filter((origin) => !covered.has(origin) && !covered.has('*'));
  if (missing.length > 0) {
    await s3Client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            ...existing,
            {
              AllowedOrigins: missing,
              AllowedMethods: ['GET', 'PUT', 'POST', 'HEAD'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 3000,
            },
          ],
        },
      }),
    );
  }

  corsReady.add(bucket);
}

@Injectable()
export class DocumentsService {
  async createUploadLink(input: CreateUploadLinkInput) {
    const bucket = resolveDocumentsBucket(input.bucket);
    await allowBrowserUploads(bucket).catch((error: unknown) => {
      const name = error instanceof Error ? error.name : 'Error';
      console.warn(`Could not allow the browser to read storage responses (${name}).`);
    });
    const fields: Record<string, string> = {};
    if (input.contentMd5) {
      fields['Content-MD5'] = input.contentMd5;
    }

    const { url, fields: formFields } = await createPresignedPost(s3Client, {
      Bucket: bucket,
      Key: input.key,
      Conditions: [{ 'Content-Type': input.contentType }],
      Fields: fields,
      Expires: input.expiresIn ?? 600,
    });

    return {
      uploadUrl: url,
      fields: formFields,
      fileKey: input.key,
      bucket,
    };
  }

  async createViewUrl(input: CreateViewUrlInput) {
    const bucket = resolveDocumentsBucket(input.bucket);
    await allowBrowserUploads(bucket).catch(() => undefined);
    const url = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: input.key,
      }),
      { expiresIn: input.expiresIn ?? 3600 },
    );

    return { url, fileKey: input.key, bucket };
  }

  async copyObject(input: { fromKey: string; toKey: string; bucket?: string }) {
    const bucket = resolveDocumentsBucket(input.bucket);
    await s3Client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: input.toKey,
        CopySource: `${bucket}/${encodeURIComponent(input.fromKey)}`,
      }),
    );
    return { fileKey: input.toKey, bucket };
  }

  async deleteObject(input: DeleteObjectInput) {
    const bucket = resolveDocumentsBucket(input.bucket);

    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: input.key,
      }),
    );

    return { deleted: true, fileKey: input.key, bucket };
  }
}
