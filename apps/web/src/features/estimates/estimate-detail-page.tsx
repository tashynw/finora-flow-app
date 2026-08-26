import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, Ban, Save, Send, Undo2 } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import type { EstimateDetail } from '@finora/shared-types';

import { ApiError, errorMessage } from '@/lib/api-client';
import { formatMoment } from '@/lib/dates';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';
import { WORKFLOW_STATE_DESCRIPTIONS } from '@/lib/workflow';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import { ReasonDialog } from '@/features/shared/reason-dialog';
import { ApprovalRoute, PlannedRoute } from '@/features/estimates/approval-route';
import { DecisionPanel } from '@/features/estimates/decision-panel';
import { EstimateDetails } from '@/features/estimates/estimate-details';
import {
  EstimateForm,
  type EstimateFormValues,
  draftFrom,
  isBlankDraft,
  isSameDraft,
  valuesFrom,
} from '@/features/estimates/estimate-form';
import {
  useCancelEstimate,
  useDecideEstimate,
  useEstimate,
  useReferenceData,
  useSaveEstimate,
  useSubmitEstimate,
  useWithdrawEstimate,
} from '@/features/estimates/use-estimates';

/**
 * One estimate: its details, what is outstanding, and its approval route.
 *
 * The page has one job for each person who opens it. A requester is here to
 * finish a draft and send it, so the form and the list of what is missing take
 * the main column. An approver is here to decide, so the route and the decision
 * sit beside it with the figure they are deciding on. Nobody is asked which of
 * those they are: both are on the page, and whichever does not apply is absent
 * rather than disabled.
 *
 * Every control is enabled from the server's `actions` block. The rules behind
 * them — who may withdraw, whether a route can be planned at all, whether this
 * person submitted it and so cannot approve it — are not reimplemented here, so a
 * control that looks available is.
 */

/**
 * Form fields whose name differs from the field the server points at.
 *
 * The total is one control here and a pair of columns there, and the supplier is
 * a picker plus an optional name. Every other name matches, which is worth
 * keeping true.
 */
const SERVER_FIELD: Partial<Record<keyof EstimateFormValues, string>> = {
  vendorId: 'vendor_name',
  vendorName: 'vendor_name',
  estimateDate: 'estimate_date',
  neededBy: 'needed_by',
  costCentreId: 'cost_centre_id',
  amount: 'total',
  currency: 'total',
};

/** The editable state, and the saved record it was filled from. */
interface Editor {
  baseline: string;
  values: EstimateFormValues;
  /** Boxes edited since the last save, whose saved problems no longer apply. */
  touched: Set<string>;
  /**
   * Whether the outstanding fields are marked on the form itself.
   *
   * False on a blank estimate nobody has typed into, and true from the first
   * time the requester asks the system to do something with it. Saving or sending
   * is the point at which they have offered the draft up for checking, and the
   * point at which marking the gaps is help rather than accusation.
   */
  flagged: boolean;
}

