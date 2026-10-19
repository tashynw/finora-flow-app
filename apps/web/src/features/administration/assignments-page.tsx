import { useMemo, useState } from 'react';
import { UserPlus, UsersRound } from 'lucide-react';

import type { ApprovalAssignmentOut, ApprovalLevel, ApprovalPersonOut } from '@finora/shared-types';

import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Combobox } from '@/components/ui/combobox';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import { useDepartmentSearch } from '@/features/administration/use-departments';
import { usePeopleSearch } from '@/features/administration/use-people';
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

function scopeOf(holders: ApprovalAssignmentOut[]): string {
  const scoped = holders.filter((row) => row.department).length;
  if (scoped === 0) return 'business-wide';
  if (scoped === holders.length) return 'scoped by department';
  return `${scoped} scoped by department`;
}

export function AssignmentsPage() {
  const [adding, setAdding] = useState<ApprovalLevel | null>(null);
  const [removing, setRemoving] = useState<ApprovalAssignmentOut | null>(null);

  const [expanded, setExpanded] = useState<Set<ApprovalLevel>>(() => new Set());

  const { data: assignments, isLoading, isError, error } = useAssignments();
  const unassign = useUnassignLevel();

  const toggle = (level: ApprovalLevel) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });

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
        purpose="People assigned to each approval level and scope. A level with nobody in it stops every route that reaches it."
      />

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not load the assignments
            </p>
            <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
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
        <div className="flex flex-col gap-[var(--space-6)]">
          {LEVELS.map((level) => {
            const holders = byLevel.get(level.id) ?? [];
            const open = holders.length === 0 || expanded.has(level.id);
            const panelId = `level-${level.id}-holders`;
            return (
              <Card
                key={level.id}
                className={cn(holders.length === 0 && 'border-[var(--color-warning-600)]')}
              >
                <div className="flex flex-col gap-[var(--space-3)] px-[var(--space-5)] py-[var(--space-5)] sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <CardTitle>{level.label}</CardTitle>
                    <p
                      className={cn(
                        'm-0 mt-2.5 text-[11px]',
                        holders.length === 0
                          ? 'text-[var(--color-warning-700)]'
                          : 'text-[var(--color-text-muted)]',
                      )}
                    >
                      {holders.length === 0
                        ? 'Nobody holds this level. Anything routed to it cannot be approved by anyone, and will sit until somebody is put here.'
                        : `${holders.length} assigned · ${scopeOf(holders)}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-[var(--space-2)]">
                    {open ? (
                      <Button variant="secondary" size="sm" onClick={() => setAdding(level.id)}>
                        <UserPlus aria-hidden="true" className="size-4" />
                        Add somebody
                      </Button>
                    ) : null}
                    {holders.length > 0 ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-expanded={open}
                        aria-controls={panelId}
                        onClick={() => toggle(level.id)}
                      >
                        {open ? 'Done' : 'Manage assignments'}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {open ? (
                <div id={panelId} className="border-t border-[var(--color-divider)]">
                  {holders.length === 0 ? (
                    <EmptyState
                      titleAs="h3"
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
                          className="flex flex-col gap-[var(--space-2)] border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-3)] last:border-b-0 sm:flex-row sm:items-center"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="m-0 text-[12px] font-semibold text-[var(--color-text-strong)]">
                              {row.user_name}
                            </p>
                            <p className="m-0 text-[11px] text-[var(--color-text-muted)]">
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
                </div>
                ) : null}
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
                  {
                    onSuccess: () => {
                      toast.success('They have been removed from this level.');
                      setRemoving(null);
                    },
                    onError: (error) => {
                      toast.error(
                        errorMessage(error) ?? 'They could not be removed from this level.',
                      );
                    },
                  },
                );
              }}
            >
              Remove them
            </Button>
          </>
        }
      >
        {unassign.isError ? (
          <p role="alert" className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-danger-700)]">
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
  const [chosen, setChosen] = useState<ApprovalPersonOut | null>(null);
  const [department, setDepartment] = useState('');
  const [whoQuery, setWhoQuery] = useState('');
  const [departmentQuery, setDepartmentQuery] = useState('');
  const [whoError, setWhoError] = useState('');

  const people = usePeopleSearch(whoQuery, level !== null);
  const departments = useDepartmentSearch(departmentQuery, level !== null);
  const assign = useAssignLevel();

  const label = LEVELS.find((option) => option.id === level)?.label ?? '';

  function resetForm() {
    setUserId('');
    setChosen(null);
    setDepartment('');
    setWhoQuery('');
    setDepartmentQuery('');
    setWhoError('');
  }

  return (
    <Modal
      open={level !== null}
      onClose={() => {
        resetForm();
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
            isLoading={assign.isPending}
            loadingLabel="Adding"
            onClick={() => {
              if (!level || !userId) {
                setWhoError('Choose somebody.');
                return;
              }
              if (chosen && !chosen.may_decide) return;
              setWhoError('');
              assign.mutate(
                { userId, level, department },
                {
                  onSuccess: () => {
                    toast.success('They have been added to this level.');
                    resetForm();
                    onClose();
                  },
                  onError: (error) => {
                    toast.error(
                      errorMessage(error) ?? 'They could not be added to this level.',
                    );
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
          <p role="alert" className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-danger-700)]">
            {errorMessage(assign.error)}
          </p>
        ) : null}

        <Field
          label="Who"
          required
          help="Type a name or email. Only open accounts are searched."
          error={
            whoError
              ? whoError
              : chosen && !chosen.may_decide
                ? 'This person cannot record an approval decision, so putting them at a level would leave the level unstaffed in practice. Give them an approver role first.'
                : undefined
          }
        >
          {({ inputId, describedBy, invalid }) => (
            <Combobox
              key={`who-${level ?? 'closed'}`}
              id={inputId}
              describedBy={describedBy}
              invalid={invalid}
              value={userId}
              disabled={assign.isPending}
              placeholder="Search by name or email"
              emptyLabel="No one matches that."
              clearLabel="Clear"
              idleLabel="No open accounts yet"
              searching={people.isFetching}
              onSearch={setWhoQuery}
              onChange={(id) => {
                setUserId(id);
                setWhoError('');
                setChosen(people.data?.find((person) => person.id === id) ?? null);
              }}
              items={(people.data ?? []).map((person) => ({
                value: person.id,
                label: `${person.name} — ${person.email}${person.may_decide ? '' : ' (cannot approve)'}`,
              }))}
            />
          )}
        </Field>

        <Field
          label="Department"
          help="All departments means they hold this level everywhere. Type to limit them to one."
        >
          {({ inputId, describedBy }) => (
            <Combobox
              key={`department-${level ?? 'closed'}`}
              id={inputId}
              describedBy={describedBy}
              value={department}
              disabled={assign.isPending}
              placeholder="All departments"
              emptyLabel="No department matches that."
              clearLabel="All departments"
              idleLabel="No departments yet"
              searching={departments.isFetching}
              onSearch={setDepartmentQuery}
              onChange={setDepartment}
              items={(departments.data ?? []).map((row) => ({
                value: row.costCentreNumber,
                label: `${row.name} · ${row.costCentreNumber}`,
              }))}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}
