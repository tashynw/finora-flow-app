import { useState } from 'react';
import { ScrollText, Search, ShieldCheck } from 'lucide-react';

import { errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import {
  PAGE_SIZE,
  useAuditEntries,
  useVerifyAuditChain,
  type AuditEntryOut,
  type AuditVerifyResult,
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

function VerifyOutcome({ result }: { result: AuditVerifyResult }) {
  return (
    <div className="flex flex-wrap items-center gap-[var(--space-3)]">
      <ToneBadge tone={result.ok ? 'success' : 'danger'} label={result.ok ? 'Intact' : 'Broken'} />
      <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
        {result.message}
        {result.first_bad_sequence != null
          ? ` First problem at #${result.first_bad_sequence}.`
          : ''}
        {result.reason ? ` ${result.reason}` : ''}
      </p>
    </div>
  );
}

function EntryDetail({ entry }: { entry: AuditEntryOut }) {
  const detailKeys = Object.keys(entry.detail ?? {});

  return (
    <dl className="m-0 grid gap-[var(--space-3)] text-[length:var(--text-body-sm)] sm:grid-cols-2">
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
        <dt className="m-0 text-[var(--color-text-subtle)]">Occurred</dt>
        <dd className="m-0 font-medium tabular">{formatWhen(entry.occurred_at)}</dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="m-0 text-[var(--color-text-subtle)]">Entry hash</dt>
        <dd className="m-0 break-all font-mono text-[length:var(--text-caption)]">
          {entry.entry_hash}
        </dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="m-0 text-[var(--color-text-subtle)]">Previous hash</dt>
        <dd className="m-0 break-all font-mono text-[length:var(--text-caption)]">
          {entry.previous_hash}
        </dd>
      </div>
      {detailKeys.length > 0 ? (
        <div className="sm:col-span-2">
          <dt className="m-0 text-[var(--color-text-subtle)]">Detail</dt>
          <dd className="m-0">
            <pre className="m-0 overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-[var(--space-3)] font-mono text-[length:var(--text-caption)]">
              {JSON.stringify(entry.detail, null, 2)}
            </pre>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function entryColumns(onOpen: (entry: AuditEntryOut) => void): Column<AuditEntryOut>[] {
  return [
    {
      key: 'time',
      header: 'Time',
      width: 'w-52',
      cell: (entry) => (
        <span className="flex flex-col">
          <span data-visual-volatile className="tabular whitespace-nowrap font-semibold text-[var(--color-text-strong)]">
            {formatWhen(entry.occurred_at)}
          </span>
          <span className="tabular text-[11px] text-[var(--color-text-subtle)]">
            #{entry.sequence}
          </span>
        </span>
      ),
    },
    {
      key: 'actor',
      header: 'Actor',
      width: 'w-48',
      cell: (entry) => (
        <span className="flex flex-col">
          <span>{entry.actor_label}</span>
          <span className="text-[11px] text-[var(--color-text-subtle)]">{entry.actor_type}</span>
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      cell: (entry) => <span className="font-mono text-[12px]">{entry.action}</span>,
    },
    {
      key: 'record',
      header: 'Record',
      width: 'w-52',
      hideBelow: 'md',
      cell: (entry) => (
        <span>
          {entry.subject_type.replaceAll('_', ' ')}
          {entry.subject_id ? (
            <span className="tabular text-[var(--color-text-subtle)]">
              {' '}
              · {entry.subject_id.slice(0, 8)}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'hash',
      header: 'Hash',
      width: 'w-40',
      hideBelow: 'xl',
      cell: (entry) => (
        <span className="whitespace-nowrap font-mono text-[11px] text-[var(--color-text-subtle)]" title={entry.entry_hash}>
          {shortHash(entry.entry_hash)}
        </span>
      ),
    },
    {
      key: 'open',
      header: <span className="sr-only">Details</span>,
      width: 'w-24',
      align: 'right',
      cell: (entry) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onOpen(entry)}
          aria-label={`Details of entry ${entry.sequence}`}
        >
          Details
        </Button>
      ),
    },
  ];
}

export function AuditTrailPage() {
  const [action, setAction] = useState('');
  const [subjectType, setSubjectType] = useState('');
  const [page, setPage] = useState(1);
  const [openEntry, setOpenEntry] = useState<AuditEntryOut | null>(null);
  const [verifyOpen, setVerifyOpen] = useState(false);
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
    <>
      <PageHeader
        title="Audit trail"
        purpose="Append-only record of decisions and configuration changes, hash-chained so rewriting history is detectable."
        toolbar={
          <div className="flex flex-col gap-[var(--space-3)] md:flex-row md:items-center">
            <div className="relative md:w-64">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-[var(--space-3)] size-4 -translate-y-1/2 text-[var(--color-text-subtle)]"
              />
              <Input
                type="search"
                aria-label="Action"
                placeholder="Action, e.g. export_generated"
                value={action}
                onChange={(event) => {
                  setAction(event.target.value);
                  setPage(1);
                }}
                className="h-9 pl-9 text-[12px]"
              />
            </div>
            <Select
              aria-label="Subject type"
              value={subjectType}
              onChange={(event) => {
                setSubjectType(event.target.value);
                setPage(1);
              }}
              className="h-9 text-[12px] md:w-52"
            >
              {SUBJECT_TYPES.map((option) => (
                <option key={option.value || 'any'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        }
        actions={
          <Button variant="secondary" size="sm" onClick={() => setVerifyOpen(true)}>
            <ShieldCheck aria-hidden="true" className="size-4" />
            Verify chain
          </Button>
        }
      />

      {verify.data && !verifyOpen ? (
        <Card className="mb-[var(--space-5)]">
          <CardContent className="py-[var(--space-4)]">
            <VerifyOutcome result={verify.data} />
          </CardContent>
        </Card>
      ) : null}

      {isLoading ? (
        <Card>
          <CardContent>
            <SkeletonText lines={8} />
          </CardContent>
        </Card>
      ) : isError ? (
        <Card className="border-[var(--color-danger-600)]">
          <CardContent>
            <p role="alert" className="m-0 text-[var(--color-danger-700)]">
              {errorMessage(error) ?? 'The audit trail could not be loaded.'}
            </p>
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={ScrollText}
              title="No entries match"
              explanation="Nothing in the trail matches these filters, or the trail is empty."
              nextStep="Clear the action filter or choose Any subject to see the full chain."
            />
          </CardContent>
        </Card>
      ) : (
        <DataTable
          ariaLabel="Audit entries"
          columns={entryColumns(setOpenEntry)}
          rows={items}
          getRowKey={(entry) => String(entry.sequence)}
        />
      )}

      {total > PAGE_SIZE ? (
        <nav
          aria-label="Pagination"
          className="mt-[var(--space-4)] flex items-center justify-between gap-[var(--space-3)]"
        >
          <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
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
        </nav>
      ) : null}

      <Modal
        open={openEntry !== null}
        onClose={() => setOpenEntry(null)}
        title={openEntry ? `Entry #${openEntry.sequence} · ${openEntry.action.replaceAll('_', ' ')}` : ''}
        className="w-[min(40rem,calc(100vw-2rem))]"
      >
        {openEntry ? <EntryDetail entry={openEntry} /> : null}
      </Modal>

      <Modal
        open={verifyOpen}
        onClose={() => setVerifyOpen(false)}
        busy={verify.isPending}
        title="Verify a segment"
        description="Check that each entry still commits to its predecessor. A mature trail is verified in ranges; neighbouring ranges join because each carries the previous hash."
        footer={
          <>
            <Button variant="secondary" onClick={() => setVerifyOpen(false)} disabled={verify.isPending}>
              Close
            </Button>
            <Button
              type="button"
              variant="primary"
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
          </>
        }
      >
        <div className="flex flex-col gap-[var(--space-4)]">
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
          </div>
          {verify.isError ? (
            <p role="alert" className="m-0 text-[var(--color-danger-700)]">
              {errorMessage(verify.error) ?? 'Verification did not complete.'}
            </p>
          ) : null}
          {verify.data ? <VerifyOutcome result={verify.data} /> : null}
        </div>
      </Modal>
    </>
  );
}
