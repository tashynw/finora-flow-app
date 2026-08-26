/** Retention-policy administration — one row per seeded record class. */

import { useEffect, useState } from 'react';
import { Hourglass } from 'lucide-react';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
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
  const [days, setDays] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open || !editing) return;
    setDays(String(editing.retention_days));
    setReason('');
    update.reset();
  }, [open, editing, update]);

  const parsedDays = Number.parseInt(days, 10);
  const daysOk = Number.isInteger(parsedDays) && parsedDays >= 1;
  const canSave = editing !== null && daysOk && reason.trim().length >= 3 && !update.isPending;

  function resetAndClose() {
    setDays('');
    setReason('');
    update.reset();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={resetAndClose}
      title={editing ? `Edit ${formatRecordClass(editing.record_class)}` : 'Edit retention'}
      description="Periods are provisional defaults until the requirements document confirms them. Changes are audited."
    >
      <div className="flex flex-col gap-[var(--space-4)]">
        {editing ? (
          <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
            {editing.description}
          </p>
        ) : null}
        <Field label="Retention days" help="Whole days, at least one.">
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              inputMode="numeric"
              aria-describedby={describedBy}
              invalid={invalid}
              value={days}
              onChange={(event) => setDays(event.target.value)}
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
        {update.isError ? (
          <p role="alert" className="m-0 text-[var(--color-danger-700)]">
            {errorMessage(update.error) ?? 'The retention policy could not be saved.'}
          </p>
        ) : null}
        <Button
          type="button"
          disabled={!canSave}
          onClick={() => {
            if (!editing || !daysOk) return;
            update.mutate(
              {
                id: editing.id,
                body: {
                  retention_days: parsedDays,
                  reason: reason.trim(),
                },
              },
              { onSuccess: resetAndClose },
            );
          }}
        >
          {update.isPending ? 'Saving…' : 'Save period'}
        </Button>
      </div>
    </Modal>
  );
}

export function RetentionPage() {
  const [includeInactive, setIncludeInactive] = useState(true);
  const [editing, setEditing] = useState<RetentionPolicyOut | null>(null);
  const policies = useRetentionPolicies(includeInactive);
  const setActive = useSetRetentionActive();

  const rows = policies.data ?? [];

  return (
    <div className="flex flex-col gap-[var(--space-6)]">
      <PageHeader
        title="Retention"
        purpose="How long each class of records is kept. Defaults are provisional; soft-deactivate rather than delete so the configured period remains for audit."
      />

      <label className="flex cursor-pointer items-center gap-[var(--space-2)] text-[var(--text-body-sm)]">
        <input
          type="checkbox"
          className="size-4 accent-[var(--color-primary)]"
          checked={includeInactive}
          onChange={(event) => setIncludeInactive(event.target.checked)}
        />
        Show deactivated policies
      </label>

      {policies.isLoading ? (
        <SkeletonText lines={6} />
      ) : policies.isError ? (
        <p role="alert" className="m-0 text-[var(--color-danger-700)]">
          {errorMessage(policies.error) ?? 'The retention list could not be loaded.'}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Hourglass}
          title="No retention policies"
          explanation="Policies are seeded by migration. If this list is empty, the database may need migrating."
          nextStep="Ask an operator to run alembic upgrade head, then reload."
        />
      ) : (
        <Card className="surface-card overflow-hidden">
          <CardContent className="p-0">
            <ul className="m-0 list-none p-0">
              {rows.map((row) => {
                const years = approximateYears(row.retention_days);
                return (
                  <li
                    key={row.id}
                    className="flex flex-col gap-[var(--space-3)] border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="m-0 flex flex-wrap items-baseline gap-x-[var(--space-2)]">
                        <span className="font-semibold capitalize text-[var(--color-text-strong)]">
                          {formatRecordClass(row.record_class)}
                        </span>
                        <span className="text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                          {row.retention_days.toLocaleString()} days
                          {years ? ` (${years})` : ''}
                        </span>
                        {!row.is_active ? (
                          <ToneBadge label="Deactivated" tone="neutral" />
                        ) : null}
                      </p>
                      <p className="m-0 text-[var(--text-caption)] text-[var(--color-text-subtle)]">
                        {row.description}
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
                              ? 'Why is this retention policy being deactivated?'
                              : 'Why is this retention policy being reactivated?',
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
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <EditRetentionModal
        open={editing !== null}
        editing={editing}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}
