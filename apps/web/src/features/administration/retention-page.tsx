/** Retention-policy administration — one row per seeded record class. */

import { useEffect, useState } from 'react';
import { Hourglass } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
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
  useRetentionPolicies,
  useSetRetentionActive,
  useUpdateRetentionPolicy,
  type RetentionPolicyOut,
} from '@/features/administration/use-retention';

function formatRecordClass(value: string): string {
  return value.replaceAll('_', ' ');
}

function approximateYears(days: number): string | null {
  if (days < 365) return null;
  const years = Math.round((days / 365) * 10) / 10;
  return `~${years} year${years === 1 ? '' : 's'}`;
}

const retentionSchema = z.object({
  days: z
    .string()
    .trim()
    .regex(/^[1-9]\d*$/, 'Enter a whole number of days, at least one.'),
  reason: auditReason,
});

type RetentionForm = z.infer<typeof retentionSchema>;

function EditRetentionModal({
  open,
  editing,
  onClose,
}: {
  open: boolean;
  editing: RetentionPolicyOut | null;
  onClose: () => void;
}) {
  const update = useUpdateRetentionPolicy();
  const { control, handleSubmit, reset } = useForm<RetentionForm>({
    resolver: zodResolver(retentionSchema),
    defaultValues: { days: '', reason: '' },
  });

  useEffect(() => {
    if (!open || !editing) return;
    reset({ days: String(editing.retention_days), reason: '' });
    update.reset();
  }, [open, editing, reset, update]);

  function resetAndClose() {
    reset({ days: '', reason: '' });
    update.reset();
    onClose();
  }

  const onSubmit = handleSubmit((values) => {
    if (!editing) return;
    update.mutate(
      {
        id: editing.record_class,
        body: {
          retention_days: Number.parseInt(values.days, 10),
          reason: values.reason,
        },
      },
      { onSuccess: resetAndClose },
    );
  });

  return (
    <Modal
      open={open}
      onClose={resetAndClose}
      title={editing ? `Edit ${formatRecordClass(editing.record_class)}` : 'Edit retention'}
      description="Periods are provisional defaults until the requirements document confirms them. Changes are audited."
    >
      <form className="flex flex-col gap-[var(--space-4)]" onSubmit={onSubmit} noValidate>
        {editing ? (
          <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
            {editing.description}
          </p>
        ) : null}
        <HookField control={control} name="days" label="Retention days" required help="Whole days, at least one.">
          {({ inputId, describedBy, invalid }, field) => (
            <Input id={inputId} inputMode="numeric" aria-describedby={describedBy} invalid={invalid} {...field} />
          )}
        </HookField>
        <HookField control={control} name="reason" label="Why" required>
          {({ inputId, describedBy, invalid }, field) => (
            <Textarea id={inputId} aria-describedby={describedBy} invalid={invalid} rows={3} {...field} />
          )}
        </HookField>
        {update.isError ? (
          <p role="alert" className="m-0 text-[var(--color-danger-700)]">
            {errorMessage(update.error) ?? 'The retention policy could not be saved.'}
          </p>
        ) : null}
        <Button type="submit" isLoading={update.isPending} loadingLabel="Saving">
          Save period
        </Button>
      </form>
    </Modal>
  );
}

export function RetentionPage() {
  const [includeInactive, setIncludeInactive] = useState(true);
  const [editing, setEditing] = useState<RetentionPolicyOut | null>(null);
  const policies = useRetentionPolicies(includeInactive);
  const setActive = useSetRetentionActive();

  const rows = policies.data ?? [];

  const columns: Column<RetentionPolicyOut>[] = [
    {
      key: 'class',
      header: 'Record class',
      width: 'w-56',
      cell: (row) => (
        <span className="font-semibold capitalize text-[var(--color-text-strong)]">
          {formatRecordClass(row.record_class)}
        </span>
      ),
    },
    {
      key: 'retention',
      header: 'Retention',
      width: 'w-44',
      cell: (row) => {
        const years = approximateYears(row.retention_days);
        return (
          <span className="flex flex-col">
            <span className="tabular">{row.retention_days.toLocaleString()} days</span>
            {years ? (
              <span className="text-[11px] text-[var(--color-text-subtle)]">{years}</span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'basis',
      header: 'Basis',
      hideBelow: 'md',
      cell: (row) => <span className="text-[var(--color-text-muted)]">{row.description}</span>,
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
                  ? 'Why is this retention policy being deactivated?'
                  : 'Why is this retention policy being reactivated?',
              );
              if (!reason || reason.trim().length < 3) return;
              setActive.mutate({
                id: row.record_class,
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
        title="Retention"
        purpose="How long each class of finance record is kept. Defaults are provisional until confirmed."
        toolbar={
          <ViewTabs
            label="Which policies"
            tabs={[
              { id: 'all', label: 'All policies' },
              { id: 'active', label: 'Active only' },
            ]}
            value={includeInactive ? 'all' : 'active'}
            onChange={(id) => setIncludeInactive(id === 'all')}
          />
        }
      />

      {policies.isLoading ? (
        <Card>
          <CardContent>
            <SkeletonText lines={6} />
          </CardContent>
        </Card>
      ) : policies.isError ? (
        <Card className="border-[var(--color-danger-600)]">
          <CardContent>
            <p role="alert" className="m-0 text-[var(--color-danger-700)]">
              {errorMessage(policies.error) ?? 'The retention list could not be loaded.'}
            </p>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Hourglass}
              title="No retention policies"
              explanation="Policies are seeded by migration. If this list is empty, the database may need migrating."
              nextStep="Ask an operator to run alembic upgrade head, then reload."
            />
          </CardContent>
        </Card>
      ) : (
        <DataTable
          ariaLabel="Retention policies"
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
        />
      )}

      <EditRetentionModal
        open={editing !== null}
        editing={editing}
        onClose={() => setEditing(null)}
      />
    </>
  );
}
