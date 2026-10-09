import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentsService } from './documents.service.js';

const { send } = vi.hoisted(() => ({
  send: vi.fn().mockResolvedValue({}),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = send;
  },
  DeleteObjectCommand: class {
    constructor(public input: unknown) {}
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: vi.fn(async () => ({
    url: 'https://s3.example/upload',
    fields: { key: 'docs/a.pdf', 'Content-Type': 'application/pdf' },
  })),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://s3.example/view'),
}));

describe('DocumentsService', () => {
  const service = new DocumentsService();

  beforeEach(() => {
    process.env.S3_DOCUMENTS_BUCKET = 'finora-docs';
    send.mockClear();
  });

  it('returns a presigned upload for the documents bucket', async () => {
    const result = await service.createUploadLink({
      key: 'docs/a.pdf',
      contentType: 'application/pdf',
    });
    expect(result.uploadUrl).toBe('https://s3.example/upload');
    expect(result.bucket).toBe('finora-docs');
    expect(result.fileKey).toBe('docs/a.pdf');
  });

  it('returns a presigned view url', async () => {
    const result = await service.createViewUrl({ key: 'docs/a.pdf' });
    expect(result.url).toBe('https://s3.example/view');
  });

  it('deletes the object from the given bucket', async () => {
    const result = await service.deleteObject({
      key: 'docs/a.pdf',
      bucket: 'other-bucket',
    });
    expect(result).toEqual({
      deleted: true,
      fileKey: 'docs/a.pdf',
      bucket: 'other-bucket',
    });
    expect(send).toHaveBeenCalledOnce();
  });
});
