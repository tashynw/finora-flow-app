/** Purchase-order threshold administration — one row per currency. */

import { useEffect, useState } from 'react';
import { BadgeDollarSign, Plus } from 'lucide-react';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { amountInputValue, formatMoney, isKnownCurrency, parseAmount } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { ViewTabs } from '@/components/ui/view-tabs';
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

  const columns: Column<ThresholdOut>[] = [
    {
      key: 'currency',
      header: 'Currency',
      width: 'w-32',
      cell: (row) => (
        <span className="font-semibold text-[var(--color-text-strong)]">{row.currency}</span>
      ),
    },
    {
      key: 'threshold',
      header: 'Threshold',
      width: 'w-48',
      cell: (row) => (
        <span className="tabular">
          {formatMoney({ minorUnits: row.applies_above_minor_units, currency: row.currency })}
        </span>
      ),
    },
    {
      key: 'rule',
      header: 'Rule',
      hideBelow: 'md',
      cell: () => (
        <span className="flex flex-col">
          <span>PO required above</span>
          <span className="text-[11px] text-[var(--color-text-subtle)]">
            An invoice for exactly this amount needs no purchase order.
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'w-32',
      cell: (row) =>
        row.is_active ? (
          <ToneBadge label="Active" tone="success" />
        ) : (
          <ToneBadge label="Deactivated" tone="neutral" />
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      width: 'w-48',
      align: 'right',
      cell: (row) => (
        <span className="inline-flex gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(row)}>
            Edit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
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
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="PO thresholds"
        purpose="Purchase-order requirements by currency. Deactivate rather than delete so the configured figure remains for audit."
        toolbar={
          <ViewTabs
            label="Which thresholds"
            tabs={[
              { id: 'all', label: 'All thresholds' },
              { id: 'active', label: 'Active only' },
            ]}
            value={includeInactive ? 'all' : 'active'}
            onChange={(id) => setIncludeInactive(id === 'all')}
          />
        }
        actions={
          <Button type="button" variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" className="size-4" />
            Add currency
          </Button>
        }
      />

      {thresholds.isLoading ? (
        <Card>
          <CardContent>
            <SkeletonText lines={6} />
          </CardContent>
        </Card>
      ) : thresholds.isError ? (
        <Card className="border-[var(--color-danger-600)]">
          <CardContent>
            <p role="alert" className="m-0 text-[var(--color-danger-700)]">
              {errorMessage(thresholds.error) ?? 'The threshold list could not be loaded.'}
            </p>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={BadgeDollarSign}
              title="No thresholds yet"
              explanation="A currency with no row requires a purchase order on every invoice in that currency."
              nextStep="Use Add currency and name the amount that starts requiring a PO."
            />
          </CardContent>
        </Card>
      ) : (
        <DataTable
          ariaLabel="PO thresholds"
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
        />
      )}

      <ThresholdFormModal
        open={creating || editing !== null}
        editing={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </>
  );
}
