import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/index.js';
import { AuditService } from '../common/audit.service.js';
import { conflict, DomainException, notFound } from '../common/errors.js';
import { resolvePage } from '../common/pagination.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { documentObjectKey, folderForKind } from './document-keys.js';
import {
  FIELD_DEFS,
  attentionBlocker,
  fieldLabel,
  fieldNeedsAttention,
  isFieldName,
  type FieldReviewState,
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

const REVIEW_THRESHOLD = 0.85;
const LOW_THRESHOLD = 0.5;

type Actor = { id: string; name: string };

type ReviewRow = {
  review: string;
  correctedAt: Date | null;
  correctionReason: string | null;
};

type FieldRow = {
  id: string;
  labelText: string;
  valueText: string;
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
  notes: Prisma.JsonValue;
  acknowledgedSignals: Prisma.JsonValue;
  reviews: ReviewRow[];
};

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
  extractions: FieldRow[];
};

const currentFields = {
  where: { isCurrent: true },
  include: {
    reviews: { orderBy: { createdAt: 'desc' as const }, take: 1 },
  },
  orderBy: { labelText: 'asc' as const },
};

@Injectable()
export class DocumentsRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
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
        include: { message: true, extractions: currentFields },
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
    const row = await this.ensureFieldRows(await this.requireDocument(id));
    const fields = this.knownFields(row.extractions);
    const head = fields[0] ?? null;
    return {
      ...this.summary(row),
      acceptance_blockers: this.blockers(row.kind, fields),
      extraction: head ? this.extractionOut(head, fields) : null,
      history: await this.history(id, head?.attempt ?? null),
      raised_as: null,
    };
  }

  async readPending() {
    const waiting = await this.prisma.s3Document.findMany({
      where: { documentProcessed: false },
      include: { extractions: { where: { isCurrent: true }, take: 1 } },
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

  async reread(id: string, actor: Actor) {
    const row = await this.requireDocument(id);
    const current = row.extractions[0];
    if (current?.status === 'accepted') {
      throw conflict('An accepted reading cannot be replaced from the review screen.');
    }
    const attempt = (current?.attempt ?? 0) + 1;
    await this.openReading(id, row.kind, current?.attempt ?? 0);
    await this.prisma.s3Document.update({
      where: { id },
      data: { documentProcessed: true, status: 'manual_entry_required' },
    });
    await this.audit.append({
      action: 'extraction_completed',
      actorId: actor.id,
      actorLabel: actor.name,
      subjectType: 'document',
      subjectId: id,
      detail: { attempt, status: 'manual_entry_required', text_source: 'manual' },
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
    const text = body.text.trim();
    if (!text) {
      throw new DomainException(
        'Enter a value, or mark the field as not present on the document.',
      );
    }
    const rows = await this.openFields(id);
    const field = rows.find((row) => row.labelText === name);
    if (!field) throw notFound('Field', name);
    const before = field.valueText;
    const reason = body.reason?.trim() || null;
    await this.prisma.$transaction([
      this.prisma.documentExtraction.update({
        where: { id: field.id },
        data: { valueText: text },
      }),
      this.prisma.extractionReview.create({
        data: {
          documentExtractionId: field.id,
          review: 'corrected',
          createdById: actor.id,
          correctedById: actor.id,
          correctedAt: new Date(),
          correctionReason: reason,
        },
      }),
    ]);
    await this.recompute(id);
    await this.audit.append({
      action: 'extraction_corrected',
      actorId: actor.id,
      actorLabel: actor.name,
      subjectType: 'document',
      subjectId: id,
      detail: {
        field: name,
        attempt: field.attempt,
        from: before,
        to: text,
        reason,
      },
    });
    return this.getById(id);
  }

  async reviewField(id: string, name: string, review: string, actor: Actor) {
    if (!isFieldName(name)) throw notFound('Field', name);
    if (review !== 'confirmed' && review !== 'cleared') {
      throw new DomainException(
        'A field is either confirmed as read, cleared as not present, or corrected.',
      );
    }
    const rows = await this.openFields(id);
    const field = rows.find((row) => row.labelText === name);
    if (!field) throw notFound('Field', name);
    if (review === 'confirmed' && !field.valueText.trim()) {
      throw new DomainException('There is no value to confirm. Enter one, or clear the field.');
    }
    await this.prisma.$transaction([
      ...(review === 'cleared'
        ? [
            this.prisma.documentExtraction.update({
              where: { id: field.id },
              data: { valueText: '' },
            }),
          ]
        : []),
      this.prisma.extractionReview.create({
        data: {
          documentExtractionId: field.id,
          review,
          createdById: actor.id,
          correctedById: actor.id,
          correctedAt: new Date(),
        },
      }),
    ]);
    await this.recompute(id);
    await this.audit.append({
      action: 'extraction_corrected',
      actorId: actor.id,
      actorLabel: actor.name,
      subjectType: 'document',
      subjectId: id,
      detail: { field: name, attempt: field.attempt, review },
    });
    return this.getById(id);
  }

  async acknowledge(id: string, signal: string, actor: Actor) {
    const rows = await this.openFields(id);
    const head = rows[0];
    if (!head) throw conflict('This document has not been read yet.');
    const signals = jsonStrings(head.signals);
    if (!signals.includes(signal)) {
      throw new DomainException('This document does not carry that warning.');
    }
    const acknowledged = jsonStrings(head.acknowledgedSignals);
    if (!acknowledged.includes(signal)) acknowledged.push(signal);
    await this.prisma.documentExtraction.updateMany({
      where: { documentId: id, isCurrent: true },
      data: { acknowledgedSignals: acknowledged },
    });
    await this.audit.append({
      action: 'extraction_corrected',
      actorId: actor.id,
      actorLabel: actor.name,
      subjectType: 'document',
      subjectId: id,
      detail: { attempt: head.attempt, acknowledged_signal: signal },
    });
    return this.getById(id);
  }

  async accept(id: string, note: string | null, actor: Actor) {
    const rows = await this.openFields(id);
    const document = await this.prisma.s3Document.findUnique({
      where: { id },
      select: { kind: true },
    });
    const blockers = this.blockers(document?.kind ?? 'unknown', rows);
    if (blockers.length) {
      throw new DomainException(
        'This reading still has values that need a person.',
        HttpStatus.CONFLICT,
        'NOT_ACCEPTABLE',
        { blockers },
      );
    }
    const trimmed = note?.trim() || null;
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.documentExtraction.updateMany({
        where: { documentId: id, isCurrent: true },
        data: {
          status: 'accepted',
          acceptedAt: now,
          acceptedById: actor.id,
          acceptedNote: trimmed,
        },
      }),
      this.prisma.s3Document.update({
        where: { id },
        data: { status: 'accepted', documentProcessed: true, documentProcessedAt: now },
      }),
    ]);
    await this.audit.append({
      action: 'extraction_accepted',
      actorId: actor.id,
      actorLabel: actor.name,
      subjectType: 'document',
      subjectId: id,
      detail: {
        attempt: rows[0]?.attempt,
        kind: document?.kind,
        note: trimmed,
        fields: Object.fromEntries(
          rows.map((row) => [row.labelText, { text: row.valueText, review: reviewOf(row) }]),
        ),
      },
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

  async setKind(id: string, kind: string, actor: Actor) {
    if (!DOCUMENT_KINDS.has(kind)) {
      throw notFound('Document kind', kind);
    }
    const row = await this.requireDocument(id);
    if (row.extractions.some((item) => item.status === 'accepted')) {
      throw conflict('An accepted reading cannot be changed from the review screen.');
    }
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
    await this.prisma.$transaction([
      this.prisma.s3Document.update({
        where: { id },
        data: { kind, key: nextKey },
      }),
      this.prisma.documentExtraction.updateMany({
        where: { documentId: id, isCurrent: true },
        data: { kind },
      }),
    ]);
    await this.recompute(id);
    await this.audit.append({
      action: 'extraction_corrected',
      actorId: actor.id,
      actorLabel: actor.name,
      subjectType: 'document',
      subjectId: id,
      detail: { kind_from: row.kind, kind_to: kind },
    });
    return this.getById(id);
  }

  private async requireDocument(id: string) {
    const row = await this.prisma.s3Document.findUnique({
      where: { id },
      include: { message: true, extractions: currentFields },
    });
    if (!row) throw notFound('Document', id);
    return row;
  }

  /**
   * A reading is one row per field. Older rows stored the whole reading in
   * notes on a single line; those are replaced the first time the document is
   * opened, so the review screen has a row to correct.
   */
  private async ensureFieldRows(row: StoredDocument) {
    const current = row.extractions;
    if (current.length === 0 || current.some((item) => item.status === 'accepted')) {
      return row;
    }
    const known = this.knownFields(current);
    if (known.length === FIELD_DEFS.length) return row;
    if (known.length === 0) {
      await this.openReading(row.id, row.kind, current[0]?.attempt ?? 0);
      await this.prisma.s3Document.update({
        where: { id: row.id },
        data: { documentProcessed: true, status: 'manual_entry_required' },
      });
      return this.requireDocument(row.id);
    }
    const template = known[0];
    if (!template) return row;
    const present = new Set(known.map((item) => item.labelText));
    await this.prisma.documentExtraction.createMany({
      data: FIELD_DEFS.filter((field) => !present.has(field.name)).map((field) =>
        this.fieldCreate(row.id, row.kind, template.attempt, field.name, template.status),
      ),
    });
    return this.requireDocument(row.id);
  }

  private async openFields(documentId: string) {
    const row = await this.ensureFieldRows(await this.requireDocument(documentId));
    const fields = this.knownFields(row.extractions);
    if (fields.length === 0) {
      throw conflict('This document has not been read yet.');
    }
    if (fields.some((item) => item.status === 'accepted')) {
      throw conflict('An accepted reading cannot be changed from the review screen.');
    }
    return fields;
  }

  private knownFields(rows: FieldRow[]) {
    return rows.filter((row) => isFieldName(row.labelText));
  }

  private async openReading(documentId: string, kind: string, previousAttempt: number) {
    const knownKind = DOCUMENT_KINDS.has(kind) ? kind : 'unknown';
    const attempt = previousAttempt + 1;
    await this.prisma.$transaction(async (tx) => {
      await tx.documentExtraction.updateMany({
        where: { documentId, isCurrent: true },
        data: { isCurrent: false },
      });
      await tx.documentExtraction.createMany({
        data: FIELD_DEFS.map((field) =>
          this.fieldCreate(documentId, knownKind, attempt, field.name, 'manual_entry_required'),
        ),
      });
    });
  }

  private fieldCreate(
    documentId: string,
    kind: string,
    attempt: number,
    label: string,
    status: string,
  ): Prisma.DocumentExtractionCreateManyInput {
    return {
      documentId,
      labelText: label,
      valueText: '',
      attempt,
      isCurrent: true,
      status,
      kind,
      kindConfidence: 0,
      textSource: 'manual',
      pageCount: 1,
      reviewThreshold: REVIEW_THRESHOLD,
      lowThreshold: LOW_THRESHOLD,
      signals: [],
      notes: [],
      injectionFindings: [],
      acknowledgedSignals: [],
      suggestionsDiscarded: 0,
    };
  }

  private blockers(kind: string, fields: FieldRow[]) {
    const blockers: string[] = [];
    if (!kind || kind === 'unknown') {
      blockers.push('Say what kind of document this is. The kind decides which fields it needs.');
    }
    for (const field of FIELD_DEFS) {
      const row = fields.find((item) => item.labelText === field.name);
      const review = row ? reviewOf(row) : 'unreviewed';
      const text = row?.valueText ?? '';
      if (fieldNeedsAttention(field.name, text, review)) {
        blockers.push(attentionBlocker(field.name));
      }
    }
    return blockers;
  }

  private async recompute(documentId: string) {
    const rows = await this.prisma.documentExtraction.findMany({
      where: { documentId, isCurrent: true },
      include: { reviews: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    const fields = rows.filter((row) => isFieldName(row.labelText));
    const document = await this.prisma.s3Document.findUnique({
      where: { id: documentId },
      select: { kind: true },
    });
    const waiting = this.blockers(document?.kind ?? 'unknown', fields);
    const touched = fields.some((row) => reviewOf(row) !== 'unreviewed');
    const status = waiting.length === 0 ? 'extracted' : touched ? 'needs_review' : 'manual_entry_required';
    await this.prisma.$transaction([
      this.prisma.documentExtraction.updateMany({
        where: { documentId, isCurrent: true },
        data: { status },
      }),
      this.prisma.s3Document.update({
        where: { id: documentId },
        data: { status, documentProcessed: true },
      }),
    ]);
  }

  private async history(documentId: string, currentAttempt: number | null) {
    const past = await this.prisma.documentExtraction.findMany({
      where: {
        documentId,
        isCurrent: false,
        ...(currentAttempt != null ? { attempt: { lt: currentAttempt } } : {}),
      },
      orderBy: { attempt: 'desc' },
    });
    const seen = new Set<number>();
    const attempts = [];
    for (const row of past) {
      if (seen.has(row.attempt) || !isFieldName(row.labelText)) continue;
      seen.add(row.attempt);
      const kind = DOCUMENT_KINDS.has(row.kind) ? row.kind : 'unknown';
      attempts.push({
        id: row.id,
        attempt: row.attempt,
        status: EXTRACTION_STATUSES.has(row.status) ? row.status : 'needs_review',
        kind,
        model_name: row.modelName,
        completed_at: row.completedAt?.toISOString() ?? null,
        accepted_at: row.acceptedAt?.toISOString() ?? null,
      });
    }
    return attempts;
  }

  private extractionOut(head: FieldRow, fields: FieldRow[]) {
    const kind = DOCUMENT_KINDS.has(head.kind) ? head.kind : 'unknown';
    const acknowledged = new Set(jsonStrings(head.acknowledgedSignals));
    return {
      id: head.id,
      attempt: head.attempt,
      status: head.status,
      kind,
      kind_label: KIND_LABEL[kind] ?? 'Not identified',
      kind_confidence: head.kindConfidence,
      kind_evidence: null,
      text_source: head.textSource,
      page_count: head.pageCount,
      review_threshold: head.reviewThreshold,
      suggestions_discarded: head.suggestionsDiscarded,
      model_name: head.modelName,
      prompt_id: head.promptId,
      prompt_version: head.promptVersion,
      gateway_outcome: head.gatewayOutcome,
      completed_at: head.completedAt?.toISOString() ?? null,
      accepted_at: head.acceptedAt?.toISOString() ?? null,
      accepted_note: head.acceptedNote,
      notes: jsonStrings(head.notes),
      signals: jsonStrings(head.signals).map((signal) => ({
        signal,
        explanation: signal,
        acknowledged: acknowledged.has(signal),
        requires_acknowledgement: false,
      })),
      fields: FIELD_DEFS.map((def) => {
        const row = fields.find((item) => item.labelText === def.name);
        return this.fieldOut(def.name, row);
      }),
    };
  }

  private fieldOut(name: string, row: FieldRow | undefined) {
    const review = row ? reviewOf(row) : 'unreviewed';
    const text = review === 'cleared' ? '' : (row?.valueText ?? '');
    const latest = row?.reviews[0];
    const needsAttention = fieldNeedsAttention(name, text, review);
    const origin = review === 'corrected' || review === 'confirmed' ? 'human' : 'absent';
    return {
      name,
      label: fieldLabel(name),
      text,
      origin,
      confidence: review === 'corrected' || review === 'confirmed' ? 1 : 0,
      reader_confidence: null,
      reader_text: null,
      review,
      needs_attention: needsAttention,
      band: needsAttention ? 'low' : text ? 'high' : 'none',
      amount_minor_units: null,
      currency: null,
      value_date: null,
      corrected_at: latest?.correctedAt?.toISOString() ?? null,
      correction_reason: latest?.correctionReason ?? null,
      evidence: null,
      adjustments: [],
      notes: [],
    };
  }

  private summary(row: StoredDocument) {
    const kind = DOCUMENT_KINDS.has(row.kind) ? row.kind : 'unknown';
    const fields = this.knownFields(row.extractions);
    const head = fields[0] ?? row.extractions[0];
    const attention = fields.filter((item) =>
      fieldNeedsAttention(item.labelText, item.valueText, reviewOf(item)),
    ).length;
    const status = EXTRACTION_STATUSES.has(row.status)
      ? row.status
      : head && EXTRACTION_STATUSES.has(head.status)
        ? head.status
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
      fields_needing_attention: attention || (fields.length === 0 && row.documentProcessed
        ? FIELD_DEFS.filter((field) => field.required).length
        : attention),
      lowest_confidence: null,
      signal_count: head ? jsonStrings(head.signals).length : 0,
    };
  }
}

function reviewOf(row: { reviews: { review: string }[]; valueText?: string }): FieldReviewState {
  const review = row.reviews[0]?.review;
  if (
    review === 'confirmed' ||
    review === 'corrected' ||
    review === 'cleared' ||
    review === 'unreviewed'
  ) {
    return review;
  }
  return 'unreviewed';
}

function jsonStrings(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
