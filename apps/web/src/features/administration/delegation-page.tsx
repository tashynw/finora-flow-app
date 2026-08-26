import { useEffect, useMemo, useState } from 'react';
import { UserRoundCheck } from 'lucide-react';

import type { ApprovalDelegationOut } from '@finora/shared-types';

import { errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { useAuth } from '@/features/auth/auth-context';
import { PageHeader } from '@/features/shared/page-header';
import { usePeople } from '@/features/administration/use-people';
import { useDelegations, useSetCover } from '@/features/administration/use-administration';

/**
 * Cover while an approver is away.
 *
 * Two people reach this screen for different reasons. An approver arranges their
 * own cover before going away. An administrator arranges somebody else's, which
 * is what has to happen when the approver is already gone and did not set it up
 * — the case that otherwise leaves a queue stopped for a fortnight.
 *
 * Your own arrangement is at the top and separate, because it is the one thing
 * most people come here to do and hunting for your own name in a list of
 * everybody is a poor way to spend the minute before annual leave.
 */
/**
 * The day cover ends, in the reader's own timezone.
 *
 * A day rather than a moment. Cover is stored as the last instant of a day, and
 * "until 5 Aug 2026, 23:59" invites the reader to wonder what happens at 23:58.
 */
function endsOn(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** Somebody with no arrangement yet, in the shape one would have. */
function noCoverYet(userId: string, name: string): ApprovalDelegationOut {
  return {
    user_id: userId,
    user_name: name,
    delegate_to_id: null,
    delegate_to_name: null,
    out_of_office_until: null,
    is_in_effect: false,
  };
}

export function DelegationPage() {
  const { user, can } = useAuth();
  const [editing, setEditing] = useState<ApprovalDelegationOut | null>(null);

  const { data, isLoading, isError, error } = useDelegations();
  const { data: people } = usePeople();
  const administers = can('admin:approval_matrix');

  const arranged = useMemo(
    () => new Map((data ?? []).map((row) => [row.user_id, row])),
    [data],
  );

  // Present whether or not anything has been arranged. The endpoint returns only
  // people who already have cover, which is the right answer to "who is covered"
  // and the wrong basis for a screen: somebody who has never arranged cover is
  // exactly the person who has come here to arrange some.
  const mine = useMemo(() => {
    if (!user) return null;
    return arranged.get(user.id) ?? noCoverYet(user.id, user.display_name);
  }, [arranged, user]);

  // Everybody who can decide, not merely everybody already covered. An
  // administrator's reason for being on this screen is usually that an approver
  // left without arranging anything and a queue has stopped, and a list of
  // people who planned ahead cannot contain the person who did not.
  const others = useMemo(() => {
    const candidates = (people ?? []).filter(
      (person) => person.may_decide && person.id !== user?.id,
    );
    return candidates.map(
      (person) => arranged.get(person.id) ?? noCoverYet(person.id, person.name),
    );
  }, [arranged, people, user?.id]);

  const inEffect = others.filter((row) => row.is_in_effect);

  return (
    <>
      <PageHeader
        title="Cover while away"
        purpose="Who decides in an approver's place while they are away. Cover does not change what the matrix asks for; it changes who is asked."
      />

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not load the arrangements
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
            <SkeletonText lines={6} />
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-[var(--space-6)]">
          {mine && can('approval:delegate') ? (
            <Card>
              <CardHeader className="flex-row items-start justify-between gap-[var(--space-4)]">
                <div>
                  <CardTitle>Your cover</CardTitle>
                  <CardDescription>
                    {mine.is_in_effect
                      ? `${mine.delegate_to_name} is deciding in your place until the end of ${endsOn(mine.out_of_office_until)}. Anything routed to you goes to them.`
                      : mine.delegate_to_name
                        ? `${mine.delegate_to_name} is named as your cover, but it is not in effect. Set a return date in the future to start it.`
                        : 'Nobody is covering for you. Work routed to you waits until you decide it.'}
                  </CardDescription>
                </div>
                <Button variant="secondary" size="sm" onClick={() => setEditing(mine)}>
                  <UserRoundCheck aria-hidden="true" className="size-4" />
                  {mine.is_in_effect ? 'Change or end it' : 'Arrange cover'}
                </Button>
              </CardHeader>
            </Card>
          ) : null}

          {administers ? (
            <Card>
              <CardHeader>
                <CardTitle>Everybody else</CardTitle>
                <CardDescription>
                  Everybody who can decide something, and who is standing in for them.{' '}
                  {inEffect.length > 0
                    ? `${inEffect.length} ${inEffect.length === 1 ? 'person is' : 'people are'} being covered right now.`
                    : 'Nobody is being covered right now.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {others.length === 0 ? (
                  <EmptyState
                    icon={UserRoundCheck}
                    title="Nobody else can decide anything"
                    explanation="Cover stands somebody in for an approver, so there is nobody to arrange it for until at least one other person holds a level."
                    nextStep="Put somebody at a level first, on the screen for who approves what."
                  />
                ) : (
                  <ul className="m-0 list-none p-0">
                    {others.map((row) => (
                      <li
                        key={row.user_id}
                        className="flex flex-col gap-[var(--space-2)] border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0 sm:flex-row sm:items-center"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="m-0 font-semibold text-[var(--color-text-strong)]">
                            {row.user_name}
                          </p>
                          <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                            {row.delegate_to_name
                              ? `Covered by ${row.delegate_to_name}${
                                  row.out_of_office_until
                                    ? ` until the end of ${endsOn(row.out_of_office_until)}`
                                    : ''
                                }`
                              : 'No cover arranged'}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-[var(--space-3)]">
                          {row.is_in_effect ? (
                            <ToneBadge label="In effect" tone="progress" />
                          ) : row.delegate_to_name ? (
                            <ToneBadge label="Not in effect" tone="neutral" />
                          ) : null}
                          <Button variant="ghost" size="sm" onClick={() => setEditing(row)}>
                            {row.delegate_to_name ? 'Change' : 'Arrange'}
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}

      <CoverDialog subject={editing} onClose={() => setEditing(null)} />
    </>
  );
}

/**
 * The date input takes a date, not a datetime.
 *
 * Cover ends at the end of a day, not at 14:32 on it, and asking somebody to
 * pick a minute invites them to pick the wrong one and come back to a queue that
 * stopped an hour before they landed. The end of the chosen day is sent.
 */
function endOfDay(date: string): string {
  return new Date(`${date}T23:59:59`).toISOString();
}

function dateValue(iso: string | null): string {
  if (!iso) return '';
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function CoverDialog({
  subject,
  onClose,
}: {
  subject: ApprovalDelegationOut | null;
  onClose: () => void;
}) {
  const [delegateId, setDelegateId] = useState('');
  const [until, setUntil] = useState('');

  const { data: people } = usePeople();
  const setCover = useSetCover();

  useEffect(() => {
    if (!subject) return;
    setDelegateId(subject.delegate_to_id ?? '');
    setUntil(dateValue(subject.out_of_office_until));
  }, [subject]);

  const chosen = people?.find((person) => person.id === delegateId);
  const isSelf = subject !== null && delegateId === subject.user_id;
  const clearing = delegateId === '' && until === '';

  const close = () => {
    setCover.reset();
    onClose();
  };

  return (
    <Modal
      open={subject !== null}
      onClose={close}
      title={subject ? `Cover for ${subject.user_name}` : ''}
      description="Anything the matrix routes to this person goes to their cover instead, until the return date passes. The record still shows who actually decided it."
      busy={setCover.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={setCover.isPending}>
            Back
          </Button>
          <Button
            variant="primary"
            disabled={isSelf || (!clearing && (!delegateId || !until))}
            isLoading={setCover.isPending}
            loadingLabel="Saving"
            onClick={() => {
              if (!subject) return;
              setCover.mutate(
                {
                  userId: subject.user_id,
                  delegateToId: clearing ? null : delegateId,
                  outOfOfficeUntil: clearing ? null : endOfDay(until),
                },
                { onSuccess: close },
              );
            }}
          >
            {clearing ? 'End the cover' : 'Save it'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[var(--space-5)]">
        {setCover.isError ? (
          <p role="alert" className="m-0 text-[var(--text-body-sm)] text-[var(--color-danger-700)]">
            {errorMessage(setCover.error)}
          </p>
        ) : null}

        <Field
          label="Who decides instead"
          help="Clear both boxes to end the arrangement. Cover does not chain: if this person is themselves away, work waits rather than moving on again."
          error={
            isSelf
              ? 'Somebody cannot cover for themselves. That would leave the work exactly where it is.'
              : chosen && !chosen.may_decide
                ? 'This person cannot record an approval decision, so nothing routed to them could be decided.'
                : undefined
          }
        >
          {({ inputId, describedBy, invalid }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              value={delegateId}
              disabled={setCover.isPending}
              onChange={(event) => setDelegateId(event.target.value)}
            >
              <option value="">Nobody</option>
              {(people ?? [])
                .filter((person) => person.id !== subject?.user_id)
                .map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name} — {person.email}
                    {person.may_decide ? '' : ' (cannot approve)'}
                  </option>
                ))}
            </Select>
          )}
        </Field>

        <Field
          label="Back on"
          help="Cover ends at the end of this day. After that, work routes to them as usual again."
        >
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              type="date"
              aria-describedby={describedBy}
              invalid={invalid}
              value={until}
              disabled={setCover.isPending}
              onChange={(event) => setUntil(event.target.value)}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}
