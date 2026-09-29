import {
  AlertTriangle,
  ArrowLeft,
  Download,
  FileWarning,
  Paperclip,
  ShieldAlert,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import type { AttachmentSummary, MessageDetail } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import {
  INTAKE_SOURCE,
  INTAKE_STATUS,
  SCAN_VERDICT,
  describeRejection,
  formatBytes,
} from '@/features/intake/intake-vocabulary';
import { useAttachmentLink, useMessage } from '@/features/intake/use-intake';

function DefinitionRow({
  term,
  children,
}: {
  term: string;
  children: React.ReactNode;
}) {
  // Stacked, not two columns. These values are addresses and hashes with no
  // spaces to break at, and this panel sits in a narrow sidebar, so a label
  // column leaves too little room and an address ends up split mid-word.
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-subtle)]">
        {term}
      </dt>
      <dd className="m-0 min-w-0 break-words text-[length:var(--text-body-sm)] text-[var(--color-text-strong)]">
        {children}
      </dd>
    </div>
  );
}

function AttachmentRow({ attachment }: { attachment: AttachmentSummary }) {
  const link = useAttachmentLink();
  const verdict = attachment.scan_verdict
    ? SCAN_VERDICT[attachment.scan_verdict]
    : null;

  const open = async () => {
    const signed = await link.mutateAsync(attachment.id);
    // A new tab rather than a same-tab navigation, so the reviewer keeps the
    // message they were reading. `noopener` because the signed URL points at
    // storage and the opened page has no business reaching back into the app.
    window.open(signed.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <li
      className={cn(
        'flex flex-col gap-[var(--space-3)] border-b border-[var(--color-divider)]',
        'px-[var(--space-5)] py-[var(--space-4)] last:border-b-0',
        'sm:flex-row sm:items-start sm:justify-between sm:gap-[var(--space-5)]',
      )}
    >
      <div className="flex min-w-0 items-start gap-[var(--space-3)]">
        {attachment.is_quarantined ? (
          <ShieldAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-[var(--color-danger-600)]"
          />
        ) : attachment.rejection_reason ? (
          <FileWarning
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-[var(--color-warning-600)]"
          />
        ) : (
          <Paperclip
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-[var(--color-text-muted)]"
          />
        )}

        <div className="min-w-0">
          <p className="m-0 truncate font-semibold text-[var(--color-text-strong)]">
            {attachment.filename}
          </p>
          <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
            {attachment.content_type} · {formatBytes(attachment.size_bytes)}
          </p>

          {attachment.rejection_reason ? (
            <p className="mt-[var(--space-2)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-warning-700)]">
              {describeRejection(
                attachment.rejection_reason,
                attachment.rejection_detail,
              )}
            </p>
          ) : verdict ? (
            <p className="mt-[var(--space-2)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {attachment.scan_detail
                ? `${verdict.description} (${attachment.scan_detail})`
                : verdict.description}
            </p>
          ) : (
            <p className="mt-[var(--space-2)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              Not yet scanned. It cannot be opened until a scan has completed.
            </p>
          )}

          {link.error ? (
            <p
              role="alert"
              className="mt-[var(--space-2)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-danger-700)]"
            >
              {link.error instanceof Error
                ? link.error.message
                : 'The document could not be opened.'}
            </p>
          ) : null}

          {/* The content hash is what ties this row to the stored bytes, and is
              what an auditor uses to prove the file has not changed. */}
          <p className="mt-[var(--space-2)] m-0 font-mono text-[length:var(--text-caption)] text-[var(--color-text-subtle)]">
            sha256 {attachment.sha256.slice(0, 16)}…
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-[var(--space-3)]">
        {verdict ? <ToneBadge label={verdict.label} tone={verdict.tone} /> : null}

        {attachment.can_download ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void open()}
            isLoading={link.isPending}
            loadingLabel="Preparing"
          >
            <Download aria-hidden="true" className="size-4" />
            Open
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function Warnings({ message }: { message: MessageDetail }) {
  const notes = [...message.parse_warnings];
  if (message.failure_reason) notes.push(message.failure_reason);

  if (notes.length === 0) return null;

  return (
    <Card className="mb-[var(--space-6)] border-[color-mix(in_srgb,var(--color-warning-600)_38%,white)]">
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-[var(--space-2)]">
            <AlertTriangle
              aria-hidden="true"
              className="size-4 text-[var(--color-warning-600)]"
            />
            This message was only partly understood
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mt-0 mb-[var(--space-3)] text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
          The original was stored exactly as it arrived. These notes describe what
          could not be read from it, so nothing here is a silent gap.
        </p>
        <ul className="m-0 flex list-disc flex-col gap-1 pl-[var(--space-5)]">
          {notes.map((note) => (
            <li
              key={note}
              className="text-[length:var(--text-body-sm)] text-[var(--color-text)]"
            >
              {note}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * One inbound message.
 *
 * The sender is shown as reported, never as verified. Where `Reply-To` disagrees
 * with `From`, both are shown side by side and the disagreement is called out,
 * because that mismatch is the usual shape of a payment-redirection attempt and
 * a reviewer who never sees it cannot catch it.
 */
export function MessageDetailPage() {
  const { messageId } = useParams<{ messageId: string }>();
  const { data: message, isLoading, isError, error } = useMessage(messageId);

  if (isLoading) {
    return (
      <>
        <PageHeader title="Message" purpose="Loading the message." />
        <Card>
          <CardContent>
            <SkeletonText lines={8} />
          </CardContent>
        </Card>
      </>
    );
  }

  if (isError || !message) {
    return (
      <>
        <PageHeader title="Message" purpose="This message could not be opened." />
        <Card className="border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not load this message
            </p>
            <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {error instanceof Error
                ? error.message
                : 'The message could not be found.'}
            </p>
            <div className="mt-[var(--space-4)]">
              <Button variant="secondary" asChild>
                <Link to="/intake">
                  <ArrowLeft aria-hidden="true" className="size-4" />
                  Back to intake
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </>
    );
  }

  const status = INTAKE_STATUS[message.status];
  const replyToDiffers = Boolean(
    message.reply_to_address && message.reply_to_address !== message.from_address,
  );

  return (
    <>
      <PageHeader
        title={message.subject || 'No subject'}
        purpose={status.description}
        actions={
          <Button variant="secondary" asChild>
            <Link to="/intake">
              <ArrowLeft aria-hidden="true" className="size-4" />
              Back to intake
            </Link>
          </Button>
        }
        meta={<ToneBadge label={status.label} tone={status.tone} />}
      />

      <Warnings message={message} />

      {replyToDiffers ? (
        <Card className="mb-[var(--space-6)] border-[color-mix(in_srgb,var(--color-warning-600)_38%,white)]">
          <CardContent className="flex items-start gap-[var(--space-3)]">
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-[var(--color-warning-600)]"
            />
            <div>
              <p className="m-0 font-semibold text-[var(--color-text-strong)]">
                Replies to this message would go to a different address
              </p>
              <p className="mt-1 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                It was sent from{' '}
                <span className="font-mono">{message.from_address}</span> but asks
                for replies at{' '}
                <span className="font-mono">{message.reply_to_address}</span>. Confirm
                the vendor and any bank details against the vendor master before
                acting on this, using a channel you already trust.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-[var(--space-6)] lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-[var(--space-6)]">
          <Card>
            <CardHeader>
              <CardTitle>
                Attachments{' '}
                <span className="font-normal text-[var(--color-text-muted)]">
                  ({message.attachments.length})
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {message.attachments.length === 0 ? (
                <p className="m-0 px-[var(--space-5)] py-[var(--space-6)] text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                  This message had no attachments. If an invoice was expected, ask
                  the sender to resend it with the document attached.
                </p>
              ) : (
                <ul className="m-0 list-none p-0">
                  {message.attachments.map((attachment) => (
                    <AttachmentRow key={attachment.id} attachment={attachment} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Message body</CardTitle>
            </CardHeader>
            <CardContent>
              {message.body_text ? (
                // Rendered as plain text, never as markup. Message content is
                // attacker-controlled and is displayed, never interpreted.
                <pre className="m-0 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words font-[var(--font-mono)] text-[length:var(--text-body-sm)] text-[var(--color-text)]">
                  {message.body_text}
                </pre>
              ) : (
                <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                  The message had no plain-text body.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Provenance</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="m-0 flex flex-col gap-[var(--space-3)]">
              <DefinitionRow term="Arrived by">
                {INTAKE_SOURCE[message.source]}
              </DefinitionRow>
              <DefinitionRow term="From">
                {/* "Reported" is not hedging: the envelope is sender-controlled
                    and the vendor of record is decided against the master. */}
                <span className="font-mono">
                  {message.from_address ?? 'Not stated'}
                </span>
                {message.from_display_name ? (
                  <span className="block text-[var(--color-text-muted)]">
                    {message.from_display_name} (as reported by the sender)
                  </span>
                ) : null}
              </DefinitionRow>
              {message.reply_to_address ? (
                <DefinitionRow term="Reply-To">
                  <span className="font-mono">{message.reply_to_address}</span>
                </DefinitionRow>
              ) : null}
              {message.forwarded_from_address ? (
                <DefinitionRow term="Forwarded from">
                  <span className="font-mono">
                    {message.forwarded_from_address}
                  </span>
                  <span className="block text-[var(--color-text-muted)]">
                    Recovered from the forward. Treat as a hint, not as proof.
                  </span>
                </DefinitionRow>
              ) : null}
              <DefinitionRow term="To">
                <span className="font-mono">
                  {message.to_addresses.join(', ') || 'Not stated'}
                </span>
              </DefinitionRow>
              <DefinitionRow term="Received">
                <time dateTime={message.received_at} data-visual-volatile>
                  {new Date(message.received_at).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </time>
              </DefinitionRow>
              {message.sent_at ? (
                <DefinitionRow term="Sent">
                  <time dateTime={message.sent_at} data-visual-volatile>
                    {new Date(message.sent_at).toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </time>
                </DefinitionRow>
              ) : null}
              <DefinitionRow term="Original size">
                {formatBytes(message.raw_size_bytes)}
              </DefinitionRow>
              <DefinitionRow term="Original hash">
                {/* Volatile for the photograph. A manual upload is wrapped in a
                    message built at the moment it arrives, so this digest is
                    different on every run and would otherwise be the one part
                    of the baseline that can never match. */}
                <span className="font-mono break-all" data-visual-volatile>
                  {message.raw_sha256}
                </span>
              </DefinitionRow>
              {message.imap_folder ? (
                <DefinitionRow term="Mailbox">
                  <span className="font-mono">
                    {message.imap_folder}
                    {message.imap_uid !== null ? ` · UID ${message.imap_uid}` : ''}
                  </span>
                </DefinitionRow>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
