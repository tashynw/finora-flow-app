import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import type { CreditCardTransactionOut } from '@finora/shared-types';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { periodWaitingOn } from '@/features/credit-cards/credit-card-vocabulary';
import {
  useClosePeriod,
  useCodeTransaction,
  useCreditCardPeriod,
  useMatchReceipt,
} from '@/features/credit-cards/use-credit-cards';
import { PageHeader } from '@/features/shared/page-header';
import { useReferenceData } from '@/features/shared/use-reference-data';

function codingTone(standing: string): 'neutral' | 'warning' | 'success' {
  if (standing === 'coded') return 'success';
  if (standing === 'excepted') return 'neutral';
  return 'warning';
}

export function CreditCardPeriodPage() {
  const { periodId } = useParams<{ periodId: string }>();
  const period = useCreditCardPeriod(periodId);
  const reference = useReferenceData();
  const code = useCodeTransaction(periodId);
  const matchReceipt = useMatchReceipt(periodId);
  const close = useClosePeriod(periodId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeReason, setCloseReason] = useState('');
  const [glId, setGlId] = useState('');
  const [costCentreId, setCostCentreId] = useState('');
  const [category, setCategory] = useState('');
  const [exception, setException] = useState('');
  const [waiverReason, setWaiverReason] = useState('');

  const detail = period.data;
  const selected = useMemo(
    () => detail?.transactions.find((row) => row.id === selectedId) ?? null,
    [detail, selectedId],
  );

  function openTransaction(row: CreditCardTransactionOut) {
    setSelectedId(row.id);
    setGlId(row.gl_account?.id ?? '');
    setCostCentreId(row.cost_centre?.id ?? '');
    setCategory(row.category ?? '');
    setException(row.exception_reason ?? '');
    setWaiverReason(row.receipt_waiver_reason ?? '');
  }

  if (period.isLoading || !detail) {
    return (
      <div className="p-[var(--space-6)]">
        <SkeletonText lines={8} />
      </div>
    );
  }

  const glAccounts = reference.data?.gl_accounts ?? [];
  const costCentres = reference.data?.cost_centres ?? [];

  return (
    <div className="flex flex-col gap-[var(--space-6)]">
      <PageHeader
        title={`${detail.card.label} ·••• ${detail.card.last_four}`}
        purpose={detail.standing_description}
        meta={
          <Link
            to="/credit-cards"
            className="text-[var(--text-body-sm)] text-[var(--color-text-muted)] no-underline hover:underline"
          >
            Credit cards
          </Link>
        }
        actions={
          <div className="flex flex-wrap items-center gap-[var(--space-2)]">
            <ToneBadge
              tone={detail.standing === 'closed' ? 'neutral' : 'warning'}
              label={detail.standing_label}
            />
            {detail.actions.close ? (
              <Button type="button" onClick={() => setCloseOpen(true)}>
                Close period
              </Button>
            ) : null}
          </div>
        }
      />

      <Card className="surface-card">
        <CardContent className="grid gap-[var(--space-3)] p-[var(--space-5)] sm:grid-cols-4">
          <div>
            <p className="m-0 text-[var(--text-caption)] text-[var(--color-text-subtle)]">
              Reference
            </p>
            <p className="m-0 font-semibold tabular">{detail.reference}</p>
          </div>
          <div>
            <p className="m-0 text-[var(--text-caption)] text-[var(--color-text-subtle)]">
              Period
            </p>
            <p className="m-0 font-semibold">
              {detail.period_start} – {detail.period_end}
            </p>
          </div>
          <div>
            <p className="m-0 text-[var(--text-caption)] text-[var(--color-text-subtle)]">
              Lines
            </p>
            <p className="m-0 font-semibold">{detail.transaction_count}</p>
          </div>
          <div>
            <p className="m-0 text-[var(--text-caption)] text-[var(--color-text-subtle)]">
              Waiting on
            </p>
            <p className="m-0 font-semibold">
              {periodWaitingOn(
                detail.uncoded_count,
                detail.missing_receipt_count,
                detail.standing,
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="surface-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[var(--text-body-sm)]">
            <thead className="bg-[var(--color-surface-subtle)] text-[var(--color-text-subtle)]">
              <tr>
                <th className="px-[var(--space-4)] py-[var(--space-3)] font-medium">Date</th>
                <th className="px-[var(--space-4)] py-[var(--space-3)] font-medium">Merchant</th>
                <th className="px-[var(--space-4)] py-[var(--space-3)] font-medium">Amount</th>
                <th className="px-[var(--space-4)] py-[var(--space-3)] font-medium">Coding</th>
                <th className="px-[var(--space-4)] py-[var(--space-3)] font-medium">Receipt</th>
              </tr>
            </thead>
            <tbody>
              {detail.transactions.map((row) => (
                <tr
                  key={row.id}
                  className="cursor-pointer border-t border-[var(--color-divider)] hover:bg-[var(--color-surface-subtle)]"
                  onClick={() => openTransaction(row)}
                >
                  <td className="px-[var(--space-4)] py-[var(--space-3)] tabular">
                    {row.posted_on}
                  </td>
                  <td className="px-[var(--space-4)] py-[var(--space-3)]">
                    <span className="font-medium text-[var(--color-text-strong)]">
                      {row.merchant}
                    </span>
                    <span className="mt-0.5 block text-[var(--color-text-muted)]">
                      {row.cardholder}
                    </span>
                  </td>
                  <td className="px-[var(--space-4)] py-[var(--space-3)] tabular">
                    {row.amount.formatted}
                  </td>
                  <td className="px-[var(--space-4)] py-[var(--space-3)]">
                    <ToneBadge
                      tone={codingTone(row.coding_standing)}
                      label={row.coding_label}
                    />
                  </td>
                  <td className="px-[var(--space-4)] py-[var(--space-3)]">
                    {row.receipt_label}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal
        open={selected !== null && Boolean(detail.actions.code)}
        onClose={() => setSelectedId(null)}
        title={selected?.merchant ?? 'Transaction'}
        description={
          selected
            ? `${selected.posted_on} · ${selected.amount.formatted} · ${selected.cardholder}`
            : undefined
        }
      >
        {selected ? (
          <div className="flex flex-col gap-[var(--space-4)]">
            <Field label="GL account">
              {({ inputId, describedBy, invalid }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={glId}
                  onChange={(event) => setGlId(event.target.value)}
                >
                  <option value="">Choose…</option>
                  {glAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Cost centre">
              {({ inputId, describedBy, invalid }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={costCentreId}
                  onChange={(event) => setCostCentreId(event.target.value)}
                >
                  <option value="">Choose…</option>
                  {costCentres.map((centre) => (
                    <option key={centre.id} value={centre.id}>
                      {centre.code} — {centre.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Category">
              {({ inputId, describedBy, invalid }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                />
              )}
            </Field>
            <Field
              label="Or except instead"
              help="Use this when the line should not be coded to a GL. Clear the GL and cost centre first."
            >
              {({ inputId, describedBy, invalid }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={exception}
                  onChange={(event) => setException(event.target.value)}
                  rows={3}
                />
              )}
            </Field>
            <div className="flex flex-wrap gap-[var(--space-2)]">
              <Button
                type="button"
                disabled={code.isPending}
                onClick={() =>
                  code.mutate(
                    {
                      transactionId: selected.id,
                      body: exception.trim()
                        ? {
                            exception_reason: exception,
                            category: category || null,
                            expected_version: selected.version,
                          }
                        : {
                            gl_account_id: glId || null,
                            cost_centre_id: costCentreId || null,
                            category: category || null,
                            expected_version: selected.version,
                          },
                    },
                    { onSuccess: () => setSelectedId(null) },
                  )
                }
              >
                Save coding
              </Button>
            </div>

            <hr className="border-[var(--color-divider)]" />

            <Field label="Waive receipt" help="Only when no receipt exists for this charge.">
              {({ inputId, describedBy, invalid }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={waiverReason}
                  onChange={(event) => setWaiverReason(event.target.value)}
                  rows={2}
                  placeholder="Why no receipt is available"
                />
              )}
            </Field>
            <Button
              type="button"
              variant="secondary"
              disabled={matchReceipt.isPending || waiverReason.trim().length < 3}
              onClick={() =>
                matchReceipt.mutate(
                  {
                    transactionId: selected.id,
                    body: { waived: true, waiver_reason: waiverReason },
                  },
                  { onSuccess: () => setSelectedId(null) },
                )
              }
            >
              Waive receipt
            </Button>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={closeOpen}
        onClose={() => setCloseOpen(false)}
        title={`Close ${detail.reference}`}
        description="Closing freezes coding. The person who coded these lines cannot close the period."
      >
        <div className="flex flex-col gap-[var(--space-4)]">
          <Field label="Why">
            {({ inputId, describedBy, invalid }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                value={closeReason}
                onChange={(event) => setCloseReason(event.target.value)}
                rows={3}
              />
            )}
          </Field>
          <Button
            type="button"
            disabled={close.isPending || closeReason.trim().length < 3}
            onClick={() =>
              close.mutate(
                { reason: closeReason },
                {
                  onSuccess: () => {
                    setCloseOpen(false);
                    setCloseReason('');
                  },
                },
              )
            }
          >
            Close period
          </Button>
        </div>
      </Modal>
    </div>
  );
}
