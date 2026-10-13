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
        include: { documents: true },
      }),
      this.prisma.inboundMessage.count(),
    ]);
    return { items: items.map((row) => this.toSummary(row)), total, ...page };
  }

  async getMessage(id: string) {
    const message = await this.prisma.inboundMessage.findUnique({
      where: { id },
      include: { documents: true },
    });
    if (!message) throw notFound('Inbound message', id);
    return this.toDetail(message);
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
      kind?: string;
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
            kind: body.kind && body.kind !== 'manual_upload' ? body.kind : 'unknown',
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

  private toSummary(row: {
    id: string;
    subject: string;
    source: string;
    status: string;
    fromAddress: string | null;
    fromDisplayName: string | null;
    forwardedFromAddress: string | null;
    receivedAt: Date;
    parseWarnings: unknown;
    documents: { id: string }[];
  }) {
    const warnings = this.warningLines(row.parseWarnings);
    return {
      id: row.id,
      subject: row.subject,
      source: row.source,
      status: row.status,
      from_address: row.fromAddress,
      from_display_name: row.fromDisplayName,
      forwarded_from_address: row.forwardedFromAddress,
      received_at: row.receivedAt.toISOString(),
      attachment_count: row.documents.length,
      quarantined_count: 0,
      has_warnings: warnings.length > 0,
    };
  }

  private toDetail(row: {
    id: string;
    subject: string;
    source: string;
    status: string;
    fromAddress: string | null;
    fromDisplayName: string | null;
    forwardedFromAddress: string | null;
    forwardedShape: string | null;
    replyToAddress: string | null;
    messageId: string | null;
    bodyText: string;
    receivedAt: Date;
    sentAt: Date | null;
    failureReason: string | null;
    rawSha256: string;
    rawSizeBytes: bigint;
    toAddresses: unknown;
    ccAddresses: unknown;
    parseWarnings: unknown;
    documents: {
      id: string;
      filename: string;
      contentType: string;
      sizeBytes: bigint;
      sha256: string;
    }[];
  }) {
    return {
      ...this.toSummary(row),
      body_text: row.bodyText,
      cc_addresses: this.stringList(row.ccAddresses),
      to_addresses: this.stringList(row.toAddresses),
      failure_reason: row.failureReason,
      forwarded_shape: row.forwardedShape,
      reply_to_address: row.replyToAddress,
      message_id: row.messageId,
      parse_warnings: this.warningLines(row.parseWarnings),
      raw_sha256: row.rawSha256,
      raw_size_bytes: Number(row.rawSizeBytes),
      sent_at: row.sentAt?.toISOString() ?? null,
      attachments: row.documents.map((document) => ({
        id: document.id,
        filename: document.filename,
        content_type: document.contentType,
        size_bytes: Number(document.sizeBytes),
        sha256: document.sha256,
        can_download: true,
        inline: false,
        is_quarantined: false,
        rejection_detail: null,
        rejection_reason: null,
        scan_detail: null,
        scan_verdict: null,
      })),
    };
  }

  private stringList(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  }

  private warningLines(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map((item) =>
      typeof item === 'string' ? item : JSON.stringify(item),
    );
  }
}
