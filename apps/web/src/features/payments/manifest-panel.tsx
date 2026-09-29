import { useState } from 'react';
import { AlertTriangle, Download, FileText } from 'lucide-react';

import type { ManifestOut } from '@finora/shared-types';

import { API_PREFIX } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonText } from '@/components/ui/skeleton';

/**
 * The manifest: before it goes, the file that will go; after, the evidence of
 * what went.
 *
 * It is fetched rather than built here. The digest recorded against a submitted
 * package is the hash of the server's file, and a manifest composed in the
 * browser would be a different file with a different hash — which is to say, no
 * evidence at all.
 *
 * On a submitted package the panel checks the file it can rebuild now against
 * the digest recorded then. Agreement is stated quietly. Disagreement is not a
 * display problem: it means something the manifest is built from has changed
 * since the payment went, and the package can no longer show what was sent.
 */
export interface ManifestPanelProps {
  packageId: string;
  manifest: ManifestOut | undefined;
  isLoading: boolean;
  /** Why there is no manifest yet, when the server declined to build one. */
  unavailable: string | undefined;
  isSubmitted: boolean;
}

export function ManifestPanel({
  packageId,
  manifest,
  isLoading,
  unavailable,
  isSubmitted,
}: ManifestPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const rows = manifest ? manifest.content.trimEnd().split('\n') : [];
  const preview = expanded ? rows : rows.slice(0, 8);
  const hidden = rows.length - preview.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-[var(--space-2)]">
            <FileText aria-hidden="true" className="size-4 text-[var(--color-text-muted)]" />
            {isSubmitted ? 'What was sent' : 'The manifest'}
          </span>
        </CardTitle>
        <CardDescription>
          {isSubmitted
            ? 'The file that went to the bank, and the fingerprint recorded at the time.'
            : 'The file the bank will be given. One row per invoice, in a fixed order, so the same package always produces the same file.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <SkeletonText lines={5} />
        ) : unavailable ? (
          <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
            {unavailable}
          </p>
        ) : !manifest ? (
          <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
            There is nothing to show yet.
          </p>
        ) : (
          <>
            {manifest.matches_submitted === false ? (
              <div className="mb-[var(--space-4)] rounded-[var(--radius-md)] border border-[var(--color-danger-600)] bg-[var(--color-danger-50)] p-[var(--space-4)]">
                <p className="m-0 flex items-start gap-[var(--space-2)] font-semibold text-[var(--color-danger-700)]">
                  <AlertTriangle aria-hidden="true" className="mt-px size-4 shrink-0" />
                  This no longer matches what was sent
                </p>
                <p className="mt-[var(--space-2)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text)]">
                  The file rebuilt now hashes to something other than the fingerprint recorded at
                  submission. The payment itself is unaffected, but this package can no longer
                  demonstrate what the bank was given. Raise it with whoever administers the
                  system rather than resubmitting.
                </p>
              </div>
            ) : null}

            <pre
              className={[
                'm-0 overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--color-border)]',
                'bg-[var(--color-surface-subtle)] p-[var(--space-3)]',
                'font-mono text-[length:var(--text-caption)] leading-relaxed text-[var(--color-text)]',
              ].join(' ')}
            >
              {preview.join('\n')}
            </pre>

            {hidden > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-[var(--space-2)]"
                onClick={() => setExpanded(true)}
              >
                Show the other {hidden} {hidden === 1 ? 'row' : 'rows'}
              </Button>
            ) : null}

            <dl className="mt-[var(--space-4)] m-0 flex flex-col gap-[var(--space-2)]">
              <div>
                <dt className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
                  Invoices listed
                </dt>
                <dd className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text)]">
                  {/* The file has more lines than this: a header, and a control
                      total per currency after the invoices. Counting those in
                      would make the figure disagree with the number of payments
                      the bank is being asked to make. */}
                  {manifest.line_count}
                </dd>
              </div>
              <div>
                <dt className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
                  {isSubmitted ? 'Fingerprint recorded at submission' : 'Fingerprint (SHA-256)'}
                </dt>
                <dd className="m-0 font-mono text-[length:var(--text-caption)] break-all text-[var(--color-text)]">
                  {manifest.submitted_digest ?? manifest.digest}
                </dd>
              </div>
            </dl>

            {/* An ordinary link, not a fetch. The session is a same-origin
                cookie, so the browser downloads the file with the filename and
                the digest header the server set, and nothing here has to
                reassemble a blob to do it. */}
            <Button variant="secondary" className="mt-[var(--space-4)]" asChild>
              <a
                href={`${API_PREFIX}/payment-packages/${packageId}/manifest.csv`}
                download={manifest.filename}
              >
                <Download aria-hidden="true" className="size-4" />
                Download the file
              </a>
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
