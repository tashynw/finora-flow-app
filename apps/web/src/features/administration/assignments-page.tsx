import { useMemo, useState } from 'react';
import { UserPlus, UsersRound } from 'lucide-react';

import type { ApprovalAssignmentOut, ApprovalLevel } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import { usePeople } from '@/features/administration/use-people';
import {
  useAssignLevel,
  useAssignments,
  useUnassignLevel,
} from '@/features/administration/use-administration';

/**
 * Who holds each approval level.
 *
 * Grouped by level rather than by person, because the question this screen
 * answers is "is anybody a Manager for Facilities", not "what does Ada do". A
 * level with nobody in it is a route that stops dead at submission time, so an
 * empty level is stated rather than merely absent from the list.
 */
const LEVELS: { id: ApprovalLevel; label: string }[] = [
  { id: 'unit_head', label: 'Unit Head' },
  { id: 'manager', label: 'Manager' },
  { id: 'hod', label: 'Head of Department' },
  { id: 'coo', label: 'COO' },
];

export function AssignmentsPage() {
  const [adding, setAdding] = useState<ApprovalLevel | null>(null);
  const [removing, setRemoving] = useState<ApprovalAssignmentOut | null>(null);

  const { data: assignments, isLoading, isError, error } = useAssignments();
  const unassign = useUnassignLevel();

  const byLevel = useMemo(() => {
    const groups = new Map<ApprovalLevel, ApprovalAssignmentOut[]>(
      LEVELS.map((level) => [level.id, []]),
    );
    for (const row of assignments ?? []) {
      groups.get(row.level)?.push(row);
    }
    return groups;
  }, [assignments]);

  return (
    <>
      <PageHeader
        title="Who approves what"
        purpose="The people behind each level in the approval matrix. A level with nobody in it stops every route that reaches it."
      />

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not load the assignments
            </p>
            <p className="mt-2 m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              {errorMessage(error) ?? 'The request did not complete.'}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {isLoading ? (
        <Card>
          <CardContent>
            <SkeletonText lines={8} />
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-[var(--space-5)]">
          {LEVELS.map((level) => {
            const holders = byLevel.get(level.id) ?? [];
            return (
              <Card key={level.id} className={cn(holders.length === 0 && 'border-[var(--color-warning-600)]')}>
                <CardHeader className="flex-row items-start justify-between gap-[var(--space-4)]">
                  <div>
                    <CardTitle>{level.label}</CardTitle>
                    <CardDescription>
                      {holders.length === 0
                        ? 'Nobody holds this level. Anything routed to it cannot be approved by anyone, and will sit until somebody is put here.'
                        : `${holders.length} ${holders.length === 1 ? 'person' : 'people'}.`}
                    </CardDescription>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => setAdding(level.id)}>
                    <UserPlus aria-hidden="true" className="size-4" />
                    Add somebody
                  </Button>
                </CardHeader>
                <CardContent className="p-0">
                  {holders.length === 0 ? (
                    <EmptyState
                      icon={UsersRound}
                      title="Nobody at this level"
                      explanation="The matrix can route work here, and when it does the work will wait indefinitely."
                      nextStep="Put at least one person at this level, or retire the rules that route to it."
                      action={{ label: 'Add somebody', onClick: () => setAdding(level.id) }}
                    />
                  ) : (
                    <ul className="m-0 list-none p-0">
                      {holders.map((row) => (
                        <li
                          key={row.id}
                          className="flex flex-col gap-[var(--space-2)] border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0 sm:flex-row sm:items-center"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="m-0 font-semibold text-[var(--color-text-strong)]">
                              {row.user_name}
                            </p>
                            <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                              {row.user_email}
                              {row.department ? ` · ${row.department} only` : ' · everywhere'}
                            </p>
                          </div>

                          <div className="flex shrink-0 flex-wrap items-center gap-[var(--space-3)]">
                            {/* Cover is shown here as well as on its own screen.
                                Somebody checking whether a level is staffed is
                                really asking whether the work will be decided,
                                and an approver who is away is only staffed if
                                somebody is standing in. */}
                            {row.is_covered_by_name ? (
                              <ToneBadge
                                label={`Covered by ${row.is_covered_by_name}`}
                                tone="progress"
                              />
                            ) : null}
                            {!row.is_active ? <ToneBadge label="Account closed" tone="danger" /> : null}
                            <Button variant="ghost" size="sm" onClick={() => setRemoving(row)}>
                              Remove
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <AssignDialog
        level={adding}
        onClose={() => setAdding(null)}
      />

      <Modal
        open={removing !== null}
        onClose={() => {
          setRemoving(null);
          unassign.reset();
        }}
        title="Remove this person from the level"
        description={
          removing
            ? `${removing.user_name} stops being offered as an approver at this level. Anything already waiting on them personally stays with them until it is decided or reassigned.`
            : ''
        }
        busy={unassign.isPending}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)} disabled={unassign.isPending}>
              Back
            </Button>
            <Button
              variant="danger"
              isLoading={unassign.isPending}
              loadingLabel="Removing"
              onClick={() => {
                if (!removing) return;
                unassign.mutate(
                  { assignmentId: removing.id },
                  { onSuccess: () => setRemoving(null) },
                );
              }}
            >
              Remove them
            </Button>
          </>
        }
      >
        {unassign.isError ? (
          <p role="alert" className="m-0 text-[var(--text-body-sm)] text-[var(--color-danger-700)]">
            {errorMessage(unassign.error)}
          </p>
        ) : null}
      </Modal>
    </>
  );
}

function AssignDialog({
  level,
  onClose,
}: {
  level: ApprovalLevel | null;
  onClose: () => void;
}) {
  const [userId, setUserId] = useState('');
  const [department, setDepartment] = useState('');

  const { data: people } = usePeople();
  const assign = useAssignLevel();

  const label = LEVELS.find((option) => option.id === level)?.label ?? '';
  const chosen = people?.find((person) => person.id === userId);

  return (
    <Modal
      open={level !== null}
      onClose={() => {
        setUserId('');
        setDepartment('');
        assign.reset();
        onClose();
      }}
      title={`Add somebody as ${label}`}
      description="They can decide anything the matrix routes to this level from now on. Work already waiting is not reassigned."
      busy={assign.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={assign.isPending}>
            Back
          </Button>
          <Button
            variant="primary"
            disabled={!userId || !level}
            isLoading={assign.isPending}
            loadingLabel="Adding"
            onClick={() => {
              if (!level || !userId) return;
              assign.mutate(
                { userId, level, department },
                {
                  onSuccess: () => {
                    setUserId('');
                    setDepartment('');
                    onClose();
                  },
                },
              );
            }}
          >
            Add them
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[var(--space-5)]">
        {assign.isError ? (
          <p role="alert" className="m-0 text-[var(--text-body-sm)] text-[var(--color-danger-700)]">
            {errorMessage(assign.error)}
          </p>
        ) : null}

        <Field
          label="Who"
          required
          help="Only people with an open account are listed."
          error={
            chosen && !chosen.may_decide
              ? 'This person cannot record an approval decision, so putting them at a level would leave the level unstaffed in practice. Give them an approver role first.'
              : undefined
          }
        >
          {({ inputId, describedBy, invalid }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              value={userId}
              disabled={assign.isPending}
              onChange={(event) => setUserId(event.target.value)}
            >
              <option value="">Choose somebody</option>
              {(people ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name} — {person.email}
                  {person.may_decide ? '' : ' (cannot approve)'}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label="Department"
          help="Leave empty and they hold this level everywhere. Naming one limits them to records from it."
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={department}
              maxLength={200}
              disabled={assign.isPending}
              onChange={(event) => setDepartment(event.target.value)}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}
