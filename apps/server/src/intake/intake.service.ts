import { Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { actorLabel } from '../common/invoice-status.js';
import { AuditService } from '../common/audit.service.js';
import { notFound } from '../common/errors.js';
import { resolvePage, type PageQuery } from '../common/pagination.js';
import { DocumentsService } from '../documents/documents.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class IntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
  ) {}

  async listMessages(query: PageQuery) {
    const page = resolvePage(query);
    const [items, total] = await Promise.all([
      this.prisma.inboundMessage.findMany({
        orderBy: { receivedAt: 'desc' },
        take: page.take,
        skip: page.skip,
      }),
      this.prisma.inboundMessage.count(),
    ]);
    return { items, total, ...page };
  }

  async getMessage(id: string) {
    const message = await this.prisma.inboundMessage.findUnique({
      where: { id },
      include: { documents: true },
    });
    if (!message) throw notFound('Inbound message', id);
    return message;
  }

  async operationsSummary() {
    const statusCounts = await this.prisma.inboundMessage.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    const checkpoints = {
      lastReceivedAt: await this.prisma.inboundMessage.findFirst({
        orderBy: { receivedAt: 'desc' },
        select: { receivedAt: true, id: true, subject: true },
      }),
      pendingCount:
        statusCounts.find((s) => s.status === 'ready')?._count._all ?? 0,
      failedCount:
        statusCounts.find((s) => s.status === 'failed')?._count._all ?? 0,
    };

    return {
      checkpoints,
      messageStatusCounts: Object.fromEntries(
        statusCounts.map((row) => [row.status, row._count._all]),
      ),
    };
  }

  async manualUpload(
    session: UserSession,
    body: {
      filename: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
      key: string;
      bucket: string;
      subject?: string;
      note?: string;
    },
  ) {
    const now = new Date();
    const idempotencyKey = `manual:${body.sha256}:${body.key}`;

    const message = await this.prisma.inboundMessage.create({
      data: {
        source: 'manual_upload',
        status: 'ready',
        idempotencyKey,
        rawSha256: body.sha256,
        rawObjectKey: body.key,
        rawSizeBytes: BigInt(body.sizeBytes),
        subject: body.subject?.trim() || body.filename,
        receivedAt: now,
        bodyText: body.note?.trim() || '',
        toAddresses: [],
        ccAddresses: [],
        deliveredToAddresses: [],
        references: [],
        parseWarnings: body.note ? [{ note: body.note }] : [],
        uploadedById: session.user.id,
        documents: {
          create: {
            filename: body.filename,
            contentType: body.contentType,
            sizeBytes: BigInt(body.sizeBytes),
            sha256: body.sha256,
            key: body.key,
            bucket: body.bucket,
            kind: 'manual_upload',
            status: 'ready',
          },
        },
      },
      include: { documents: true },
    });

    await this.audit.append({
      action: 'intake_manual_upload',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: 'inbound_message',
      subjectId: message.id,
      detail: { filename: body.filename, key: body.key },
    });

    return message;
  }

  async attachmentDownloadUrl(documentId: string) {
    const doc = await this.prisma.s3Document.findUnique({
      where: { id: documentId },
    });
    if (!doc) throw notFound('Document', documentId);

    const view = await this.documents.createViewUrl({
      key: doc.key,
      bucket: doc.bucket,
    });

    return { documentId, ...view };
  }
}
