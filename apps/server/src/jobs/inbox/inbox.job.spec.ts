import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { s3Client } from '../../documents/s3.client.js';
import { auditMock, compile, provideAudit, providePrisma } from '../../testing/fixtures.js';
import { InboxJob } from './inbox.job.js';

const lock = vi.hoisted(() => ({ release: vi.fn() }));
const client = vi.hoisted(() => ({
  connect: vi.fn(),
  getMailboxLock: vi.fn(async () => lock),
  mailboxCreate: vi.fn(async () => undefined),
  search: vi.fn(async () => [8]),
  fetchOne: vi.fn(),
  messageMove: vi.fn(async () => true),
  logout: vi.fn(async () => undefined),
  mailbox: { uidValidity: 4n },
}));

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn(function ImapFlow() {
    return client;
  }),
}));

vi.mock('mailparser', () => ({
  simpleParser: vi.fn(),
}));

vi.mock('../../documents/s3.client.js', () => ({
  s3Client: { send: vi.fn(async () => ({})) },
  resolveDocumentsBucket: () => 'finora-docs',
}));

function parsedMail(overrides: Record<string, unknown> = {}) {
  return {
    messageId: '<abc@acme.test>',
    subject: 'Invoice for October',
    text: 'Please pay this.',
    date: new Date('2026-10-12T14:00:00.000Z'),
    from: { value: [{ address: 'ada@acme.test', name: 'Ada' }] },
    to: { value: [{ address: 'intake@finora.test' }] },
    cc: undefined,
    references: undefined,
    inReplyTo: undefined,
    attachments: [],
    headers: new Map<string, string>(),
    ...overrides,
  };
}