export function EstimateDetailPage() {
  const { estimateId } = useParams<{ estimateId: string }>();
  const { data: estimate, isLoading, isError, error } = useEstimate(estimateId);
  const { data: reference } = useReferenceData();

  const save = useSaveEstimate(estimateId);
  const submit = useSubmitEstimate(estimateId);
  const withdraw = useWithdrawEstimate(estimateId);
  const cancel = useCancelEstimate(estimateId);
  const decide = useDecideEstimate(estimateId);

  const [editor, setEditor] = useState<Editor | null>(null);
  const [dialog, setDialog] = useState<'withdraw' | 'cancel' | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Refilled when a different estimate is opened, or when this one moves state:
  // submitting, withdrawing and cancelling all change what the form should hold.
  // An ordinary save does not, because the boxes already contain what was saved.
  const baseline = estimate ? `${estimate.id}:${estimate.state}` : '';
  if (estimate && editor?.baseline !== baseline) {
    setEditor({
      baseline,
      values: valuesFrom(estimate),
      touched: new Set(),
      // An estimate with anything already on it — reopened from drafts, or raised
      // from a document the reader extracted — is one whose gaps are worth
      // marking straight away. Only a genuinely empty one starts unmarked.
      flagged: !isBlankDraft(draftFrom(valuesFrom(estimate))),
    });
    // The save note says nobody else can see this yet, which is true of a draft
    // and false the moment the estimate moves. Sending for approval saves first,
    // so without this the note survives its own becoming untrue.
    setSavedAt(null);
  }

  const savedDraft = useMemo(() => (estimate ? draftFrom(valuesFrom(estimate)) : null), [estimate]);

  // Worked out before the early returns below, because the guard on leaving the
  // page is a hook and a hook cannot be called conditionally.
  const dirty = Boolean(
    estimate?.actions.may_edit &&
      savedDraft &&
      editor &&
      !isSameDraft(savedDraft, draftFrom(editor.values)),
  );
  const leaving = useUnsavedChanges(dirty);

  if (isLoading || (!estimate && !isError)) {
    return (
      <>
        <PageHeader title="Estimate" purpose="Opening this estimate." />
        <Card>
          <CardContent>
            <SkeletonText lines={8} />
          </CardContent>
        </Card>
      </>
    );
  }

  if (!estimate || !savedDraft || !editor) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <>
        <PageHeader
          title="Estimate"
          purpose="This estimate could not be opened."
          actions={
            <Button variant="secondary" asChild>
              <Link to="/estimates">
                <ArrowLeft aria-hidden="true" className="size-4" />
                Back to estimates
              </Link>
            </Button>
          }
        />
        <Card className="border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              {missing ? 'That estimate could not be found' : 'Could not load this estimate'}
            </p>
            <p className="mt-2 m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              {missing
                ? 'It may have been raised by somebody else, in which case it is not yours to see.'
                : (errorMessage(error) ?? 'The request did not complete.')}
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  const actions = estimate.actions;
  const currentDraft = draftFrom(editor.values);
  const busy = save.isPending || submit.isPending;

  const current = editor;

  function handleChange(next: EstimateFormValues) {
    const touched = new Set(current.touched);
    for (const key of Object.keys(next) as (keyof EstimateFormValues)[]) {
      if (next[key] !== current.values[key]) touched.add(SERVER_FIELD[key] ?? key);
    }
    setEditor({ ...current, values: next, touched });
  }

  function persist(then?: () => void) {
    setSavedAt(null);
    save.mutate(currentDraft, {
      onSuccess: () => {
        // The boxes already hold what was saved, so only the record of which of
        // them have been touched needs clearing: the problems the server just
        // returned are about exactly these values.
        setEditor({ ...current, touched: new Set(), flagged: true });
        setSavedAt(new Date().toISOString());
        then?.();
      },
    });
  }

  function sendForApproval() {
    setEditor({ ...current, flagged: true });
    // Saved first when there are unsaved changes, so the button means what it
    // says. Asking somebody to press Save and then Send, and refusing the send
    // because they pressed only one, is a rule about this software rather than
    // about approving spending.
    if (dirty) persist(() => submit.mutate(undefined));
    else submit.mutate(undefined);
  }

  return (
    <>
      <PageHeader
        title={estimate.reference}
        purpose={purposeFor(estimate)}
        meta={
          <div className="flex flex-wrap items-center gap-[var(--space-3)]">
            <StatusBadge state={estimate.state} />
            <span className="text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              Raised by {estimate.requester_label} ·{' '}
              <time dateTime={estimate.created_at} data-visual-volatile>
                {formatMoment(estimate.created_at)}
              </time>
            </span>
          </div>
        }
        actions={
          <>
            <Button variant="ghost" asChild>
              <Link to="/estimates">
                <ArrowLeft aria-hidden="true" className="size-4" />
                All estimates
              </Link>
            </Button>

            {actions.may_edit ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => persist()}
                  disabled={!dirty || busy}
                  isLoading={save.isPending}
                  loadingLabel="Saving"
                >
                  <Save aria-hidden="true" className="size-4" />
                  Save draft
                </Button>
                <Button
                  variant="primary"
                  onClick={sendForApproval}
                  // Enabled while there are unsaved changes even when the saved
                  // version is incomplete, because the changes may be what
                  // completes it. The server decides after the save.
                  disabled={busy || (!actions.may_submit && !dirty)}
                  isLoading={submit.isPending}
                  loadingLabel="Sending"
                >
                  <Send aria-hidden="true" className="size-4" />
                  Send for approval
                </Button>
              </>
            ) : null}

            {actions.may_withdraw ? (
              <Button variant="secondary" onClick={() => setDialog('withdraw')}>
                <Undo2 aria-hidden="true" className="size-4" />
                Withdraw
              </Button>
            ) : null}

            {actions.may_cancel ? (
              <Button variant="ghost" onClick={() => setDialog('cancel')}>
                <Ban aria-hidden="true" className="size-4" />
                Cancel
              </Button>
            ) : null}
          </>
        }
      />

      {/* One region for the outcome of whatever was just pressed, so a screen
          reader hears it once instead of hearing several panels re-announce. */}
      <div aria-live="polite">
        {save.error || submit.error ? (
          <Card className="mb-[var(--space-5)] border-[var(--color-danger-600)]">
            <CardContent>
              <p className="m-0 font-semibold text-[var(--color-danger-700)]">
                {submit.error ? 'This was not sent for approval' : 'Your changes were not saved'}
              </p>
              <p className="mt-2 m-0 text-[var(--text-body-sm)] text-[var(--color-text)]">
                {errorMessage(submit.error ?? save.error)}
              </p>
              <p className="mt-2 m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                {submit.error
                  ? 'Nothing has gone to an approver, and what you have typed is still here.'
                  : 'What you have typed is still on the screen. Nothing was lost.'}
              </p>
            </CardContent>
          </Card>
        ) : savedAt && !dirty ? (
          <p className="mb-[var(--space-5)] m-0 text-[var(--text-body-sm)] text-[var(--color-success-700)]">
            Draft saved at{' '}
            {/* Fixed width so a longer clock reading cannot shift the rest of
                the sentence when the visual suite hides the time. */}
            <time
              dateTime={savedAt}
              data-visual-volatile
              className="inline-block w-[12rem] overflow-hidden align-bottom"
            >
              {formatMoment(savedAt)}
            </time>
            . Nobody else sees it until you send it for approval.
          </p>
        ) : null}
      </div>

      <div className="grid gap-[var(--space-6)] xl:grid-cols-[minmax(0,3fr)_minmax(21rem,2fr)]">
        <div className="flex min-w-0 flex-col gap-[var(--space-6)]">
          {actions.may_edit && estimate.problems.length > 0 ? (
            <Card className="border-[color-mix(in_srgb,var(--color-warning-600)_38%,white)]">
              <CardHeader>
                <CardTitle>
                  <span className="inline-flex items-center gap-[var(--space-2)]">
                    <AlertTriangle
                      aria-hidden="true"
                      className="size-4 text-[var(--color-warning-600)]"
                    />
                    Before this can go for approval
                  </span>
                </CardTitle>
                <CardDescription>
                  All of it at once, so you can finish in one pass rather than one refusal at a
                  time.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="m-0 flex list-disc flex-col gap-[var(--space-2)] pl-[var(--space-5)]">
                  {estimate.problems.map((problem) => (
                    <li
                      key={problem.problem}
                      className="text-[var(--text-body-sm)] text-[var(--color-text)]"
                    >
                      {problem.explanation}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{actions.may_edit ? 'The request' : 'What was requested'}</CardTitle>
              <CardDescription>
                {actions.may_edit
                  ? 'Saved when you press Save draft, and again when you send it for approval.'
                  : 'As it stood when it was sent for approval. Editing it again means withdrawing it first.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {actions.may_edit ? (
                <EstimateForm
                  values={editor.values}
                  onChange={handleChange}
                  reference={reference}
                  problems={editor.flagged ? fieldProblems(estimate) : {}}
                  touched={editor.touched}
                  disabled={busy}
                />
              ) : (
                <EstimateDetails estimate={estimate} />
              )}
            </CardContent>
          </Card>

          {estimate.transitions.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>History</CardTitle>
                <CardDescription>
                  Every state this estimate has been in, who moved it and why. Newest first.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <ol className="m-0 list-none p-0">
                  {[...estimate.transitions].reverse().map((entry) => (
                    <li
                      key={`${entry.occurred_at}-${entry.to_state}`}
                      className="border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0"
                    >
                      <p className="m-0 flex flex-wrap items-center gap-x-[var(--space-3)]">
                        <span className="font-semibold text-[var(--color-text-strong)]">
                          {entry.to_state_label}
                        </span>
                        <span className="text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                          {entry.actor_label ?? 'The system'} ·{' '}
                          <time dateTime={entry.occurred_at} data-visual-volatile>
                            {formatMoment(entry.occurred_at)}
                          </time>
                        </span>
                      </p>
                      {entry.reason ? (
                        <p className="mt-[var(--space-2)] m-0 text-[var(--text-body-sm)] text-[var(--color-text)]">
                          {entry.reason}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-[var(--space-6)]">
          <Card>
            <CardHeader>
              <CardTitle>Approval</CardTitle>
              <CardDescription>
                {estimate.route
                  ? // The round is numbered only when there has been more than
                    // one. "Round 1" beside the only round there has ever been
                    // asks the reader to wonder what the other rounds were.
                    `${estimate.route.amount_formatted}${
                      estimate.route_history.length > 0 ? `, round ${estimate.route.attempt}` : ''
                    }.`
                  : 'Who will have to approve this, worked out from the amount and the cost centre.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {estimate.route ? (
                <ApprovalRoute
                  route={estimate.route}
                  renderDecision={(step) => (
                    <DecisionPanel
                      step={step}
                      amountFormatted={estimate.route?.amount_formatted ?? ''}
                      isPending={decide.isPending}
                      error={errorMessage(decide.error)}
                      onDecide={({ outcome, comment }) =>
                        decide.mutate({
                          stepOrder: step.step_order,
                          level: step.level,
                          outcome,
                          ...(comment === undefined ? {} : { comment }),
                        })
                      }
                    />
                  )}
                />
              ) : estimate.planned_route && estimate.planned_route.length > 0 ? (
                <>
                  <PlannedRoute steps={estimate.planned_route} />
                  <p className="mt-[var(--space-4)] m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                    The route the amount on the draft would take today. Changing the amount can
                    change it.
                  </p>
                </>
              ) : estimate.planned_route_problem ? (
                <>
                  <p className="m-0 font-semibold text-[var(--color-warning-700)]">
                    No route can be worked out yet
                  </p>
                  <p className="mt-2 m-0 text-[var(--text-body-sm)] text-[var(--color-text)]">
                    {estimate.planned_route_problem}
                  </p>
                </>
              ) : (
                <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                  Enter the total and its currency, and the approvals it will need appear here.
                </p>
              )}
            </CardContent>
          </Card>

          {estimate.route_history.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Earlier rounds</CardTitle>
                <CardDescription>
                  Kept in full. An approval given before the request changed is still something
                  somebody did.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-[var(--space-6)]">
                {estimate.route_history.map((route) => (
                  <div key={route.id}>
                    <p className="mb-[var(--space-3)] m-0 text-[var(--text-body-sm)] font-semibold text-[var(--color-text-strong)]">
                      Round {route.attempt} · {route.amount_formatted}
                    </p>
                    <ApprovalRoute route={route} />
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      <Modal
        open={leaving.blocked}
        onClose={leaving.keepEditing}
        title="You have changes you have not saved"
        description="Leaving this page now discards what you have typed since the last save."
        footer={
          <>
            <Button variant="ghost" onClick={leaving.discard}>
              Leave and discard
            </Button>
            <Button variant="primary" onClick={leaving.keepEditing}>
              Stay on this page
            </Button>
          </>
        }
      >
        <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text)]">
          Nothing has been sent to an approver either way. Staying here lets you press Save draft
          first, and a saved draft is still only visible to you.
        </p>
      </Modal>

      <ReasonDialog
        open={dialog === 'withdraw'}
        title="Withdraw from approval"
        description="This returns the estimate to your drafts so you can change it. Approvals already given stay on the record, and it will need approving again from the start."
        label="Why you are withdrawing it"
        help="Approvers who have already decided will see this."
        confirmLabel="Withdraw it"
        isPending={withdraw.isPending}
        error={errorMessage(withdraw.error)}
        onClose={() => setDialog(null)}
        onConfirm={(reason) => withdraw.mutate({ reason }, { onSuccess: () => setDialog(null) })}
      />

      <ReasonDialog
        open={dialog === 'cancel'}
        title="Cancel this estimate"
        description="This ends the request for good. It cannot be reopened, and starting again means raising a new estimate."
        label="Why you are cancelling it"
        help="Recorded against the estimate permanently."
        confirmLabel="Cancel it"
        danger
        isPending={cancel.isPending}
        error={errorMessage(cancel.error)}
        onClose={() => setDialog(null)}
        onConfirm={(reason) => cancel.mutate({ reason }, { onSuccess: () => setDialog(null) })}
      />
    </>
  );
}

/** What is outstanding, keyed by the control the server points at. */
function fieldProblems(estimate: EstimateDetail): Record<string, string> {
  return Object.fromEntries(
    estimate.problems.map((problem) => [problem.field, problem.explanation]),
  );
}

/**
 * The line under the title.
 *
 * A draft says what is left to do, because that is what the person looking at it
 * has to act on. An estimate with a live route says who is holding it, which is
 * more use than "waiting for an approver to decide" and is the sentence somebody
 * arriving from a notification wants first. A decided one says what happens next,
 * because "fully approved" is already on the badge beside it.
 */
function purposeFor(estimate: EstimateDetail): string {
  if (estimate.state === 'draft' && estimate.problem_count > 0) {
    const count = estimate.problem_count;
    return `${count} ${count === 1 ? 'thing' : 'things'} still to fill in before this can go for approval.`;
  }
  if (estimate.route?.state === 'open') return estimate.route.summary;
  return WORKFLOW_STATE_DESCRIPTIONS[estimate.state];
}
