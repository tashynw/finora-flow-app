import { Injectable } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/index.js';
import { DomainException, notFound } from '../common/errors.js';
import { resolvePage } from '../common/pagination.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { documentObjectKey, folderForKind } from './document-keys.js';
import {
  blankReading,
  fieldNeedsAttention,
  isFieldName,
  parseReading,
  toFieldOut,
  type StoredReading,
} from './document-reading.js';
import { DocumentsService } from './documents.service.js';

const KIND_LABEL: Record<string, string> = {
  invoice: 'Invoice',
  estimate: 'Estimate or quotation',
  credit_note: 'Credit note',
  receipt: 'Receipt',
  purchase_order: 'Purchase order',
  statement: 'Statement of account',
  remittance_advice: 'Remittance advice',
  unknown: 'Not identified',
};

const DOCUMENT_KINDS = new Set(Object.keys(KIND_LABEL));
const EXTRACTION_STATUSES = new Set([
  'pending',
  'extracting',
  'extracted',
  'needs_review',
  'accepted',
  'manual_entry_required',
  'failed',
]);

type Actor = { id: string; name: string };

type StoredDocument = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: bigint;
  sha256: string;
  key: string;
  bucket: string;
  kind: string;
  status: string;
  documentProcessed: boolean;
  createdAt: Date;
  messageId: string;
  message: {
    subject: string;
    fromAddress: string | null;
  };
};

