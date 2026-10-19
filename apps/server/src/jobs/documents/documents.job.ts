import { createHash } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit.service.js';
import { nextReference } from '../../common/ids.js';
import { parseRoleField } from '../../common/roles.js';
import { s3Client } from '../../documents/s3.client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  classifyDocument,
  extractFields,
  injectionFindings,
  readDocumentBytes,
} from './document-reader.js';

const BATCH_SIZE = 5;

@Injectable()
export class DocumentsJob {
  private readonly logger = new Logger(DocumentsJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async run() {
    const pending = await this.prisma.s3Document.findMany({
      where: { documentProcessed: false },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      include: { estimate: { select: { id: true } }, invoice: { select: { id: true } } },
    });

    let read = 0;
    let failed = 0;
    for (const document of pending) {
      try {
        const outcome = await this.readOne(document);
        if (outcome === 'retry') failed += 1;
        else read += 1;
      } catch (error) {
        failed += 1;
        this.logger.error(
          `Document ${document.id} could not be read`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    if (pending.length) this.logger.log(`Documents read ${read}, waiting on retry ${failed}.`);
    return { read, failed };
  }

  private async readOne(document: {
    id: string;
    bucket: string;
    key: string;
    sha256: string;
    contentType: string;
    filename: string;
    estimate: { id: string } | null;
    invoice: { id: string } | null;
  }): Promise<'read' | 'retry'> {
    let bytes: Buffer;
    try {
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: document.bucket, Key: document.key }),
      );
      if (!object.Body) return 'retry';
      bytes = Buffer.from(await object.Body.transformToByteArray());
    } catch (error) {
      this.logger.warn(
        `Could not download ${document.key}: ${error instanceof Error ? error.message : error}`,
      );
      return 'retry';
    }

    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== document.sha256) {
      await this.finish(document, {
        text: '',
        pageCount: 0,
        source: 'none',
        notes: ['The stored file no longer matches the hash recorded when it was received.'],
        kind: 'unknown',
        confidence: 0,
      });
      return 'read';
    }

    const reading = await readDocumentBytes(bytes, document.contentType);
    const classified = reading.text
      ? classifyDocument(reading.text)
      : { kind: 'unknown' as const, confidence: 0, notes: reading.notes };
    await this.finish(document, {
      ...reading,
      notes: [...reading.notes, ...classified.notes],
      kind: classified.kind,
      confidence: classified.confidence,
    });
    return 'read';
  }

  private async finish(
    document: {
      id: string;
      filename: string;
      estimate: { id: string } | null;
      invoice: { id: string } | null;
    },
    reading: {
      text: string;
      pageCount: number;
      source: string;
      notes: string[];
      kind: 'invoice' | 'estimate' | 'unknown';
      confidence: number;
    },
  ) {
    const fields = extractFields(reading.text);
    const findings = injectionFindings(reading.text);
    const readable = Boolean(reading.text);

    await this.prisma.documentExtraction.create({
      data: {
        documentId: document.id,
        labelText: document.filename,
        valueText: reading.text.slice(0, 20000),
        attempt: 1,
        isCurrent: true,
        status: readable ? 'read' : 'unreadable',
        kind: reading.kind,
        kindConfidence: reading.confidence,
        textSource: reading.source,
        pageCount: reading.pageCount,
        reviewThreshold: 0.8,
        lowThreshold: 0.4,
        signals: findings,
        notes: reading.notes,
        injectionFindings: findings,
        acknowledgedSignals: [],
        suggestionsDiscarded: 0,
        completedAt: new Date(),
        failureReason: readable ? null : reading.notes[0] ?? 'Nothing could be read.',
      },
    });

    if (readable && reading.kind !== 'unknown' && !document.estimate && !document.invoice) {
      await this.createDraft(document.id, reading.kind, fields, reading.text);
    }

    await this.prisma.s3Document.update({
      where: { id: document.id },
      data: {
        documentProcessed: true,
        documentProcessedAt: new Date(),
        status: readable ? 'read' : 'unreadable',
      },
    });
  }

  private async createDraft(
    documentId: string,
    kind: 'invoice' | 'estimate',
    fields: ReturnType<typeof extractFields>,
    text: string,
  ) {
    const owner = await this.owner();
    if (!owner) {
      this.logger.warn(`Document ${documentId} was read, but no staff user exists to own the draft.`);
      return;
    }

    const vendors = await this.prisma.vendor.findMany({
      where: { isActive: true, archivedAt: null },
      select: { id: true, name: true },
    });
    const lowered = text.toLowerCase();
    const matched = vendors.filter((vendor) => lowered.includes(vendor.name.toLowerCase()));
    const vendorId = matched.length === 1 ? matched[0].id : null;

    if (kind === 'estimate') {
      const estimate = await this.prisma.estimate.create({
        data: {
          reference: nextReference('EST'),
          status: 'DRAFT',
          requesterId: owner.id,
          documentId,
          vendorId,
          currency: fields.currency,
          totalMinorUnits: fields.totalMinorUnits,
          estimateNumber: fields.number,
          description: 'Created from a document read by the mailbox.',
        },
      });
      await this.audit.append({
        action: 'estimate.created',
        actorType: 'service',
        actorId: owner.id,
        actorLabel: 'document reader',
        subjectType: 'estimate',
        subjectId: estimate.id,
        detail: { reference: estimate.reference, documentId },
      });
      return;
    }

    const invoice = await this.prisma.invoice.create({
      data: {
        reference: nextReference('INV'),
        status: 'DRAFT',
        createdById: owner.id,
        documentId,
        vendorId,
        currency: fields.currency,
        totalMinorUnits: fields.totalMinorUnits,
        invoiceNumber: fields.number,
        description: 'Created from a document read by the mailbox.',
      },
    });
    await this.audit.append({
      action: 'invoice.created',
      actorType: 'service',
      actorId: owner.id,
      actorLabel: 'document reader',
      subjectType: 'invoice',
      subjectId: invoice.id,
      detail: { reference: invoice.reference, documentId },
    });
  }

  private async owner() {
    const users = await this.prisma.user.findMany({
      where: { archivedAt: null },
      select: { id: true, role: true },
      orderBy: { createdAt: 'asc' },
    });
    return (
      users.find((user) => parseRoleField(user.role).includes('administrator')) ??
      users.find((user) => parseRoleField(user.role).includes('finance')) ??
      users[0] ??
      null
    );
  }
}
