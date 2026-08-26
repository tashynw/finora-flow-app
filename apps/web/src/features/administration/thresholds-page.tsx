/** Purchase-order threshold administration — one row per currency. */

import { useEffect, useState } from 'react';
import { BadgeDollarSign, Plus } from 'lucide-react';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { amountInputValue, formatMoney, isKnownCurrency, parseAmount } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import {
  useSetThresholdActive,
  useThresholds,
  useUpsertThreshold,
  type ThresholdOut,
} from '@/features/administration/use-thresholds';

function ThresholdFormModal({
  open,
  editing,
  onClose,
}: {
  open: boolean;
  editing: ThresholdOut | null;
  onClose: () => void;
}) {
  const upsert = useUpsertThreshold();
  const [currency, setCurrency] = useState('JMD');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setCurrency(editing.currency);
      setAmount(amountInputValue(editing.applies_above_minor_units, editing.currency));
    } else {
      setCurrency('JMD');
      setAmount('');
    }
    setReason('');
    upsert.reset();
  }, [open, editing, upsert]);

  const currencyOk = currency.trim().length === 3 && isKnownCurrency(currency.trim());
  const minorUnits = currencyOk ? parseAmount(amount, currency.trim().toUpperCase()) : null;
  const canSave =
    currencyOk &&
    minorUnits !== null &&
    minorUnits >= 0 &&
    reason.trim().length >= 3 &&
    !upsert.isPending;

  function resetAndClose() {
    setCurrency('JMD');
    setAmount('');
    setReason('');
    upsert.reset();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={resetAndClose}
      title={editing ? `Edit ${editing.currency} threshold` : 'Add PO threshold'}
      description="Invoices at or below this amount need no purchase order. Amounts are entered in major units."
    >
      <div className="flex flex-col gap-[var(--space-4)]">
        <Field label="Currency" help="Three-letter ISO code. One threshold per currency.">
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              maxLength={3}
              disabled={editing !== null}
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
            />
          )}
        </Field>
        <Field
          label="Applies above"
          help="Enter major units (e.g. 50000.00 for JMD 50,000.00). An invoice for exactly this amount needs no PO."
        >
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              inputMode="decimal"
              aria-describedby={describedBy}
              invalid={invalid}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          )}
        </Field>
        <Field label="Why">
          {({ inputId, describedBy, invalid }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        {upsert.isError ? (
          <p role="alert" className="m-0 text-[var(--color-danger-700)]">
            {errorMessage(upsert.error) ?? 'The threshold could not be saved.'}
          </p>
        ) : null}
        <Button
          type="button"
          disabled={!canSave}
          onClick={() => {
            if (minorUnits === null) return;
            upsert.mutate(
              {
                currency: currency.trim().toUpperCase(),
                applies_above_minor_units: minorUnits,
                reason: reason.trim(),
              },
              { onSuccess: resetAndClose },
            );
          }}
        >
          {upsert.isPending ? 'Saving…' : editing ? 'Save threshold' : 'Add threshold'}
        </Button>
      </div>
    </Modal>
  );
}

export function ThresholdsPage() {
  const [includeInactive, setIncludeInactive] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ThresholdOut | null>(null);
  const thresholds = useThresholds(includeInactive);
  const setActive = useSetThresholdActive();

  const rows = thresholds.data ?? [];

  return (
    <div className="flex flex-col gap-[var(--space-6)]">
      <PageHeader
        title="PO thresholds"
        purpose="The amount above which an invoice must name a purchase order, per currency. Soft-deactivate rather than delete so the configured figure remains for audit."
        actions={
          <Button type="button" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" className="size-4" />
            Add threshold
          </Button>
        }
      />

      <label className="flex cursor-pointer items-center gap-[var(--space-2)] text-[var(--text-body-sm)]">
        <input
          type="checkbox"
          className="size-4 accent-[var(--color-primary)]"
          checked={includeInactive}
          onChange={(event) => setIncludeInactive(event.target.checked)}
        />
        Show deactivated thresholds
      </label>

      {thresholds.isLoading ? (
        <SkeletonText lines={6} />
      ) : thresholds.isError ? (
        <p role="alert" className="m-0 text-[var(--color-danger-700)]">
          {errorMessage(thresholds.error) ?? 'The threshold list could not be loaded.'}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={BadgeDollarSign}
          title="No thresholds yet"
          explanation="A currency with no row requires a purchase order on every invoice in that currency."
          nextStep="Use Add threshold and name the amount that starts requiring a PO."
        />
      ) : (
        <Card className="surface-card overflow-hidden">
          <CardContent className="p-0">
            <ul className="m-0 list-none p-0">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-col gap-[var(--space-3)] border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="m-0 flex flex-wrap items-baseline gap-x-[var(--space-2)]">
                      <span className="font-semibold text-[var(--color-text-strong)]">
                        {row.currency}
                      </span>
                      <span className="text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                        Applies above{' '}
                        {formatMoney({
                          minorUnits: row.applies_above_minor_units,
                          currency: row.currency,
                        })}
                      </span>
                      {!row.is_active ? (
                        <ToneBadge label="Deactivated" tone="neutral" />
                      ) : null}
                    </p>
                    <p className="m-0 text-[var(--text-caption)] text-[var(--color-text-subtle)]">
                      An invoice for exactly this amount needs no purchase order.
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-[var(--space-2)]">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => setEditing(row)}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={setActive.isPending}
                      className={cn(!row.is_active && 'text-[var(--color-success-700)]')}
                      onClick={() => {
                        const reason = window.prompt(
                          row.is_active
                            ? 'Why is this threshold being deactivated?'
                            : 'Why is this threshold being reactivated?',
                        );
                        if (!reason || reason.trim().length < 3) return;
                        setActive.mutate({
                          id: row.id,
                          body: {
                            is_active: !row.is_active,
                            reason: reason.trim(),
                          },
                        });
                      }}
                    >
                      {row.is_active ? 'Deactivate' : 'Reactivate'}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <ThresholdFormModal
        open={creating || editing !== null}
        editing={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </div>
  );
}