@Injectable()
export class DocumentsRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
  ) {}

  async list(query: {
    status?: string;
    kind?: string;
    limit?: number;
    offset?: number;
  }) {
    const page = resolvePage(query);
    const where: {
      kind?: string;
      documentProcessed?: boolean;
      status?: string;
    } = {};
    if (query.kind) where.kind = query.kind;
    if (query.status === 'pending') where.documentProcessed = false;
    else if (query.status) where.status = query.status;

    const [rows, total] = await Promise.all([
      this.prisma.s3Document.findMany({
        where,
        include: {
          message: true,
          extractions: { where: { isCurrent: true }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
        take: page.take,
        skip: page.skip,
      }),
      this.prisma.s3Document.count({ where }),
    ]);

    return {
      items: rows.map((row) => this.summary(row)),
      total,
      limit: page.limit ?? page.take,
      offset: page.offset ?? page.skip,
    };
  }

  async getById(id: string) {
    const row = await this.requireDocument(id);
    const extraction = row.extractions[0] ?? null;
    const reading = extraction ? parseReading(extraction.notes) : null;
    const blockers = reading
      ? reading.fields.filter(fieldNeedsAttention).map((field) => `${field.name} still needs a value`)
      : [];
    return {
      ...this.summary(row),
      acceptance_blockers: blockers,
      extraction: extraction ? this.extractionOut(extraction, reading ?? blankReading()) : null,
      history: [],
      raised_as: null,
    };
  }

  async readPending() {
    const waiting = await this.prisma.s3Document.findMany({
      where: { documentProcessed: false },
      include: { message: true, extractions: { where: { isCurrent: true }, take: 1 } },
      take: 25,
    });
    for (const row of waiting) {
      await this.openReading(row.id, row.kind, row.extractions[0]?.attempt ?? 0);
      await this.prisma.s3Document.update({
        where: { id: row.id },
        data: { documentProcessed: true, status: 'manual_entry_required' },
      });
    }
    return {
      documents_queued: waiting.length,
      detail: waiting.length
        ? `Reading has started on ${waiting.length} documents waiting.`
        : 'Nothing is waiting to be read.',
    };
  }

  async reread(id: string) {
    const row = await this.requireDocument(id);
    const current = row.extractions[0];
    if (current?.status === 'accepted') {
      throw new DomainException(
        'An accepted reading cannot be replaced from the review screen.',
        HttpStatus.CONFLICT,
      );
    }
    await this.openReading(id, row.kind, current?.attempt ?? 0);
    await this.prisma.s3Document.update({
      where: { id },
      data: { documentProcessed: true, status: 'manual_entry_required' },
    });
    return this.getById(id);
  }

  async correctField(
    id: string,
    name: string,
    body: { text: string; reason?: string | null },
    actor: Actor,
  ) {
    if (!isFieldName(name)) throw notFound('Field', name);
    const extraction = await this.requireOpenReading(id);
    const reading = parseReading(extraction.notes);
    const field = reading.fields.find((row) => row.name === name);
    if (!field) throw notFound('Field', name);
    if (!field.readerText) field.readerText = field.text || null;
    field.text = body.text;
    field.origin = 'human';
    field.review = 'corrected';
    field.confidence = 1;
    field.correctedAt = new Date().toISOString();
    field.correctionReason = body.reason?.trim() || null;
    await this.saveReading(extraction.id, reading, actor, 'corrected');
    return this.getById(id);
  }

  async reviewField(id: string, name: string, review: string, actor: Actor) {
    if (!isFieldName(name)) throw notFound('Field', name);
    if (review !== 'confirmed' && review !== 'cleared' && review !== 'corrected') {
      throw new DomainException('That review is not recognised.');
    }
    const extraction = await this.requireOpenReading(id);
    const reading = parseReading(extraction.notes);
    const field = reading.fields.find((row) => row.name === name);
    if (!field) throw notFound('Field', name);
    field.review = review;
    if (review === 'cleared') field.text = '';
    await this.saveReading(extraction.id, reading, actor, review);
    return this.getById(id);
  }

  async acknowledge(id: string, signal: string) {
    const extraction = await this.requireOpenReading(id);
    const current = Array.isArray(extraction.acknowledgedSignals)
      ? extraction.acknowledgedSignals.filter((item): item is string => typeof item === 'string')
      : [];
    if (!current.includes(signal)) current.push(signal);
    await this.prisma.documentExtraction.update({
      where: { id: extraction.id },
      data: { acknowledgedSignals: current },
    });
    return this.getById(id);
  }

  async accept(id: string, note: string | null, actor: Actor) {
    const extraction = await this.requireOpenReading(id);
    const reading = parseReading(extraction.notes);
    const blockers = reading.fields.filter(fieldNeedsAttention);
    if (blockers.length) {
      throw new DomainException('This reading still has values that need a person.');
    }
    await this.prisma.documentExtraction.update({
      where: { id: extraction.id },
      data: {
        status: 'accepted',
        acceptedAt: new Date(),
        acceptedById: actor.id,
        acceptedNote: note?.trim() || null,
      },
    });
    await this.prisma.s3Document.update({
      where: { id },
      data: { status: 'accepted', documentProcessed: true, documentProcessedAt: new Date() },
    });
    return this.getById(id);
  }

  async viewerUrl(id: string) {
    const row = await this.requireDocument(id);
    const view = await this.documents.createViewUrl({
      key: row.key,
      bucket: row.bucket,
    });
    return {
      url: view.url,
      content_type: row.contentType,
      filename: row.filename,
      expires_in_seconds: 3600,
    };
  }

  async setKind(id: string, kind: string) {
    if (!DOCUMENT_KINDS.has(kind)) {
      throw notFound('Document kind', kind);
    }
    const row = await this.requireDocument(id);
    const folder = folderForKind(kind);
    const uuid = crypto.randomUUID();
    const nextKey = documentObjectKey(folder, uuid, row.filename);
    if (nextKey !== row.key) {
      await this.documents.copyObject({
        fromKey: row.key,
        toKey: nextKey,
        bucket: row.bucket,
      });
      await this.documents.deleteObject({ key: row.key, bucket: row.bucket });
    }
    await this.prisma.s3Document.update({
      where: { id },
      data: { kind, key: nextKey },
    });
    return this.getById(id);
  }

  private async requireDocument(id: string) {
    const row = await this.prisma.s3Document.findUnique({
      where: { id },
      include: {
        message: true,
        extractions: { where: { isCurrent: true }, orderBy: { attempt: 'desc' }, take: 1 },
      },
    });
    if (!row) throw notFound('Document', id);
    return row;
  }

  private async requireOpenReading(documentId: string) {
    const row = await this.requireDocument(documentId);
    const current = row.extractions[0];
    if (!current) {
      throw new DomainException(
        'This document has not been read yet.',
        HttpStatus.CONFLICT,
      );
    }
    if (current.status === 'accepted') {
      throw new DomainException(
        'An accepted reading cannot be changed from the review screen.',
        HttpStatus.CONFLICT,
      );
    }
    return current;
  }

  private async openReading(documentId: string, kind: string, previousAttempt: number) {
    await this.prisma.documentExtraction.updateMany({
      where: { documentId, isCurrent: true },
      data: { isCurrent: false },
    });
    const knownKind = DOCUMENT_KINDS.has(kind) ? kind : 'unknown';
    return this.prisma.documentExtraction.create({
      data: {
        documentId,
        labelText: 'reading',
        valueText: '',
        attempt: previousAttempt + 1,
        isCurrent: true,
        status: 'manual_entry_required',
        kind: knownKind,
        kindConfidence: 0,
        textSource: 'manual',
        pageCount: 1,
        reviewThreshold: 0.85,
        lowThreshold: 0.5,
        signals: [],
        notes: blankReading() as unknown as Prisma.InputJsonValue,
        injectionFindings: [],
        acknowledgedSignals: [],
        suggestionsDiscarded: 0,
      },
    });
  }

  private async saveReading(
    extractionId: string,
    reading: StoredReading,
    actor: Actor,
    review: string,
  ) {
    const attention = reading.fields.some(fieldNeedsAttention);
    await this.prisma.documentExtraction.update({
      where: { id: extractionId },
      data: {
        notes: reading as unknown as Prisma.InputJsonValue,
        status: attention ? 'needs_review' : 'extracted',
        reviews: {
          create: {
            review,
            createdById: actor.id,
            correctedAt: new Date(),
          },
        },
      },
    });
    const extraction = await this.prisma.documentExtraction.findUnique({
      where: { id: extractionId },
      select: { documentId: true },
    });
    if (extraction) {
      await this.prisma.s3Document.update({
        where: { id: extraction.documentId },
        data: { status: attention ? 'needs_review' : 'extracted' },
      });
    }
  }

  private extractionOut(
    extraction: {
      id: string;
      attempt: number;
      status: string;
      kind: string;
      kindConfidence: number;
      textSource: string;
      pageCount: number;
      reviewThreshold: number;
      suggestionsDiscarded: number;
      modelName: string | null;
      promptId: string | null;
      promptVersion: number | null;
      gatewayOutcome: string | null;
      completedAt: Date | null;
      acceptedAt: Date | null;
      acceptedNote: string | null;
      signals: Prisma.JsonValue;
    },
    reading: StoredReading,
  ) {
    const kind = DOCUMENT_KINDS.has(extraction.kind) ? extraction.kind : 'unknown';
    const signals = Array.isArray(extraction.signals) ? extraction.signals : [];
    return {
      id: extraction.id,
      attempt: extraction.attempt,
      status: extraction.status,
      kind,
      kind_label: KIND_LABEL[kind] ?? 'Not identified',
      kind_confidence: extraction.kindConfidence,
      kind_evidence: null,
      text_source: extraction.textSource,
      page_count: extraction.pageCount,
      review_threshold: extraction.reviewThreshold,
      suggestions_discarded: extraction.suggestionsDiscarded,
      model_name: extraction.modelName,
      prompt_id: extraction.promptId,
      prompt_version: extraction.promptVersion,
      gateway_outcome: extraction.gatewayOutcome,
      completed_at: extraction.completedAt?.toISOString() ?? null,
      accepted_at: extraction.acceptedAt?.toISOString() ?? null,
      accepted_note: extraction.acceptedNote,
      notes: reading.textNotes,
      signals,
      fields: reading.fields.map(toFieldOut),
    };
  }

  private summary(row: StoredDocument & { extractions?: { notes: Prisma.JsonValue; status: string }[] }) {
    const kind = DOCUMENT_KINDS.has(row.kind) ? row.kind : 'unknown';
    const current = row.extractions?.[0];
    const reading = current ? parseReading(current.notes) : null;
    const attention = reading ? reading.fields.filter(fieldNeedsAttention).length : 0;
    const status = EXTRACTION_STATUSES.has(row.status)
      ? row.status
      : current?.status && EXTRACTION_STATUSES.has(current.status)
        ? current.status
        : row.documentProcessed
          ? 'extracted'
          : 'pending';
    return {
      id: row.id,
      filename: row.filename,
      content_type: row.contentType,
      size_bytes: Number(row.sizeBytes),
      sha256: row.sha256,
      kind,
      kind_label: KIND_LABEL[kind] ?? 'Not identified',
      status,
      created_at: row.createdAt.toISOString(),
      message_id: row.messageId,
      subject: row.message.subject,
      from_address: row.message.fromAddress,
      fields_needing_attention: attention,
      lowest_confidence: null,
      signal_count: 0,
    };
  }
}
