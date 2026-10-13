/** Purchase-order threshold administration — one row per currency. */

import { useEffect, useState } from 'react';
import { BadgeDollarSign, Plus } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { amountInputValue, formatMoney, isKnownCurrency, parseAmount } from '@/lib/money';
import { auditReason } from '@/lib/form-schemas';
import { HookField } from '@/components/form/hook-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Textarea } from '@/components/ui/field';
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

const thresholdSchema = z
  .object({
    currency: z.string().trim().length(3, 'Use a known three-letter currency code.'),
    amount: z.string().trim().min(1, 'Enter an amount in major units.'),
    reason: auditReason,
  })
  .superRefine((values, context) => {
    const currency = values.currency.toUpperCase();
    if (!isKnownCurrency(currency)) {
      context.addIssue({
        code: 'custom',
        path: ['currency'],
        message: 'Use a known three-letter currency code.',
      });
      return;
    }
    const minorUnits = parseAmount(values.amount, currency);
    if (minorUnits === null || minorUnits < 0) {
      context.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'Enter an amount in major units.',
      });
    }
  });

type ThresholdForm = z.infer<typeof thresholdSchema>;

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
  const { control, handleSubmit, reset } = useForm<ThresholdForm>({
    resolver: zodResolver(thresholdSchema),
    defaultValues: { currency: 'JMD', amount: '', reason: '' },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      currency: editing?.currency ?? 'JMD',
      amount: editing
        ? amountInputValue(editing.applies_above_minor_units, editing.currency)
        : '',
      reason: '',
    });
    upsert.reset();
  }, [open, editing, reset, upsert]);

  function resetAndClose() {
    reset({ currency: 'JMD', amount: '', reason: '' });
    upsert.reset();
    onClose();
  }

  const onSubmit = handleSubmit((values) => {
    const currency = values.currency.toUpperCase();
    const minorUnits = parseAmount(values.amount, currency);
    if (minorUnits === null) return;
    upsert.mutate(
      {
        currency,
        applies_above_minor_units: minorUnits,
        reason: values.reason,
      },
      { onSuccess: resetAndClose },
    );
  });

  return (
    <Modal
      open={open}
      onClose={resetAndClose}
      title={editing ? `Edit ${editing.currency} threshold` : 'Add PO threshold'}
      description="Invoices at or below this amount need no purchase order. Amounts are entered in major units."
    >
      <form className="flex flex-col gap-[var(--space-4)]" onSubmit={onSubmit} noValidate>
        <HookField
          control={control}
          name="currency"
          label="Currency"
          required
          help="Three-letter ISO code. One threshold per currency."
        >
          {({ inputId, describedBy, invalid }, field) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              maxLength={3}
              disabled={editing !== null}
              name={field.name}
              ref={field.ref}
              value={field.value}
              onBlur={field.onBlur}
              onChange={(event) => field.onChange(event.target.value.toUpperCase())}
            />
          )}
        </HookField>
        <HookField
          control={control}
          name="amount"
          label="Applies above"
          required
          help="Enter major units (e.g. 50000.00 for JMD 50,000.00). An invoice for exactly this amount needs no PO."
        >
          {({ inputId, describedBy, invalid }, field) => (
            <Input
              id={inputId}
              inputMode="decimal"
              aria-describedby={describedBy}
              invalid={invalid}
              {...field}
            />
          )}
        </HookField>
        <HookField control={control} name="reason" label="Why" required>
          {({ inputId, describedBy, invalid }, field) => (
            <Textarea id={inputId} aria-describedby={describedBy} invalid={invalid} rows={3} {...field} />
          )}
        </HookField>
        {upsert.isError ? (
          <p role="alert" className="m-0 text-[var(--color-danger-700)]">
            {errorMessage(upsert.error) ?? 'The threshold could not be saved.'}
          </p>
        ) : null}
        <Button type="submit" isLoading={upsert.isPending} loadingLabel="Saving">
          {editing ? 'Save threshold' : 'Add threshold'}
        </Button>
      </form>
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
