import { createHash } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import {
  AiGatewayService,
  type GatewayOutcome,
} from '../../ai/ai-gateway.service.js';
import {
  MODEL_PROPOSAL_CONFIDENCE,
  RULE_CONFIDENCE,
} from '../../ai/prompts.js';
import { AuditService } from '../../common/audit.service.js';
import { nextReference } from '../../common/ids.js';
import { parseRoleField } from '../../common/roles.js';
import {
  FIELD_DEFS,
  type FieldName,
} from '../../documents/document-reading.js';
import { s3Client } from '../../documents/s3.client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  classifyDocument,
  extractFields,
  injectionFindings,
  readDocumentBytes,
} from './document-reader.js';

const BATCH_SIZE = 5;

type FieldFill = {
  name: FieldName;
  text: string;
  origin: 'rule' | 'model' | 'absent';
  confidence: number;
};

@Injectable()
export class DocumentsJob {
  private readonly logger = new Logger(DocumentsJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly gateway: AiGatewayService,
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
    let classified = reading.text
      ? classifyDocument(reading.text)
      : { kind: 'unknown' as const, confidence: 0, notes: reading.notes };

    let gatewayOutcome: GatewayOutcome | null = null;
    let modelName: string | null = null;
    let promptId: string | null = null;
    let promptVersion: number | null = null;
    let promptSha256: string | null = null;
    let modelLatencyMs: number | null = null;
    let suggestionsDiscarded = 0;
    const notes = [...reading.notes, ...classified.notes];

    if (reading.text && classified.kind === 'unknown') {
      const kindSuggestion = await this.gateway.suggestKind(reading.text);
      gatewayOutcome = kindSuggestion.outcome;
      modelName = kindSuggestion.modelName;
      promptId = kindSuggestion.promptId;
      promptVersion = kindSuggestion.promptVersion;
      promptSha256 = kindSuggestion.promptSha256;
      modelLatencyMs = kindSuggestion.latencyMs;
      if (kindSuggestion.note) notes.push(kindSuggestion.note);
      if (
        kindSuggestion.outcome === 'answered' &&
        kindSuggestion.kind !== 'unknown'
      ) {
        classified = {
          kind:
            kindSuggestion.kind === 'estimate' || kindSuggestion.kind === 'invoice'
              ? kindSuggestion.kind
              : 'unknown',
          confidence: MODEL_PROPOSAL_CONFIDENCE,
          notes: [
            `The document does not say what it is. The assistive reader identified it as: ${kindSuggestion.kind}.`,
          ],
        };
        notes.push(...classified.notes);
      }
    }

    const ruleFields = extractFields(reading.text);
    const fills = await this.fillFields(reading.text, classified.kind, ruleFields);
    if (fills.gatewayOutcome) gatewayOutcome = fills.gatewayOutcome;
    if (fills.modelName) modelName = fills.modelName;
    if (fills.promptId) promptId = fills.promptId;
    if (fills.promptVersion != null) promptVersion = fills.promptVersion;
    if (fills.promptSha256) promptSha256 = fills.promptSha256;
    if (fills.latencyMs != null) {
      modelLatencyMs = (modelLatencyMs ?? 0) + fills.latencyMs;
    }
    suggestionsDiscarded += fills.discarded;
    if (fills.note) notes.push(fills.note);

    await this.finish(
      document,
      {
        ...reading,
        notes,
        kind: classified.kind,
        confidence: classified.confidence,
      },
      {
        fills: fills.fields,
        gatewayOutcome,
        modelName,
        promptId,
        promptVersion,
        promptSha256,
        modelLatencyMs,
        suggestionsDiscarded,
      },
    );
    return 'read';
  }

