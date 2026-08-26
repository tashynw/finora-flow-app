import { useState } from 'react';
import { ScrollText, ShieldCheck } from 'lucide-react';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import {
  PAGE_SIZE,
  useAuditEntries,
  useVerifyAuditChain,
  type AuditEntryOut,
} from '@/features/audit/use-audit';

/**
 * The append-only audit trail, read by people who must not change it.
 *
 * Oldest first so the chain reads in the order it was written. Verification is
 * a separate act: looking at rows is not the same as proving nobody rewrote
 * them, and an auditor who only scrolls is not verifying anything.
 */

const SUBJECT_TYPES = [
  { value: '', label: 'Any subject' },
  { value: 'estimate', label: 'Estimate' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'purchase_order', label: 'Purchase order' },
  { value: 'payment_package', label: 'Payment package' },
  { value: 'vendor_check_in', label: 'Vendor check-in' },
  { value: 'credit_card_period', label: 'Credit-card period' },
  { value: 'accrual_period', label: 'Accrual period' },
  { value: 'document', label: 'Document' },
  { value: 'session', label: 'Session' },
] as const;

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function shortHash(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function EntryRow({ entry, open, onToggle }: {
  entry: AuditEntryOut;
  open: boolean;
  onToggle: () => void;
}) {
  const detailKeys = Object.keys(entry.detail ?? {});

  return (
    <li className="border-b border-[var(--color-divider)] last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          'flex w-full flex-col gap-[var(--space-1)] px-[var(--space-5)] py-[var(--space-4)] text-left',
          'hover:bg-[var(--color-surface-subtle)]',
          'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-focus-ring)]',
        )}
      >
        <p className="m-0 flex flex-wrap items-baseline gap-x-[var(--space-2)]">
          <span className="tabular text-[var(--text-caption)] text-[var(--color-text-subtle)]">
            #{entry.sequence}
          </span>
          <span className="font-semibold text-[var(--color-text-strong)]">
            {entry.action.replaceAll('_', ' ')}
          </span>
          <span className="text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
            {entry.subject_type}
            {entry.subject_id ? ` · ${entry.subject_id.slice(0, 8)}` : ''}
          </span>
        </p>
        <p className="m-0 flex flex-wrap gap-x-[var(--space-3)] text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
          <span>{entry.actor_label}</span>
          <span data-visual-volatile>{formatWhen(entry.occurred_at)}</span>
          <span className="font-mono text-[var(--text-caption)]" title={entry.entry_hash}>
            {shortHash(entry.entry_hash)}
          </span>
        </p>
      </button>
      {open ? (
        <div className="border-t border-[var(--color-divider)] bg-[var(--color-surface-subtle)] px-[var(--space-5)] py-[var(--space-4)]">
          <dl className="m-0 grid gap-[var(--space-3)] text-[var(--text-body-sm)] sm:grid-cols-2">
            <div>
              <dt className="m-0 text-[var(--color-text-subtle)]">Actor</dt>
              <dd className="m-0 font-medium">
                {entry.actor_label} ({entry.actor_type})
              </dd>
            </div>
            <div>
              <dt className="m-0 text-[var(--color-text-subtle)]">Subject</dt>
              <dd className="m-0 font-medium break-all">
                {entry.subject_type}
                {entry.subject_id ? ` / ${entry.subject_id}` : ''}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="m-0 text-[var(--color-text-subtle)]">Entry hash</dt>
              <dd className="m-0 break-all font-mono text-[var(--text-caption)]">
                {entry.entry_hash}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="m-0 text-[var(--color-text-subtle)]">Previous hash</dt>
              <dd className="m-0 break-all font-mono text-[var(--text-caption)]">
                {entry.previous_hash}
              </dd>
            </div>
            {detailKeys.length > 0 ? (
              <div className="sm:col-span-2">
                <dt className="m-0 text-[var(--color-text-subtle)]">Detail</dt>
                <dd className="m-0">
                  <pre className="m-0 overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] p-[var(--space-3)] font-mono text-[var(--text-caption)]">
                    {JSON.stringify(entry.detail, null, 2)}
                  </pre>
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
    </li>
  );
}

export function AuditTrailPage() {
  const [action, setAction] = useState('');
  const [subjectType, setSubjectType] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<number | null>(null);
  const [startSequence, setStartSequence] = useState('1');
  const [verifyLimit, setVerifyLimit] = useState('1000');

  const filters = {
    action: action.trim() || undefined,
    subject_type: subjectType || undefined,
  };

  const { data, isLoading, isError, error } = useAuditEntries(filters, page);
  const verify = useVerifyAuditChain();

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-[var(--space-6)]">
      <PageHeader
        title="Audit trail"
        purpose="Every significant action, in the order it happened, with a hash chain so rewriting history is detectable. Looking is allowed; changing is not."
      />

      <Card>
        <CardHeader>
          <CardTitle as="h2" className="flex items-center gap-2">
            <ShieldCheck
              aria-hidden="true"
              className="size-[18px] text-[var(--color-primary-600)]"
            />
            Verify a segment
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-[var(--space-4)]">
          <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
            Check that each entry still commits to its predecessor. A mature trail
            is verified in ranges; neighbouring ranges join because each carries
            the previous hash.
          </p>
          <div className="flex flex-wrap items-end gap-[var(--space-3)]">
            <Field label="From sequence">
              {({ inputId, describedBy, invalid }) => (
                <Input
                  id={inputId}
                  type="number"
                  min={1}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={startSequence}
                  onChange={(event) => setStartSequence(event.target.value)}
                  className="w-28"
                />
              )}
            </Field>
            <Field label="Entries to check">
              {({ inputId, describedBy, invalid }) => (
                <Input
                  id={inputId}
                  type="number"
                  min={1}
                  max={10000}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={verifyLimit}
                  onChange={(event) => setVerifyLimit(event.target.value)}
                  className="w-36"
                />
              )}
            </Field>
            <Button
              type="button"
              disabled={verify.isPending}
              onClick={() =>
                verify.mutate({
                  start_sequence: Math.max(1, Number.parseInt(startSequence, 10) || 1),
                  limit: Math.min(
                    10_000,
                    Math.max(1, Number.parseInt(verifyLimit, 10) || 1000),
                  ),
                })
              }
            >
              {verify.isPending ? 'Checking…' : 'Verify chain'}
            </Button>
          </div>
          {verify.isError ? (
            <p role="alert" className="m-0 text-[var(--color-danger-700)]">
              {errorMessage(verify.error) ?? 'Verification did not complete.'}
            </p>
          ) : null}
          {verify.data ? (
            <div className="flex flex-wrap items-center gap-[var(--space-3)]">
              <ToneBadge
                tone={verify.data.ok ? 'success' : 'danger'}
                label={verify.data.ok ? 'Intact' : 'Broken'}
              />
              <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                {verify.data.message}
                {verify.data.first_bad_sequence != null
                  ? ` First problem at #${verify.data.first_bad_sequence}.`
                  : ''}
                {verify.data.reason ? ` ${verify.data.reason}` : ''}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-end gap-[var(--space-3)]">
        <Field label="Action">
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              placeholder="e.g. export_generated"
              value={action}
              onChange={(event) => {
                setAction(event.target.value);
                setPage(1);
              }}
              className="min-w-[14rem]"
            />
          )}
        </Field>
        <Field label="Subject type">
          {({ inputId, describedBy, invalid }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              value={subjectType}
              onChange={(event) => {
                setSubjectType(event.target.value);
                setPage(1);
              }}
            >
              {SUBJECT_TYPES.map((option) => (
                <option key={option.value || 'any'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      {isLoading ? (
        <SkeletonText lines={8} />
      ) : isError ? (
        <p role="alert" className="m-0 text-[var(--color-danger-700)]">
          {errorMessage(error) ?? 'The audit trail could not be loaded.'}
        </p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="No entries match"
          explanation="Nothing in the trail matches these filters, or the trail is empty."
          nextStep="Clear the action filter or choose Any subject to see the full chain."
        />
      ) : (
        <Card className="surface-card overflow-hidden">
          <CardContent className="p-0">
            <ul className="m-0 list-none p-0">
              {items.map((entry) => (
                <EntryRow
                  key={entry.sequence}
                  entry={entry}
                  open={openId === entry.sequence}
                  onToggle={() =>
                    setOpenId((current) =>
                      current === entry.sequence ? null : entry.sequence,
                    )
                  }
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between gap-[var(--space-3)]">
          <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
            {total} entries · page {page} of {pages}
          </p>
          <div className="flex gap-[var(--space-2)]">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((current) => current - 1)}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={page >= pages}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
