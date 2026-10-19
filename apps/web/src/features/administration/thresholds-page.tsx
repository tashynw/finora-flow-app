/** Purchase-order threshold administration — one row per currency. */

import { useEffect, useState } from 'react';
import { BadgeDollarSign, Plus } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { amountInputValue, displayAmountInput, formatMoney, parseAmount } from '@/lib/money';
import { auditReason } from '@/lib/form-schemas';
import { HookField } from '@/components/form/hook-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { ViewTabs } from '@/components/ui/view-tabs';
import { ToneBadge } from '@/components/workflow/status-badge';
import { ActiveChangeModal } from '@/features/administration/active-change-modal';
import { PageHeader } from '@/features/shared/page-header';
import {
  useSetThresholdActive,
  useThresholds,
  useUpsertThreshold,
  type ThresholdOut,
} from '@/features/administration/use-thresholds';

/** Matches the Prisma `Currency` enum. A threshold accepts only these. */
const THRESHOLD_CURRENCIES = ['JMD', 'USD'] as const;

function thresholdCurrency(value: string): (typeof THRESHOLD_CURRENCIES)[number] {
  return (THRESHOLD_CURRENCIES as readonly string[]).includes(value)
    ? (value as (typeof THRESHOLD_CURRENCIES)[number])
    : 'JMD';
}

const thresholdSchema = z
  .object({
    currency: z.enum(THRESHOLD_CURRENCIES, { error: 'Choose JMD or USD.' }),
    amount: z.string().trim().min(1, 'Enter an amount in major units.'),
    reason: auditReason,
  })
  .superRefine((values, context) => {
    const minorUnits = parseAmount(values.amount, values.currency);
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
      currency: thresholdCurrency(editing?.currency ?? 'JMD'),
      amount: editing
        ? amountInputValue(editing.applies_above_minor_units, editing.currency)
        : '',
      reason: '',
    });
    upsert.reset();
  }, [open, editing, reset, upsert.reset]);

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
      {
        onSuccess: () => {
          toast.success(
            editing ? 'The threshold has been saved.' : 'The threshold has been added.',
          );
          resetAndClose();
        },
        onError: (error) => {
          toast.error(errorMessage(error) ?? 'The threshold could not be saved.');
        },
      },
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
          help="One threshold per currency."
        >
          {({ inputId, describedBy, invalid }, field) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={editing !== null}
              {...field}
            >
              {THRESHOLD_CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </Select>
          )}
        </HookField>
        <HookField
          control={control}
          name="amount"
          label="Applies above"
          required
          help="Enter major units (e.g. 50,000.00). An invoice for exactly this amount needs no PO."
        >
          {({ inputId, describedBy, invalid }, field) => (
            <Input
              id={inputId}
              type="text"
              inputMode="decimal"
              aria-describedby={describedBy}
              invalid={invalid}
              name={field.name}
              ref={field.ref}
              value={displayAmountInput(field.value)}
              onBlur={field.onBlur}
              onChange={(event) => {
                const value = event.target.value.replace(/,/g, '');
                if (value === '' || /^\d*\.?\d*$/.test(value)) field.onChange(value);
              }}
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
  const [statusTarget, setStatusTarget] = useState<ThresholdOut | null>(null);
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
            className={cn(!row.is_active && 'text-[var(--color-success-700)]')}
            onClick={() => setStatusTarget(row)}
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
      <ActiveChangeModal
        open={statusTarget !== null}
        title={statusTarget?.is_active ? 'Deactivate threshold' : 'Reactivate threshold'}
        description={
          statusTarget
            ? statusTarget.is_active
              ? `Are you sure you want to deactivate the ${statusTarget.currency} threshold? Invoices in this currency will require a purchase order at every amount until it is reactivated.`
              : `Are you sure you want to reactivate the ${statusTarget.currency} threshold? Invoices at or below this amount need no purchase order again.`
            : undefined
        }
        nextActive={statusTarget ? !statusTarget.is_active : false}
        confirmLabel={statusTarget?.is_active ? 'Deactivate threshold' : 'Reactivate threshold'}
        reasonPlaceholder={
          statusTarget?.is_active
            ? 'Enter a reason for deactivating this threshold'
            : 'Enter a reason for reactivating this threshold'
        }
        pending={setActive.isPending}
        onClose={() => setStatusTarget(null)}
        onConfirm={(reason) => {
          if (!statusTarget) return;
          setActive.mutate(
            {
              id: statusTarget.id,
              body: { is_active: !statusTarget.is_active, reason },
            },
            {
              onSuccess: () => {
                toast.success(
                  statusTarget.is_active
                    ? 'The threshold has been deactivated.'
                    : 'The threshold has been reactivated.',
                );
                setStatusTarget(null);
              },
              onError: (error) => {
                toast.error(errorMessage(error) ?? 'The threshold could not be changed.');
              },
            },
          );
        }}
      />
    </>
  );
}
