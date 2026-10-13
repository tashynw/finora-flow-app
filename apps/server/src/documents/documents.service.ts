import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
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

@Injectable()
export class DocumentsService {
  async createUploadLink(input: CreateUploadLinkInput) {
    const bucket = resolveDocumentsBucket(input.bucket);
    const fields: Record<string, string> = {
      'Content-Type': input.contentType,
    };
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