describe('InboxJob', () => {
  const prisma = {
    mailboxCheckpoint: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    inboundMessage: { findUnique: vi.fn(), create: vi.fn() },
    vendorCheckIn: { findMany: vi.fn(), update: vi.fn() },
  };
  const audit = auditMock();
  const previous = {
    host: process.env.FINORA_IMAP_HOST,
    user: process.env.FINORA_IMAP_USERNAME,
    password: process.env.FINORA_IMAP_PASSWORD,
    imapHost: process.env.IMAP_HOST,
    imapUser: process.env.IMAP_USERNAME,
    imapPassword: process.env.IMAP_PASSWORD,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FINORA_IMAP_HOST = 'imap.example.test';
    process.env.FINORA_IMAP_USERNAME = 'finora';
    process.env.FINORA_IMAP_PASSWORD = 'secret';
    prisma.mailboxCheckpoint.findUnique.mockResolvedValue(null);
    prisma.mailboxCheckpoint.upsert.mockResolvedValue({});
    prisma.inboundMessage.findUnique.mockResolvedValue(null);
    prisma.inboundMessage.create.mockResolvedValue({ id: 'msg-1', subject: 'Invoice for October' });
    prisma.vendorCheckIn.findMany.mockResolvedValue([]);
    client.mailbox.uidValidity = 4n;
    client.search.mockResolvedValue([8]);
    client.fetchOne.mockResolvedValue({ source: Buffer.from('raw-mail') });
    vi.mocked(simpleParser).mockResolvedValue(parsedMail() as never);
  });

  afterEach(() => {
    process.env.FINORA_IMAP_HOST = previous.host;
    process.env.FINORA_IMAP_USERNAME = previous.user;
    process.env.FINORA_IMAP_PASSWORD = previous.password;
    process.env.IMAP_HOST = previous.imapHost;
    process.env.IMAP_USERNAME = previous.imapUser;
    process.env.IMAP_PASSWORD = previous.imapPassword;
  });

  async function job() {
    return compile(InboxJob, [providePrisma(prisma), provideAudit(audit)]);
  }

  it('does nothing when the mailbox is not configured', async () => {
    delete process.env.FINORA_IMAP_HOST;
    delete process.env.FINORA_IMAP_USERNAME;
    delete process.env.FINORA_IMAP_PASSWORD;
    delete process.env.IMAP_HOST;
    delete process.env.IMAP_USERNAME;
    delete process.env.IMAP_PASSWORD;

    await expect((await job()).run()).resolves.toEqual({ skipped: true, examined: 0, ingested: 0 });
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('stores a new message and its attachment, then advances the checkpoint and moves the mail', async () => {
    vi.mocked(simpleParser).mockResolvedValue(
      parsedMail({
        attachments: [
          {
            filename: 'invoice.pdf',
            contentType: 'application/pdf',
            content: Buffer.from('pdf-bytes'),
          },
        ],
      }) as never,
    );

    await expect((await job()).run()).resolves.toEqual({ skipped: false, examined: 1, ingested: 1 });

    expect(s3Client.send).toHaveBeenCalledTimes(2);
    expect(prisma.inboundMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'imap',
          idempotencyKey: 'message-id:abc@acme.test',
          imapUid: 8n,
          subject: 'Invoice for October',
          documents: {
            create: [
              expect.objectContaining({
                filename: 'invoice.pdf',
                contentType: 'application/pdf',
                kind: 'attachment',
                status: 'ready',
              }),
            ],
          },
        }),
      }),
    );
    expect(prisma.mailboxCheckpoint.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ folder: 'INBOX', lastSeenUid: 8n, uidValidity: 4n }),
      }),
    );
    expect(client.messageMove).toHaveBeenCalledWith('8', 'Finora/Processed', { uid: true });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'message_ingested', subjectId: 'msg-1' }),
    );
  });

  it('recognises a duplicate, moves it, and does not store it again', async () => {
    prisma.inboundMessage.findUnique.mockResolvedValue({ id: 'msg-existing' });

    await expect((await job()).run()).resolves.toEqual({ skipped: false, examined: 1, ingested: 0 });

    expect(prisma.inboundMessage.create).not.toHaveBeenCalled();
    expect(s3Client.send).not.toHaveBeenCalled();
    expect(prisma.mailboxCheckpoint.upsert).toHaveBeenCalled();
    expect(client.messageMove).toHaveBeenCalled();
  });

  it('does not advance the checkpoint when the fetch fails', async () => {
    client.fetchOne.mockRejectedValue(new Error('connection reset'));

    await expect((await job()).run()).resolves.toEqual({ skipped: false, examined: 1, ingested: 0 });
    expect(prisma.mailboxCheckpoint.upsert).not.toHaveBeenCalled();
    expect(client.messageMove).not.toHaveBeenCalled();
  });

  it('advances past a message that vanished between search and fetch', async () => {
    client.fetchOne.mockResolvedValue(false);

    await (await job()).run();

    expect(prisma.inboundMessage.create).not.toHaveBeenCalled();
    expect(prisma.mailboxCheckpoint.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ lastSeenUid: 8n }) }),
    );
  });

  it('resets the checkpoint when the mailbox UIDVALIDITY changes', async () => {
    prisma.mailboxCheckpoint.findUnique.mockResolvedValue({
      id: 'cp-1',
      folder: 'INBOX',
      uidValidity: 1n,
      lastSeenUid: 40n,
    });
    prisma.mailboxCheckpoint.update.mockResolvedValue({
      id: 'cp-1',
      uidValidity: 4n,
      lastSeenUid: 0n,
    });

    await (await job()).run();

    expect(prisma.mailboxCheckpoint.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          uidValidity: 4n,
          lastSeenUid: 0n,
          lastResetReason: 'uidvalidity_changed',
        }),
      }),
    );
    expect(client.search).toHaveBeenCalledWith({ uid: '1:*' }, { uid: true });
  });

  it('records a vendor reply that carries the check-in tag and ignores an automatic reply', async () => {
    vi.mocked(simpleParser).mockResolvedValue(
      parsedMail({
        subject: 'Re: payment [tag-99]',
        text: 'Yes, we received it.',
        headers: new Map(),
      }) as never,
    );
    prisma.vendorCheckIn.findMany.mockResolvedValue([
      { id: 'chk-1', correlationTag: 'tag-99', reference: 'VCI-1' },
    ]);

    await (await job()).run();

    expect(prisma.vendorCheckIn.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'chk-1' },
        data: expect.objectContaining({
          claim: 'Yes, we received it.',
          claimChannel: 'email_reply',
          respondentName: 'Ada',
        }),
      }),
    );

    vi.mocked(simpleParser).mockResolvedValue(
      parsedMail({
        subject: 'Re: payment [tag-99]',
        headers: new Map([['auto-submitted', 'auto-replied']]),
      }) as never,
    );
    prisma.vendorCheckIn.update.mockClear();
    await (await job()).run();
    expect(prisma.vendorCheckIn.update).not.toHaveBeenCalled();
  });

  it('keeps the stored message when the mailbox move fails', async () => {
    client.messageMove.mockRejectedValue(new Error('no MOVE'));

    await expect((await job()).run()).resolves.toEqual({ skipped: false, examined: 1, ingested: 1 });
    expect(prisma.inboundMessage.create).toHaveBeenCalled();
    expect(prisma.mailboxCheckpoint.upsert).toHaveBeenCalled();
  });

  it('does not advance when the message cannot be parsed', async () => {
    vi.mocked(simpleParser).mockRejectedValue(new Error('bad mime'));

    await expect((await job()).run()).resolves.toEqual({ skipped: false, examined: 1, ingested: 0 });
    expect(prisma.mailboxCheckpoint.upsert).not.toHaveBeenCalled();
  });
});
