import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentsService } from '../documents/documents.service.js';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
  session,
} from '../testing/fixtures.js';
import { IntakeService } from './intake.service.js';

describe('IntakeService', () => {
  const prisma = {
    inboundMessage: {
      create: vi.fn(),
      groupBy: vi.fn(),
      findFirst: vi.fn(),
      aggregate: vi.fn(),
    },
    mailboxCheckpoint: { findMany: vi.fn() },
    s3Document: { findUnique: vi.fn() },
  };
  const documents = { createViewUrl: vi.fn() };

  beforeEach(() => vi.clearAllMocks());

  async function service() {
    return compile(IntakeService, [
      providePrisma(prisma),
      provideAudit(auditMock()),
      { provide: DocumentsService, useValue: documents },
    ]);
  }

  it('records a manual upload as a ready message and document', async () => {
    prisma.inboundMessage.create.mockResolvedValue({
      id: 'msg-1',
      documents: [{ id: 'doc-1' }],
    });

    await (await service()).manualUpload(session, {
      filename: 'quote.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      sha256: 'abc',
      key: 'docs/quote.pdf',
      bucket: 'finora-docs',
    });

    expect(prisma.inboundMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'manual_upload',
          status: 'ready',
          documents: {
            create: expect.objectContaining({
              kind: 'manual_upload',
              key: 'docs/quote.pdf',
            }),
          },
        }),
      }),
    );
  });

  it('reports mailbox checkpoints as a list', async () => {
    prisma.mailboxCheckpoint.findMany.mockResolvedValue([
      {
        folder: 'INBOX',
        uidValidity: 4n,
        lastSeenUid: 12n,
        lastPolledAt: new Date(),
        lastResetAt: null,
        lastResetReason: null,
      },
    ]);
    prisma.inboundMessage.groupBy.mockResolvedValue([
      { status: 'ready', _count: { _all: 2 } },
    ]);
    prisma.inboundMessage.aggregate.mockResolvedValue({ _min: { receivedAt: null } });

    const report = await (await service()).operationsSummary();

    expect(Array.isArray(report.checkpoints)).toBe(true);
    expect(report.checkpoints[0]?.folder).toBe('INBOX');
    expect(report.backlog.total).toBe(2);
    expect(report.backlog.failed).toBe(0);
    expect(report.mailbox).toBeNull();
  });

  it('signs a download url from the stored document key', async () => {
    prisma.s3Document.findUnique.mockResolvedValue({
      id: 'doc-1',
      key: 'docs/quote.pdf',
      bucket: 'finora-docs',
    });
    documents.createViewUrl.mockResolvedValue({ url: 'https://s3.example/quote' });

    const result = await (await service()).attachmentDownloadUrl('doc-1');
    expect(documents.createViewUrl).toHaveBeenCalledWith({
      key: 'docs/quote.pdf',
      bucket: 'finora-docs',
    });
    expect(result.url).toBe('https://s3.example/quote');
  });
});
