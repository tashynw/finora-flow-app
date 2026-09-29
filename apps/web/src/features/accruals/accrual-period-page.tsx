import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import type { AccrualCandidateOut, AccrualCandidateStanding } from '@finora/shared-types';

import { errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { periodWaitingOn } from '@/features/accruals/accrual-vocabulary';
import {
  useAccrualPeriod,
  useEditCandidate,
  useExportPeriod,
  useFinalizeCandidate,
  useGenerateCandidates,
  useLockPeriod,
} from '@/features/accruals/use-accruals';
import { PageHeader } from '@/features/shared/page-header';
import { BookOpen } from 'lucide-react';

function candidateTone(
  standing: AccrualCandidateStanding,
): 'neutral' | 'warning' | 'success' {
  if (standing === 'finalized') return 'success';
  if (standing === 'excluded') return 'neutral';
  return 'warning';
}

function isOpen(standing: AccrualCandidateStanding): boolean {
  return standing === 'proposed' || standing === 'adjusted';
}

export function AccrualPeriodPage() {
  const { periodId } = useParams<{ periodId: string }>();
  const period = useAccrualPeriod(periodId);
  const generate = useGenerateCandidates(periodId);
  const editCandidate = useEditCandidate(periodId);
  const finalizeCandidate = useFinalizeCandidate(periodId);
  const lock = useLockPeriod(periodId);
  const exportPeriod = useExportPeriod(periodId);

  // Edit / finalize modal
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [amountMajor, setAmountMajor] = useState('');
  const [currency, setCurrency] = useState('');
  const [exclude, setExclude] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  // Lock dialog
  const [lockOpen, setLockOpen] = useState(false);
  const [lockReason, setLockReason] = useState('');

  const detail = period.data;
  const selected = useMemo(
    () => detail?.candidates.find((row) => row.id === selectedId) ?? null,
    [detail, selectedId],
  );

  function openCandidate(row: AccrualCandidateOut) {
    setSelectedId(row.id);
    // Initialise from existing amount so the user sees the current value.
    setAmountMajor((row.amount.minor_units / 100).toFixed(2));
    setCurrency(row.amount.currency);
    setExclude(false);
    setReason(row.edit_reason ?? '');
    setNote(row.note ?? '');
  }

  if (period.isLoading || !detail) {
    return (
      <div className="p-[var(--space-6)]">
        <SkeletonText lines={8} />
      </div>
    );
  }

  const canEdit = detail.actions['edit'] ?? false;
  const canGenerate = detail.actions['generate'] ?? false;
  const canFinalize = detail.actions['finalize'] ?? false;
  const canLock = detail.actions['lock'] ?? false;
  const canExport = detail.actions['export'] ?? false;

  const finalizedCount = detail.candidates.filter((row) => row.standing === 'finalized').length;
  const excludedCount = detail.candidates.filter((row) => row.standing === 'excluded').length;

  const modalOpen =
    selected !== null &&
    (canEdit && isOpen(selected.standing) || canFinalize && isOpen(selected.standing));

  return (
    <div className="flex flex-col gap-[var(--space-6)]">
      <PageHeader
        title={detail.label}
        purpose={detail.standing_description}
        meta={
          <Link
            to="/accruals"
            className="text-[length:var(--text-body-sm)] text-[var(--color-text-muted)] no-underline hover:underline"
          >
            Accruals
          </Link>
        }
        actions={
          <div className="flex flex-wrap items-center gap-[var(--space-2)]">
            <ToneBadge
              tone={detail.standing === 'locked' ? 'neutral' : 'warning'}
              label={detail.standing_label}
            />
            {canGenerate ? (
              <Button
                type="button"
                variant="secondary"
                disabled={generate.isPending}
                onClick={() => generate.mutate()}
              >
                {generate.isPending ? 'Generating…' : 'Generate candidates'}
              </Button>
            ) : null}
            {canLock ? (
              <Button type="button" onClick={() => setLockOpen(true)}>
                Lock period
              </Button>
            ) : null}
          </div>
        }
      />

      {generate.isError ? (
        <p
          role="alert"
          className="m-0 rounded-md bg-[var(--color-surface-danger-subtle)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-body-sm)] text-[var(--color-text-danger)]"
        >
          {errorMessage(generate.error) ?? 'Generate failed — please try again.'}
        </p>
      ) : null}

      <Card className="surface-card">
        <CardContent className="grid gap-[var(--space-3)] p-[var(--space-5)] sm:grid-cols-4">
          <div>
            <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-subtle)]">
              Reference
            </p>
            <p className="m-0 font-semibold tabular">{detail.reference}</p>
          </div>
          <div>
            <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-subtle)]">
              Period
            </p>
            <p className="m-0 font-semibold">
              {detail.period_start} – {detail.period_end}
            </p>
          </div>
          <div>
            <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-subtle)]">
              Candidates
            </p>
            <p className="m-0 font-semibold">
              {detail.candidate_count} total · {finalizedCount} finalised ·{' '}
              {excludedCount} excluded
            </p>
          </div>
          <div>
            <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-subtle)]">
              Waiting on
            </p>
            <p className="m-0 font-semibold">
              {periodWaitingOn(
                detail.open_candidate_count,
                detail.candidate_count,
                detail.standing,
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="surface-card overflow-hidden">
        {detail.candidates.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No candidates yet"
            explanation="Generate candidates from unpaid invoices using the button above. Each candidate represents a claim that something is owed at period end."
            nextStep={
              canGenerate
                ? 'Click "Generate candidates" to pull in unpaid invoices.'
                : 'Candidates are generated by the person managing this period.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[length:var(--text-body-sm)]">
              <thead className="bg-[var(--color-surface-subtle)] text-[var(--color-text-subtle)]">
                <tr>
                  <th className="px-[var(--space-4)] py-[var(--space-3)] font-medium">
                    Vendor
                  </th>
                  <th className="px-[var(--space-4)] py-[var(--space-3)] font-medium">
                    Description
                  </th>
                  <th className="px-[var(--space-4)] py-[var(--space-3)] font-medium">
                    Amount
                  </th>
                  <th className="px-[var(--space-4)] py-[var(--space-3)] font-medium">
                    GL · CC
                  </th>
                  <th className="px-[var(--space-4)] py-[var(--space-3)] font-medium">
                    Standing
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.candidates.map((row) => (
                  <tr
                    key={row.id}
                    className="cursor-pointer border-t border-[var(--color-divider)] hover:bg-[var(--color-surface-subtle)]"
                    onClick={() => {
                      if (
                        (canEdit && isOpen(row.standing)) ||
                        (canFinalize && isOpen(row.standing))
                      ) {
                        openCandidate(row);
                      }
                    }}
                  >
                    <td className="px-[var(--space-4)] py-[var(--space-3)]">
                      <span className="font-medium text-[var(--color-text-strong)]">
                        {row.vendor_name}
                      </span>
                      {row.invoice_number ? (
                        <span className="mt-0.5 block text-[var(--color-text-muted)]">
                          Inv {row.invoice_number}
                        </span>
                      ) : null}
                    </td>
                    <td className="max-w-[20ch] truncate px-[var(--space-4)] py-[var(--space-3)] text-[var(--color-text-muted)]">
                      {row.description}
                    </td>
                    <td className="px-[var(--space-4)] py-[var(--space-3)] tabular">
                      {row.standing === 'adjusted' ? (
                        <>
                          <span className="line-through text-[var(--color-text-subtle)]">
                            {row.original_amount.formatted}
                          </span>{' '}
                          <span className="font-medium text-[var(--color-text-strong)]">
                            {row.amount.formatted}
                          </span>
                        </>
                      ) : (
                        row.amount.formatted
                      )}
                    </td>
                    <td className="px-[var(--space-4)] py-[var(--space-3)] text-[var(--color-text-muted)]">
                      {[row.gl_account?.code, row.cost_centre?.code]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                    <td className="px-[var(--space-4)] py-[var(--space-3)]">
                      <ToneBadge
                        tone={candidateTone(row.standing)}
                        label={row.standing_label}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {canExport ? (
        <Card className="surface-card">
          <CardContent className="flex flex-col gap-[var(--space-4)] p-[var(--space-5)]">
            <div>
              <h2 className="m-0 text-[length:var(--text-title-sm)] text-[var(--color-text-strong)]">
                Export
              </h2>
              <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                Draft exports are for review. Official exports are the signed-off
                version and are recorded on the period.
              </p>
            </div>
            {exportPeriod.isError ? (
              <p
                role="alert"
                className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-danger)]"
              >
                {errorMessage(exportPeriod.error) ?? 'Export failed — please try again.'}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-[var(--space-2)]">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={exportPeriod.isPending}
                onClick={() => exportPeriod.mutate({ format: 'csv', official: false })}
              >
                CSV (draft)
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={exportPeriod.isPending}
                onClick={() => exportPeriod.mutate({ format: 'xlsx', official: false })}
              >
                XLSX (draft)
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={exportPeriod.isPending}
                onClick={() => exportPeriod.mutate({ format: 'csv', official: true })}
              >
                CSV (official)
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={exportPeriod.isPending}
                onClick={() => exportPeriod.mutate({ format: 'xlsx', official: true })}
              >
                XLSX (official)
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Edit / finalize modal — opens when a row is clicked and the user has
          at least one of edit or finalize access on an open candidate. */}
      <Modal
        open={modalOpen}
        onClose={() => setSelectedId(null)}
        title={selected?.vendor_name ?? 'Candidate'}
        description={
          selected
            ? `${selected.reference} · ${selected.amount.formatted} · ${selected.description}`
            : undefined
        }
      >
        {selected ? (
          <div className="flex flex-col gap-[var(--space-4)]">
            {canEdit && isOpen(selected.standing) ? (
              <>
                <Field
                  label="Amount"
                  help="Enter the adjusted amount in major units (e.g. 1 500.00 for JMD 1,500.00)."
                >
                  {({ inputId, describedBy, invalid }) => (
                    <Input
                      id={inputId}
                      type="number"
                      step="0.01"
                      min="0"
                      aria-describedby={describedBy}
                      invalid={invalid}
                      value={amountMajor}
                      onChange={(event) => setAmountMajor(event.target.value)}
                    />
                  )}
                </Field>

                <Field label="Exclude this candidate">
                  {({ inputId }) => (
                    <label className="flex cursor-pointer items-center gap-[var(--space-2)]">
                      <input
                        id={inputId}
                        type="checkbox"
                        checked={exclude}
                        onChange={(event) => setExclude(event.target.checked)}
                        className="size-4 accent-[var(--color-primary)]"
                      />
                      <span className="text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                        Remove this candidate from the pack
                      </span>
                    </label>
                  )}
                </Field>

                <Field
                  label="Reason"
                  help="Required. Explain why the amount was changed or why this candidate was excluded."
                >
                  {({ inputId, describedBy, invalid }) => (
                    <Textarea
                      id={inputId}
                      aria-describedby={describedBy}
                      invalid={invalid}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      rows={3}
                    />
                  )}
                </Field>

                <Field label="Note" help="Optional — appears in the export alongside the candidate.">
                  {({ inputId, describedBy, invalid }) => (
                    <Textarea
                      id={inputId}
                      aria-describedby={describedBy}
                      invalid={invalid}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      rows={2}
                    />
                  )}
                </Field>

                <div className="flex flex-wrap gap-[var(--space-2)]">
                  <Button
                    type="button"
                    disabled={
                      editCandidate.isPending || reason.trim().length < 3 || !amountMajor
                    }
                    onClick={() =>
                      editCandidate.mutate(
                        {
                          candidateId: selected.id,
                          body: {
                            amount_minor: Math.round(parseFloat(amountMajor) * 100),
                            currency,
                            exclude,
                            reason,
                            note: note.trim() || null,
                            expected_version: selected.version,
                          },
                        },
                        { onSuccess: () => setSelectedId(null) },
                      )
                    }
                  >
                    Save adjustment
                  </Button>
                </div>

                <hr className="border-[var(--color-divider)]" />
              </>
            ) : null}

            {canFinalize && isOpen(selected.standing) ? (
              <div className="flex flex-col gap-[var(--space-3)]">
                <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                  Finalising commits this candidate to the period pack. The amount
                  and coding can no longer be changed after this.
                </p>
                <div>
                  <Button
                    type="button"
                    disabled={finalizeCandidate.isPending}
                    onClick={() =>
                      finalizeCandidate.mutate(
                        {
                          candidateId: selected.id,
                          body: { expected_version: selected.version },
                        },
                        { onSuccess: () => setSelectedId(null) },
                      )
                    }
                  >
                    Finalise candidate
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* Lock dialog — mirrors the close-period dialog in credit cards. */}
      <Modal
        open={lockOpen}
        onClose={() => setLockOpen(false)}
        title={`Lock ${detail.reference}`}
        description="Locking freezes candidates. The person who raised these accruals cannot lock the period."
      >
        <div className="flex flex-col gap-[var(--space-4)]">
          <Field label="Why">
            {({ inputId, describedBy, invalid }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                value={lockReason}
                onChange={(event) => setLockReason(event.target.value)}
                rows={3}
              />
            )}
          </Field>
          <Button
            type="button"
            disabled={lock.isPending || lockReason.trim().length < 3}
            onClick={() =>
              lock.mutate(
                { reason: lockReason },
                {
                  onSuccess: () => {
                    setLockOpen(false);
                    setLockReason('');
                  },
                },
              )
            }
          >
            Lock period
          </Button>
        </div>
      </Modal>
    </div>
  );
}