  private async fillFields(
    text: string,
    kind: string,
    rules: ReturnType<typeof extractFields>,
  ) {
    const byName = new Map<FieldName, FieldFill>();
    if (rules.currency) {
      byName.set('currency', {
        name: 'currency',
        text: rules.currency,
        origin: 'rule',
        confidence: RULE_CONFIDENCE,
      });
    }
    if (rules.number) {
      byName.set('document_number', {
        name: 'document_number',
        text: rules.number,
        origin: 'rule',
        confidence: RULE_CONFIDENCE,
      });
    }
    if (rules.totalMinorUnits != null) {
      byName.set('total', {
        name: 'total',
        text: (Number(rules.totalMinorUnits) / 100).toFixed(2),
        origin: 'rule',
        confidence: RULE_CONFIDENCE,
      });
    }

    const wanted = FIELD_DEFS.map((field) => field.name).filter(
      (name) => !byName.has(name) && name !== 'currency',
    );

    let gatewayOutcome: GatewayOutcome | null = null;
    let modelName: string | null = null;
    let promptId: string | null = null;
    let promptVersion: number | null = null;
    let promptSha256: string | null = null;
    let latencyMs: number | null = null;
    let discarded = 0;
    let note: string | null = null;

    if (text && kind !== 'unknown' && wanted.length > 0) {
      const suggestion = await this.gateway.suggestFields(text, kind, wanted);
      gatewayOutcome = suggestion.outcome;
      modelName = suggestion.modelName;
      promptId = suggestion.promptId;
      promptVersion = suggestion.promptVersion;
      promptSha256 = suggestion.promptSha256;
      latencyMs = suggestion.latencyMs;
      discarded = suggestion.discarded;
      note = suggestion.note;
      for (const item of suggestion.suggestions) {
        byName.set(item.name, {
          name: item.name,
          text: item.text,
          origin: 'model',
          confidence: MODEL_PROPOSAL_CONFIDENCE,
        });
      }
    }

    return {
      fields: FIELD_DEFS.map(
        (field) =>
          byName.get(field.name) ?? {
            name: field.name,
            text: '',
            origin: 'absent' as const,
            confidence: 0,
          },
      ),
      gatewayOutcome,
      modelName,
      promptId,
      promptVersion,
      promptSha256,
      latencyMs,
      discarded,
      note,
    };
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
    assist?: {
      fills: FieldFill[];
      gatewayOutcome: GatewayOutcome | null;
      modelName: string | null;
      promptId: string | null;
      promptVersion: number | null;
      promptSha256: string | null;
      modelLatencyMs: number | null;
      suggestionsDiscarded: number;
    },
  ) {
    const findings = injectionFindings(reading.text);
    const readable = Boolean(reading.text);
    const fills =
      assist?.fills ??
      FIELD_DEFS.map((field) => ({
        name: field.name,
        text: '',
        origin: 'absent' as const,
        confidence: 0,
      }));
    const status = readable
      ? fills.some((field) => field.text)
        ? 'needs_review'
        : 'manual_entry_required'
      : 'unreadable';

    await this.prisma.$transaction(async (tx) => {
      await tx.documentExtraction.updateMany({
        where: { documentId: document.id, isCurrent: true },
        data: { isCurrent: false },
      });
      await tx.documentExtraction.createMany({
        data: fills.map((field) => ({
          documentId: document.id,
          labelText: field.name,
          valueText: field.text,
          attempt: 1,
          isCurrent: true,
          status,
          kind: reading.kind,
          kindConfidence: reading.confidence,
          textSource: reading.source,
          pageCount: reading.pageCount,
          reviewThreshold: 0.85,
          lowThreshold: 0.5,
          signals: findings,
          notes: [
            ...reading.notes,
            {
              origin: field.origin,
              confidence: field.confidence,
            },
          ],
          injectionFindings: findings,
          acknowledgedSignals: [],
          gatewayOutcome: assist?.gatewayOutcome ?? null,
          modelName: assist?.modelName ?? null,
          promptId: assist?.promptId ?? null,
          promptVersion: assist?.promptVersion ?? null,
          promptSha256: assist?.promptSha256 ?? null,
          modelLatencyMs: assist?.modelLatencyMs ?? null,
          suggestionsDiscarded: assist?.suggestionsDiscarded ?? 0,
          completedAt: new Date(),
          failureReason: readable ? null : reading.notes[0] ?? 'Nothing could be read.',
        })),
      });
      await tx.s3Document.update({
        where: { id: document.id },
        data: {
          documentProcessed: true,
          documentProcessedAt: new Date(),
          status,
          kind: reading.kind,
        },
      });
    });

    await this.audit.append({
      action: 'extraction_completed',
      actorType: 'service',
      actorLabel: 'document reader',
      subjectType: 'document',
      subjectId: document.id,
      detail: {
        kind: reading.kind,
        gatewayOutcome: assist?.gatewayOutcome ?? null,
        suggestionsDiscarded: assist?.suggestionsDiscarded ?? 0,
      },
    });

    const fields = extractFields(reading.text);
    if (readable && reading.kind !== 'unknown' && !document.estimate && !document.invoice) {
      await this.createDraft(document.id, reading.kind, fields, reading.text, fills);
    }
  }

  private async createDraft(
    documentId: string,
    kind: 'invoice' | 'estimate',
    fields: ReturnType<typeof extractFields>,
    text: string,
    fills: FieldFill[],
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
    const currency =
      (fills.find((field) => field.name === 'currency')?.text as 'JMD' | 'USD' | undefined) ??
      fields.currency;
    const number =
      fills.find((field) => field.name === 'document_number')?.text || fields.number;
    const totalText = fills.find((field) => field.name === 'total')?.text;
    const totalMinorUnits =
      totalText && Number.isFinite(Number(totalText.replace(/,/g, '')))
        ? BigInt(Math.round(Number(totalText.replace(/,/g, '')) * 100))
        : fields.totalMinorUnits;

    if (kind === 'estimate') {
      const estimate = await this.prisma.estimate.create({
        data: {
          reference: nextReference('EST'),
          status: 'DRAFT',
          requesterId: owner.id,
          documentId,
          vendorId,
          currency: currency ?? null,
          totalMinorUnits: totalMinorUnits ?? null,
          estimateNumber: number,
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
        currency: currency ?? null,
        totalMinorUnits: totalMinorUnits ?? null,
        invoiceNumber: number,
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
