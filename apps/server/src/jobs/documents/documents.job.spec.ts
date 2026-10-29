import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiGatewayService } from '../../ai/ai-gateway.service.js';
import { auditMock, compile, provideAudit, providePrisma } from '../../testing/fixtures.js';
import { readDocumentBytes } from './document-reader.js';
import { DocumentsJob } from './documents.job.js';

const send = vi.hoisted(() => vi.fn());

vi.mock('../../documents/s3.client.js', () => ({
  s3Client: { send },
  resolveDocumentsBucket: () => 'finora-docs',
}));

vi.mock('./document-reader.js', async () => {
  const actual = await vi.importActual<typeof import('./document-reader.js')>('./document-reader.js');
  return { ...actual, readDocumentBytes: vi.fn() };
});

function document(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    bucket: 'finora-docs',
    key: 'documents/abc',
    sha256: 'pending',
    contentType: 'text/plain',
    filename: 'invoice.txt',
    createdAt: new Date('2026-10-01T12:00:00.000Z'),
    estimate: null,
    invoice: null,
    ...overrides,
  };
}

function bytesOf(text: string) {
  const bytes = Buffer.from(text);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function emptyGateway() {
  return {
    suggestFields: vi.fn().mockResolvedValue({
      outcome: 'disabled',
      suggestions: [],
      discarded: 0,
      modelName: null,
      promptId: null,
      promptVersion: null,
      promptSha256: null,
      latencyMs: null,
      note: null,
    }),
    suggestKind: vi.fn().mockResolvedValue({
      outcome: 'disabled',
      kind: 'unknown',
      quote: null,
      modelName: null,
      promptId: null,
      promptVersion: null,
      promptSha256: null,
      latencyMs: null,
      note: null,
    }),
  };
}

describe('DocumentsJob', () => {
  const prisma = {
    s3Document: { findMany: vi.fn(), update: vi.fn() },
    documentExtraction: { createMany: vi.fn(), updateMany: vi.fn() },
    user: { findMany: vi.fn() },
    vendor: { findMany: vi.fn() },
    estimate: { create: vi.fn() },
    invoice: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  const audit = auditMock();
  const gateway = emptyGateway();

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.s3Document.update.mockResolvedValue({});
    prisma.documentExtraction.createMany.mockResolvedValue({ count: 1 });
    prisma.documentExtraction.updateMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
    prisma.user.findMany.mockResolvedValue([{ id: 'admin-1', role: 'administrator' }]);
    prisma.vendor.findMany.mockResolvedValue([{ id: 'vendor-1', name: 'Acme Supplies' }]);
    prisma.estimate.create.mockResolvedValue({ id: 'est-1', reference: 'EST-1' });
    prisma.invoice.create.mockResolvedValue({ id: 'inv-1', reference: 'INV-1' });
    Object.assign(gateway, emptyGateway());
  });

  async function job() {
    return compile(DocumentsJob, [
      providePrisma(prisma),
      provideAudit(audit),
      { provide: AiGatewayService, useValue: gateway },
    ]);
  }

  it('creates an invoice draft from a readable invoice and marks the file processed', async () => {
    const text = ['TAX INVOICE', 'Acme Supplies', 'Total JMD 12.50', 'Invoice number INV-9'].join('\n');
    const file = bytesOf(text);
    prisma.s3Document.findMany.mockResolvedValue([document({ sha256: file.sha256 })]);
    send.mockResolvedValue({ Body: { transformToByteArray: async () => file.bytes } });
    vi.mocked(readDocumentBytes).mockResolvedValue({
      text,
      pageCount: 1,
      source: 'plain_text',
      notes: [],
    });

    await expect((await job()).run()).resolves.toEqual({ read: 1, failed: 0 });

    expect(prisma.invoice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DRAFT',
          createdById: 'admin-1',
          documentId: 'doc-1',
          vendorId: 'vendor-1',
          currency: 'JMD',
          totalMinorUnits: 1250n,
          invoiceNumber: 'INV-9',
        }),
      }),
    );
    expect(prisma.estimate.create).not.toHaveBeenCalled();
    expect(prisma.documentExtraction.createMany).toHaveBeenCalled();
    expect(prisma.s3Document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ documentProcessed: true, status: 'needs_review' }),
      }),
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'invoice.created', subjectId: 'inv-1' }),
    );
  });

  it('creates an estimate draft when the title is a quotation', async () => {
    const text = ['Quotation', 'Total USD 40.00', 'Quote number QT-8'].join('\n');
    const file = bytesOf(text);
    prisma.s3Document.findMany.mockResolvedValue([document({ sha256: file.sha256 })]);
    send.mockResolvedValue({ Body: { transformToByteArray: async () => file.bytes } });
    vi.mocked(readDocumentBytes).mockResolvedValue({
      text,
      pageCount: 1,
      source: 'text_layer',
      notes: [],
    });

    await (await job()).run();

    expect(prisma.estimate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requesterId: 'admin-1',
          currency: 'USD',
          totalMinorUnits: 4000n,
          estimateNumber: 'QT-8',
          vendorId: null,
        }),
      }),
    );
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  it('records a hash mismatch as unreadable and does not create a draft', async () => {
    const file = bytesOf('TAX INVOICE');
    prisma.s3Document.findMany.mockResolvedValue([document({ sha256: 'not-the-file' })]);
    send.mockResolvedValue({ Body: { transformToByteArray: async () => file.bytes } });

    await expect((await job()).run()).resolves.toEqual({ read: 1, failed: 0 });

    expect(readDocumentBytes).not.toHaveBeenCalled();
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.documentExtraction.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ status: 'unreadable', kind: 'unknown' }),
        ]),
      }),
    );
    expect(prisma.s3Document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ documentProcessed: true, status: 'unreadable' }),
      }),
    );
  });

  it('leaves the document unprocessed when the download fails', async () => {
    prisma.s3Document.findMany.mockResolvedValue([document()]);
    send.mockRejectedValue(new Error('missing object'));

    await expect((await job()).run()).resolves.toEqual({ read: 0, failed: 1 });
    expect(prisma.s3Document.update).not.toHaveBeenCalled();
    expect(prisma.documentExtraction.createMany).not.toHaveBeenCalled();
  });

  it('does not open a second draft when the document is already linked', async () => {
    const text = 'TAX INVOICE\nTotal JMD 1.00\nInvoice number INV-1';
    const file = bytesOf(text);
    prisma.s3Document.findMany.mockResolvedValue([
      document({ sha256: file.sha256, invoice: { id: 'inv-existing' } }),
    ]);
    send.mockResolvedValue({ Body: { transformToByteArray: async () => file.bytes } });
    vi.mocked(readDocumentBytes).mockResolvedValue({
      text,
      pageCount: 1,
      source: 'plain_text',
      notes: [],
    });

    await (await job()).run();

    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.s3Document.update).toHaveBeenCalled();
  });

  it('marks an unknown document processed without a draft', async () => {
    const text = 'Hello from the supplier';
    const file = bytesOf(text);
    prisma.s3Document.findMany.mockResolvedValue([document({ sha256: file.sha256 })]);
    send.mockResolvedValue({ Body: { transformToByteArray: async () => file.bytes } });
    vi.mocked(readDocumentBytes).mockResolvedValue({
      text,
      pageCount: 1,
      source: 'plain_text',
      notes: [],
    });

    await (await job()).run();

    expect(gateway.suggestKind).toHaveBeenCalled();
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.estimate.create).not.toHaveBeenCalled();
    expect(prisma.s3Document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'manual_entry_required' }),
      }),
    );
  });

  it('still stores the reading when nobody can own the draft', async () => {
    const text = 'TAX INVOICE\nTotal JMD 1.00\nInvoice number INV-1';
    const file = bytesOf(text);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.s3Document.findMany.mockResolvedValue([document({ sha256: file.sha256 })]);
    send.mockResolvedValue({ Body: { transformToByteArray: async () => file.bytes } });
    vi.mocked(readDocumentBytes).mockResolvedValue({
      text,
      pageCount: 1,
      source: 'plain_text',
      notes: [],
    });

    await (await job()).run();

    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.s3Document.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ documentProcessed: true }) }),
    );
  });

  it('continues the batch after one download fails', async () => {
    const text = 'TAX INVOICE\nTotal JMD 1.00\nInvoice number INV-2';
    const file = bytesOf(text);
    prisma.s3Document.findMany.mockResolvedValue([
      document({ id: 'doc-bad', key: 'missing' }),
      document({ id: 'doc-good', sha256: file.sha256 }),
    ]);
    send.mockRejectedValueOnce(new Error('missing')).mockResolvedValueOnce({
      Body: { transformToByteArray: async () => file.bytes },
    });
    vi.mocked(readDocumentBytes).mockResolvedValue({
      text,
      pageCount: 1,
      source: 'plain_text',
      notes: [],
    });

    await expect((await job()).run()).resolves.toEqual({ read: 1, failed: 1 });
    expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
  });

  it('stores model field proposals from the assistive reader', async () => {
    const text = 'TAX INVOICE\nAcme Supplies Ltd\nDue 12 May 2026';
    const file = bytesOf(text);
    prisma.s3Document.findMany.mockResolvedValue([document({ sha256: file.sha256 })]);
    send.mockResolvedValue({ Body: { transformToByteArray: async () => file.bytes } });
    vi.mocked(readDocumentBytes).mockResolvedValue({
      text,
      pageCount: 1,
      source: 'plain_text',
      notes: [],
    });
    gateway.suggestFields.mockResolvedValue({
      outcome: 'answered',
      suggestions: [
        { name: 'vendor_name', text: 'Acme Supplies Ltd', quote: 'Acme Supplies Ltd' },
      ],
      discarded: 0,
      modelName: 'kimi-k2.6',
      promptId: 'document.fields',
      promptVersion: 1,
      promptSha256: 'abc',
      latencyMs: 12,
      note: null,
    });

    await (await job()).run();

    expect(gateway.suggestFields).toHaveBeenCalled();
    expect(prisma.documentExtraction.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            labelText: 'vendor_name',
            valueText: 'Acme Supplies Ltd',
            modelName: 'kimi-k2.6',
            gatewayOutcome: 'answered',
          }),
        ]),
      }),
    );
  });
});
