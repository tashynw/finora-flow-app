/**
 * Operational settings — AI kill switch and read-only workflow snapshot.
 */

import { useEffect, useState } from 'react';
import { Power, SlidersHorizontal } from 'lucide-react';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import {
  useOperationalSettings,
  useSetAiKillSwitch,
} from '@/features/administration/use-operational-settings';

function KillSwitchModal({
  open,
  engage,
  onClose,
}: {
  open: boolean;
  engage: boolean;
  onClose: () => void;
}) {
  const mutation = useSetAiKillSwitch();
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open) return;
    setReason('');
    mutation.reset();
  }, [open, engage, mutation]);

  const canSave = reason.trim().length >= 3 && !mutation.isPending;

  function resetAndClose() {
    setReason('');
    mutation.reset();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={resetAndClose}
      title={engage ? 'Engage AI kill switch' : 'Clear AI kill switch'}
      description={
        engage
          ? 'Assistive reading will stop making calls. Every document remains completable by hand.'
          : 'Assistive reading will follow the environment setting again unless configuration has it disabled.'
      }
      busy={mutation.isPending}
      footer={
        <div className="flex justify-end gap-[var(--space-3)]">
          <Button type="button" variant="secondary" onClick={resetAndClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={engage ? 'danger' : 'primary'}
            disabled={!canSave}
            isLoading={mutation.isPending}
            loadingLabel="Saving"
            onClick={() => {
              mutation.mutate(
                { engaged: engage, reason: reason.trim() },
                { onSuccess: () => resetAndClose() },
              );
            }}
          >
            {engage ? 'Engage kill switch' : 'Clear kill switch'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-[var(--space-4)]">
        <Field label="Reason" help="Recorded in the audit trail. At least three characters.">
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
        {mutation.isError ? (
          <p role="alert" className="m-0 text-[var(--color-danger-700)]">
            {errorMessage(mutation.error) ?? 'The kill switch could not be updated.'}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function SnapshotRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-[var(--space-4)]">
      <dt className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">{label}</dt>
      <dd className="m-0 font-semibold text-[var(--color-text-strong)] sm:text-right">{value}</dd>
    </div>
  );
}

/**
 * Runtime AI control and a read-only view of workflow policy.
 *
 * Workflow figures come from process configuration; they are not editable here.
 * Secrets never appear on this screen.
 */
export function OperationalSettingsPage() {
  const snapshot = useOperationalSettings();
  const [modal, setModal] = useState<'engage' | 'clear' | null>(null);

  const ai = snapshot.data?.ai;
  const workflow = snapshot.data?.workflow;
  const killEngaged = ai?.kill_switch_effective ?? false;

  return (
    <div className="flex flex-col gap-[var(--space-6)]">
      <PageHeader
        title="Operational settings"
        purpose="Trip or clear the AI kill switch, and review the workflow policy this process is running with. Secrets and credentials are not shown."
      />

      {snapshot.isLoading ? (
        <SkeletonText lines={8} />
      ) : snapshot.isError ? (
        <p role="alert" className="m-0 text-[var(--color-danger-700)]">
          {errorMessage(snapshot.error) ?? 'Operational settings could not be loaded.'}
        </p>
      ) : ai && workflow ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle as="h2" className="flex items-center gap-2">
                <Power
                  aria-hidden="true"
                  className="size-[18px] text-[var(--color-primary-600)]"
                />
                AI kill switch
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-[var(--space-4)]">
              <div className="flex flex-wrap items-center gap-[var(--space-3)]">
                <ToneBadge
                  label={killEngaged ? 'Engaged' : 'Clear'}
                  tone={killEngaged ? 'danger' : 'success'}
                />
                <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                  {killEngaged
                    ? 'Assistive reading is not calling a model. Manual workflows are unaffected.'
                    : ai.enabled
                      ? 'Assistive reading may call the configured models when needed.'
                      : 'AI is disabled by configuration, even with the kill switch clear.'}
                </p>
              </div>
              <dl className="m-0 flex flex-col gap-[var(--space-3)]">
                <SnapshotRow label="Configuration enabled" value={ai.enabled ? 'Yes' : 'No'} />
                <SnapshotRow
                  label="Kill switch (environment)"
                  value={ai.kill_switch_env ? 'Engaged' : 'Clear'}
                />
                <SnapshotRow
                  label="Kill switch (effective)"
                  value={ai.kill_switch_effective ? 'Engaged' : 'Clear'}
                />
                <SnapshotRow label="Extraction model" value={ai.model_extraction} />
                <SnapshotRow label="Classification model" value={ai.model_classification} />
              </dl>
              <div className="flex flex-wrap gap-[var(--space-3)]">
                {killEngaged ? (
                  <Button type="button" variant="secondary" onClick={() => setModal('clear')}>
                    Clear kill switch
                  </Button>
                ) : (
                  <Button type="button" variant="danger" onClick={() => setModal('engage')}>
                    Engage kill switch
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h2" className="flex items-center gap-2">
                <SlidersHorizontal
                  aria-hidden="true"
                  className="size-[18px] text-[var(--color-primary-600)]"
                />
                Workflow snapshot
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p
                className={cn(
                  'mb-[var(--space-4)] m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]',
                )}
              >
                Read-only. These values come from process configuration and are not
                changed from this screen.
              </p>
              <dl className="m-0 flex flex-col gap-[var(--space-3)]">
                <SnapshotRow
                  label="Reminder interval"
                  value={`${workflow.reminder_interval_hours} working hours`}
                />
                <SnapshotRow
                  label="Reminder maximum"
                  value={String(workflow.reminder_max_count)}
                />
                <SnapshotRow label="Display timezone" value={workflow.display_timezone} />
                <SnapshotRow label="Base currency" value={workflow.base_currency} />
                <SnapshotRow
                  label="Invoice tolerance"
                  value={`${workflow.invoice_tolerance_percent}% or ${workflow.invoice_tolerance_minor_units} minor units`}
                />
                <SnapshotRow
                  label="Sign-off link TTL"
                  value={`${workflow.sign_off_link_ttl_hours} hours`}
                />
                <SnapshotRow
                  label="Vendor check-in link TTL"
                  value={`${workflow.vendor_check_in_link_ttl_hours} hours`}
                />
                <SnapshotRow
                  label="Generic link TTL"
                  value={`${workflow.link_ttl_seconds} seconds`}
                />
              </dl>
            </CardContent>
          </Card>
        </>
      ) : null}

      <KillSwitchModal
        open={modal !== null}
        engage={modal === 'engage'}
        onClose={() => setModal(null)}
      />
    </div>
  );
}
