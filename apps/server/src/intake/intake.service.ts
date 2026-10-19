import { Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { ImapFlow } from 'imapflow';
import { actorLabel } from '../common/invoice-status.js';
import { AuditService } from '../common/audit.service.js';
import { conflict, notFound } from '../common/errors.js';
import { resolvePage, type PageQuery } from '../common/pagination.js';
import { DocumentsService } from '../documents/documents.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const STALE_POLL_INTERVALS = 3;
const OLDEST_UNRESOLVED_WARN_SECONDS = 60 * 60;
const TERMINAL_STATUSES = new Set(['ready', 'failed', 'quarantined']);

type MailboxReport = {
  reachable: boolean;
  authenticated: boolean;
  detail: string | null;
  quota_supported: boolean;
  quota_used_kb: number | null;
  quota_limit_kb: number | null;
  quota_used_percent: number | null;
};

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

  async operationsSummary(probeMailbox = false) {
    const pollInterval = Number(process.env.FINORA_IMAP_POLL_INTERVAL_SECONDS || 60);
    const staleAfter = (Number.isFinite(pollInterval) ? pollInterval : 60) * STALE_POLL_INTERVALS;
    const now = Date.now();

    const [rows, statusCounts, oldest] = await Promise.all([
      this.prisma.mailboxCheckpoint.findMany({ orderBy: { folder: 'asc' } }),
      this.prisma.inboundMessage.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.inboundMessage.aggregate({
        where: { status: { not: 'ready' } },
        _min: { receivedAt: true },
      }),
    ]);

    const checkpoints = rows.map((row) => {
      const seconds =
        row.lastPolledAt === null
          ? null
          : Math.max(0, Math.floor((now - row.lastPolledAt.getTime()) / 1000));
      return {
        folder: row.folder,
        uid_validity: Number(row.uidValidity),
        last_seen_uid: Number(row.lastSeenUid),
        last_polled_at: row.lastPolledAt?.toISOString() ?? null,
        seconds_since_poll: seconds,
        last_reset_at: row.lastResetAt?.toISOString() ?? null,
        last_reset_reason: row.lastResetReason,
        is_stalled: seconds === null || seconds > staleAfter,
      };
    });

    const counts = Object.fromEntries(
      statusCounts.map((row) => [row.status, row._count._all]),
    ) as Record<string, number>;
    const countOf = (status: string) => counts[status] ?? 0;
    const failed = countOf('failed');
    const quarantined = countOf('quarantined');
    const inFlight = Object.entries(counts)
      .filter(([status]) => !TERMINAL_STATUSES.has(status))
      .reduce((sum, [, count]) => sum + count, 0);
    const oldestAt = oldest._min.receivedAt;
    const oldestAge =
      oldestAt === null ? null : Math.max(0, Math.floor((now - oldestAt.getTime()) / 1000));
    const backlog = {
      counts_by_status: counts,
      in_flight: inFlight,
      quarantined,
      failed,
      needs_attention: quarantined + failed,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      oldest_unresolved_at: oldestAt?.toISOString() ?? null,
      oldest_unresolved_age_seconds: oldestAge,
    };

    const mailbox = probeMailbox ? await this.probeMailbox() : null;
    const concerns = this.concerns(checkpoints, backlog, mailbox);

    return {
      generated_at: new Date(now).toISOString(),
      state: this.operationalState(checkpoints, backlog, mailbox),
      checkpoints,
      backlog,
      mailbox,
      concerns,
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
    const idempotencyKey = `manual:${body.sha256}:${session.user.id}`;
    const duplicate = await this.findManualDuplicate(body.sha256, session.user.id);
    if (duplicate) {
      await this.refuseDuplicate(session, duplicate.id, body, idempotencyKey);
    }

    try {
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
    } catch (error) {
      const winner = await this.findManualDuplicate(body.sha256, session.user.id);
      if (!winner) throw error;
      await this.refuseDuplicate(session, winner.id, body, idempotencyKey);
    }
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

  private findManualDuplicate(sha256: string, userId: string) {
    return this.prisma.inboundMessage.findFirst({
      where: { source: 'manual_upload', rawSha256: sha256, uploadedById: userId },
      select: { id: true },
    });
  }

  /** A second copy of the same bytes from the same person is the first message, not a new one. */
  private async refuseDuplicate(
    session: UserSession,
    existingId: string,
    body: { sha256: string; key: string; bucket: string },
    idempotencyKey: string,
  ): Promise<never> {
    await this.documents
      .deleteObject({ key: body.key, bucket: body.bucket })
      .catch(() => undefined);
    await this.audit.append({
      action: 'message_duplicate_detected',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: 'inbound_message',
      subjectId: existingId,
      detail: { sha256: body.sha256, idempotency_key: idempotencyKey },
    });
    throw conflict(
      `You have already uploaded this exact file. It is already in the workspace as message ${existingId}.`,
    );
  }

  private concerns(
    checkpoints: {
      folder: string;
      is_stalled: boolean;
      seconds_since_poll: number | null;
      last_reset_reason: string | null;
    }[],
    backlog: {
      oldest_unresolved_age_seconds: number | null;
      in_flight: number;
      failed: number;
      quarantined: number;
    },
    mailbox: MailboxReport | null,
  ): string[] {
    const concerns: string[] = [];
    if (checkpoints.length === 0) {
      concerns.push(
        'The mailbox worker has never recorded a poll. Nothing is being collected from the mailbox.',
      );
    }
    for (const checkpoint of checkpoints) {
      if (checkpoint.is_stalled) {
        concerns.push(
          `Polling of ${checkpoint.folder} has stalled. ${
            checkpoint.seconds_since_poll === null
              ? 'It has never completed a poll.'
              : `The last poll was ${Math.floor(checkpoint.seconds_since_poll / 60)} minutes ago.`
          }`,
        );
      }
      if (checkpoint.last_reset_reason) {
        concerns.push(
          `The checkpoint for ${checkpoint.folder} was reset (${checkpoint.last_reset_reason.replaceAll('_', ' ')}). Messages were re-read; duplicates were suppressed by identity.`,
        );
      }
    }
    const age = backlog.oldest_unresolved_age_seconds;
    if (age !== null && age > OLDEST_UNRESOLVED_WARN_SECONDS) {
      concerns.push(
        `The oldest unresolved message has been waiting ${Math.floor(age / 3600)} hours. Sign-off and approval clocks start from receipt, so this delay is already spent.`,
      );
    }
    if (backlog.in_flight) {
      concerns.push(
        `${backlog.in_flight} message(s) are recorded as still being processed. Intake scans inside its transaction, so this means a worker died mid-ingest.`,
      );
    }
    if (backlog.failed) {
      concerns.push(
        `${backlog.failed} message(s) failed intake and hold no usable document. Each needs to be retried or resent.`,
      );
    }
    if (backlog.quarantined) {
      concerns.push(
        `${backlog.quarantined} message(s) carry a quarantined attachment. Nothing was released; a reviewer decides whether the sender is resent to.`,
      );
    }
    if (mailbox) {
      if (!mailbox.reachable) {
        concerns.push(
          'The mailbox cannot be reached. Mail is accumulating there rather than being lost.',
        );
      } else if (!mailbox.authenticated) {
        concerns.push(
          "The mailbox rejected the platform's credentials. Rotate or correct them; no mail is being collected until then.",
        );
      }
      if (mailbox.quota_used_percent !== null && mailbox.quota_used_percent >= 85) {
        concerns.push(
          `The mailbox is ${mailbox.quota_used_percent.toFixed(0)}% full. A full mailbox refuses delivery, and that refusal happens outside this platform.`,
        );
      } else if (mailbox.reachable && !mailbox.quota_supported) {
        concerns.push(
          'The mail server does not report quota, so the platform cannot warn before the mailbox fills.',
        );
      }
    }
    return concerns;
  }

  private operationalState(
    checkpoints: { is_stalled: boolean }[],
    backlog: {
      needs_attention: number;
      in_flight: number;
      oldest_unresolved_age_seconds: number | null;
    },
    mailbox: MailboxReport | null,
  ): string {
    if (checkpoints.length === 0) return 'unknown';
    if (checkpoints.some((checkpoint) => checkpoint.is_stalled)) return 'stalled';
    if (mailbox && !(mailbox.reachable && mailbox.authenticated)) return 'stalled';
    const age = backlog.oldest_unresolved_age_seconds;
    if (
      backlog.needs_attention ||
      backlog.in_flight ||
      (age !== null && age > OLDEST_UNRESOLVED_WARN_SECONDS) ||
      (mailbox !== null && (mailbox.quota_used_percent ?? 0) >= 85)
    ) {
      return 'attention';
    }
    return 'healthy';
  }

  private async probeMailbox(): Promise<MailboxReport> {
    const empty: MailboxReport = {
      reachable: false,
      authenticated: false,
      detail: null,
      quota_supported: false,
      quota_used_kb: null,
      quota_limit_kb: null,
      quota_used_percent: null,
    };
    const host = process.env.FINORA_IMAP_HOST || process.env.IMAP_HOST || '';
    const username = process.env.FINORA_IMAP_USERNAME || process.env.IMAP_USERNAME || '';
    const password = process.env.FINORA_IMAP_PASSWORD || process.env.IMAP_PASSWORD || '';
    const port = Number(process.env.FINORA_IMAP_PORT || process.env.IMAP_PORT || 993);
    if (!host) {
      return { ...empty, detail: 'No mailbox host is configured.' };
    }
    if (!username || !password) {
      return { ...empty, reachable: true, detail: 'No mailbox credentials are configured.' };
    }

    const client = new ImapFlow({
      host,
      port,
      secure: (process.env.FINORA_IMAP_USE_TLS ?? 'true') !== 'false',
      auth: { user: username, pass: password },
      logger: false,
      connectionTimeout: 3000,
    });
    try {
      await client.connect();
      await client.logout();
      return {
        ...empty,
        reachable: true,
        authenticated: true,
        quota_supported: false,
      };
    } catch (error) {
      const refused = error instanceof Error && /auth|login|credentials/i.test(error.message);
      return {
        ...empty,
        reachable: !refused,
        authenticated: false,
        detail: refused
          ? 'The mail server refused the configured credentials.'
          : `${host}:${port} could not be contacted.`,
      };
    }
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
