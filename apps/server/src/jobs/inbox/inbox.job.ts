import { createHash } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { AuditService } from '../../common/audit.service.js';
import { resolveDocumentsBucket, s3Client } from '../../documents/s3.client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const BATCH_SIZE = 25;

type ImapConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
  secure: boolean;
  inbox: string;
  processed: string;
};

function imapConfig(): ImapConfig | null {
  const host = process.env.FINORA_IMAP_HOST || process.env.IMAP_HOST || '';
  const username = process.env.FINORA_IMAP_USERNAME || process.env.IMAP_USERNAME || '';
  const password = process.env.FINORA_IMAP_PASSWORD || process.env.IMAP_PASSWORD || '';
  if (!host || !username || !password) return null;
  const port = Number(process.env.FINORA_IMAP_PORT || process.env.IMAP_PORT || 993);
  const useTls = (process.env.FINORA_IMAP_USE_TLS ?? 'true') !== 'false';
  return {
    host,
    port,
    username,
    password,
    secure: useTls,
    inbox: process.env.FINORA_IMAP_FOLDER_INBOX || 'INBOX',
    processed: process.env.FINORA_IMAP_FOLDER_PROCESSED || 'Finora/Processed',
  };
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Highest UID already assigned in the mailbox (UIDNEXT - 1). */
function latestUid(uidNext: number | bigint | undefined): bigint {
  const next = BigInt(uidNext ?? 1);
  return next > 1n ? next - 1n : 0n;
}

function addressList(value: AddressObject | AddressObject[] | undefined): string[] {
  const objects = value == null ? [] : Array.isArray(value) ? value : [value];
  return objects.flatMap((item) => item.value.map((entry) => entry.address).filter((address): address is string => Boolean(address)));
}

@Injectable()
export class InboxJob {
  private readonly logger = new Logger(InboxJob.name);
  private primedThisProcess = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async run() {
    const config = imapConfig();
    if (!config) {
      this.logger.log('Inbox poll skipped: IMAP host, username, and password are not set.');
      return { skipped: true, examined: 0, ingested: 0 };
    }

    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.username, pass: config.password },
      logger: false,
    });

    let examined = 0;
    let ingested = 0;
    await client.connect();
    const lock = await client.getMailboxLock(config.inbox);
    try {
      await client.mailboxCreate(config.processed).catch(() => undefined);
      const mailbox = client.mailbox;
      if (!mailbox) {
        throw new Error('The inbox could not be selected.');
      }
      const uidValidity = BigInt(mailbox.uidValidity);
      let checkpoint = await this.prisma.mailboxCheckpoint.findUnique({
        where: { folder: config.inbox },
      });

      if (checkpoint && checkpoint.uidValidity !== uidValidity) {
        this.logger.warn(`IMAP UIDVALIDITY changed for ${config.inbox}. Checkpoint reset.`);
        const skipTo = latestUid(mailbox.uidNext);
        checkpoint = await this.prisma.mailboxCheckpoint.update({
          where: { id: checkpoint.id },
          data: {
            uidValidity,
            lastSeenUid: skipTo,
            lastResetAt: new Date(),
            lastResetReason: 'uidvalidity_changed',
            lastPolledAt: new Date(),
          },
        });
        this.logger.log(
          `Inbox checkpoint reset at UID ${skipTo}; older messages will not be ingested.`,
        );
        return { skipped: false, examined: 0, ingested: 0 };
      }

      const lastSeen = checkpoint?.lastSeenUid ?? 0n;
      // Each Nest process skips whatever is already in the mailbox once, then
      // only ingests mail that arrives after that prime.
      if (!this.primedThisProcess) {
        this.primedThisProcess = true;
        const skipTo = latestUid(mailbox.uidNext);
        if (skipTo >= lastSeen) {
          await this.advance(config.inbox, uidValidity, skipTo);
          this.logger.log(
            `Inbox primed at UID ${skipTo}; only messages arriving after this will be ingested.`,
          );
          return { skipped: false, examined: 0, ingested: 0 };
        }
      }

      const found = await client.search({ uid: `${(lastSeen + 1n).toString()}:*` }, { uid: true });
      const uids = (found || []).slice(0, BATCH_SIZE);
      examined = uids.length;

      for (const uid of uids) {
        const stored = await this.ingestOne(client, config, uid, uidValidity);
        if (stored) ingested += 1;
      }
    } finally {
      lock.release();
      await client.logout().catch(() => undefined);
    }

    this.logger.log(`Inbox poll examined ${examined}, ingested ${ingested}.`);
    return { skipped: false, examined, ingested };
  }

  private async ingestOne(
    client: ImapFlow,
    config: ImapConfig,
    uid: number,
    uidValidity: bigint,
  ): Promise<boolean> {
    let downloaded;
    try {
      downloaded = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
    } catch (error) {
      this.logger.warn(`IMAP fetch failed for UID ${uid}: ${error instanceof Error ? error.message : error}`);
      return false;
    }
    if (!downloaded || !downloaded.source) {
      await this.advance(config.inbox, uidValidity, BigInt(uid));
      return false;
    }

    const raw = Buffer.from(downloaded.source);
    try {
      const parsed = await simpleParser(raw);
      const attachments = (parsed.attachments ?? []).filter(
        (attachment) => attachment.content?.length,
      );
      if (attachments.length === 0) {
        await this.advance(config.inbox, uidValidity, BigInt(uid));
        this.logger.log(`Skipped UID ${uid}: no attachments.`);
        return false;
      }
      const rawHash = sha256(raw);
      const messageId = parsed.messageId?.replace(/^<|>$/g, '') || null;
      const idempotencyKey = messageId ? `message-id:${messageId}` : `sha256:${rawHash}`;
      const existing = await this.prisma.inboundMessage.findUnique({ where: { idempotencyKey } });
      if (!existing) {
        await this.storeMessage(parsed, raw, rawHash, idempotencyKey, messageId, config.inbox, uid, uidValidity);
      }
      await this.advance(config.inbox, uidValidity, BigInt(uid));
      await client.messageMove(String(uid), config.processed, { uid: true }).catch((error: unknown) => {
        this.logger.warn(
          `Stored UID ${uid} but could not move it: ${error instanceof Error ? error.message : error}`,
        );
      });
      return !existing;
    } catch (error) {
      this.logger.error(`IMAP ingest failed for UID ${uid}`, error instanceof Error ? error.stack : String(error));
      return false;
    }
  }

  private async storeMessage(
    parsed: ParsedMail,
    raw: Buffer,
    rawHash: string,
    idempotencyKey: string,
    messageId: string | null,
    folder: string,
    uid: number,
    uidValidity: bigint,
  ) {
    const bucket = resolveDocumentsBucket();
    const rawKey = `raw/${rawHash}.eml`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: rawKey,
        Body: raw,
        ContentType: 'message/rfc822',
      }),
    );

    const documents = [];
    for (const attachment of parsed.attachments) {
      if (!attachment.content?.length) continue;
      const bytes = Buffer.from(attachment.content);
      const hash = sha256(bytes);
      const filename = attachment.filename || 'attachment';
      const key = `documents/${hash}`;
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: attachment.contentType || 'application/octet-stream',
        }),
      );
      documents.push({
        filename,
        contentType: attachment.contentType || 'application/octet-stream',
        sizeBytes: BigInt(bytes.length),
        sha256: hash,
        key,
        bucket,
        kind: 'attachment',
        status: 'ready',
      });
    }

    const toAddresses = addressList(parsed.to);
    const message = await this.prisma.inboundMessage.create({
      data: {
        source: 'imap',
        status: 'ready',
        idempotencyKey,
        rawSha256: rawHash,
        rawObjectKey: rawKey,
        rawSizeBytes: BigInt(raw.length),
        imapFolder: folder,
        imapUid: BigInt(uid),
        imapUidValidity: uidValidity,
        messageId,
        subject: parsed.subject || '(no subject)',
        fromAddress: parsed.from?.value[0]?.address ?? null,
        fromDisplayName: parsed.from?.value[0]?.name ?? null,
        toAddresses,
        ccAddresses: addressList(parsed.cc),
        deliveredToAddresses: [],
        references: parsed.references
          ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
          : [],
        inReplyTo: parsed.inReplyTo || null,
        sentAt: parsed.date ?? null,
        receivedAt: new Date(),
        bodyText: parsed.text || '',
        parseWarnings: [],
        documents: { create: documents },
      },
    });

    await this.recordVendorReply(message.id, parsed, toAddresses);
    await this.audit.append({
      action: 'message_ingested',
      actorType: 'service',
      actorLabel: 'imap worker',
      subjectType: 'inbound_message',
      subjectId: message.id,
      detail: { source: 'imap', attachments: documents.length, subject: message.subject },
    });
  }

  private async recordVendorReply(messageId: string, parsed: ParsedMail, toAddresses: string[]) {
    const auto = parsed.headers.get('auto-submitted');
    const autoValue = Array.isArray(auto) ? auto.join(' ') : String(auto ?? '');
    if (autoValue && autoValue.toLowerCase() !== 'no') return;

    const haystack = [parsed.subject, parsed.text, ...toAddresses].filter(Boolean).join('\n').toLowerCase();
    const open = await this.prisma.vendorCheckIn.findMany({
      where: { answeredAt: null, reviewedAt: null },
      select: { id: true, correlationTag: true, reference: true },
    });
    const match = open.find((row) => haystack.includes(row.correlationTag.toLowerCase()));
    if (!match) return;

    const respondentName = parsed.from?.value[0]?.name || parsed.from?.value[0]?.address || 'Supplier';
    await this.prisma.vendorCheckIn.update({
      where: { id: match.id },
      data: {
        claim: (parsed.text || parsed.subject || 'Replied by email').slice(0, 2000),
        claimChannel: 'email_reply',
        respondentName,
        respondentNote: `Recorded from inbound message ${messageId}.`,
        answeredAt: new Date(),
        version: { increment: 1 },
      },
    });
    await this.audit.append({
      action: 'vendor_claim_recorded',
      actorType: 'vendor',
      actorLabel: respondentName,
      subjectType: 'vendor_check_in',
      subjectId: match.id,
      detail: { channel: 'email_reply', reference: match.reference },
    });
  }

  private async advance(folder: string, uidValidity: bigint, uid: bigint) {
    await this.prisma.mailboxCheckpoint.upsert({
      where: { folder },
      create: {
        folder,
        uidValidity,
        lastSeenUid: uid,
        lastPolledAt: new Date(),
      },
      update: {
        uidValidity,
        lastSeenUid: uid,
        lastPolledAt: new Date(),
      },
    });
  }
}
