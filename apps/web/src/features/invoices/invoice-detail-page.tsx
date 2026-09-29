import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, Ban, Save, Send, ShieldAlert, Undo2 } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import type { InvoiceDetail as Invoice } from '@finora/shared-types';

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
import { useReferenceData } from '@/features/shared/use-reference-data';
import { ApprovalRoute, PlannedRoute } from '@/features/estimates/approval-route';
import { DecisionPanel } from '@/features/estimates/decision-panel';
import { InvoiceDetails } from '@/features/invoices/invoice-details';
import { LinkagePanel } from '@/features/invoices/linkage-panel';
import { SignOffPanel, declineOf } from '@/features/invoices/sign-off-panel';
import {
  InvoiceForm,
  type InvoiceFormValues,
  draftFrom,
  isBlankDraft,
  isSameDraft,
  valuesFrom,
} from '@/features/invoices/invoice-form';
import {
  useCancelInvoice,
  useDeclineSignOff,
  useDecideInvoice,
  useInvoice,
  useLinkableRecords,
  useRecallInvoice,
  useRequestSignOff,
  useSaveInvoice,
  useSignOff,
} from '@/features/invoices/use-invoices';

/**
 * One invoice: what is being billed, what it is billed against, who has to
 * confirm it arrived, and who has to approve paying it.
 *
 * The page serves three people in turn and never asks which one is reading.
 * Finance records the bill and sends it out for confirmation. The person who
 * asked for the goods says whether they arrived. Approvers then decide. Whatever
 * does not apply to the reader is absent rather than disabled.
 *
 * Every control is enabled from the server's `actions` block. The rules behind
 * them — who may confirm, whether the same person may then approve, whether a
 * control has fired that stops it entirely — are not reimplemented here, so a
 * control that looks available is.
 */

/**
 * Form fields whose name differs from the field the server points at.
 *
 * The total is one control here and a pair of columns there, and the supplier is
 * a picker plus an optional name. Every other name matches, which is worth
 * keeping true.
 */
const SERVER_FIELD: Partial<Record<keyof InvoiceFormValues, string>> = {
  vendorId: 'vendor_id',
  vendorName: 'vendor_name',
  invoiceNumber: 'invoice_number',
  invoiceDate: 'invoice_date',
  dueDate: 'due_date',
  costCentreId: 'cost_centre_id',
  estimateId: 'estimate_id',
  purchaseOrderId: 'purchase_order_id',
  requesterId: 'requester_id',
  amount: 'total',
  currency: 'total',
};

/** The editable state, and the saved record it was filled from. */
interface Editor {
  baseline: string;
  values: InvoiceFormValues;
  /** Boxes edited since the last save, whose saved problems no longer apply. */
  touched: Set<string>;
  /**
   * Whether the outstanding fields are marked on the form itself.
   *
   * False on a blank invoice nobody has typed into, and true from the first time
   * somebody asks the system to do something with it. Saving or sending is the
   * point at which they have offered it up for checking, and the point at which
   * marking the gaps is help rather than accusation.
   */
  flagged: boolean;
}

type Dialog = 'decline' | 'recall' | 'cancel';

export function InvoiceDetailPage() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const { data: invoice, isLoading, isError, error } = useInvoice(invoiceId);
  const { data: reference } = useReferenceData();
  const { data: linkable } = useLinkableRecords();

  const save = useSaveInvoice(invoiceId);
  const request = useRequestSignOff(invoiceId);
  const confirm = useSignOff(invoiceId);
  const decline = useDeclineSignOff(invoiceId);
  const recall = useRecallInvoice(invoiceId);
  const cancel = useCancelInvoice(invoiceId);
  const decide = useDecideInvoice(invoiceId);

  const [editor, setEditor] = useState<Editor | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Refilled when a different invoice is opened, or when this one moves state.
  // An ordinary save does not refill it, because the boxes already contain what
  // was saved.
  const baseline = invoice ? `${invoice.id}:${invoice.state}` : '';
  if (invoice && editor?.baseline !== baseline) {
    setEditor({
      baseline,
      values: valuesFrom(invoice),
      touched: new Set(),
      flagged: !isBlankDraft(draftFrom(valuesFrom(invoice))),
    });
    // The save note says nobody has been asked about this yet, which is true of
    // a draft and false the moment the invoice moves. Asking for confirmation
    // saves first, so without this the note survives its own becoming untrue and
    // tells finance nobody has been emailed while the reminders are running.
    setSavedAt(null);
  }

  const savedDraft = useMemo(() => (invoice ? draftFrom(valuesFrom(invoice)) : null), [invoice]);

  // Worked out before the early returns below, because the guard on leaving the
  // page is a hook and a hook cannot be called conditionally.
  const dirty = Boolean(
    invoice?.actions.may_edit &&
      savedDraft &&
      editor &&
      !isSameDraft(savedDraft, draftFrom(editor.values)),
  );
  const leaving = useUnsavedChanges(dirty);

  if (isLoading || (!invoice && !isError)) {
    return (
      <>
        <PageHeader title="Invoice" purpose="Opening this invoice." />
        <Card>
          <CardContent>
            <SkeletonText lines={8} />
          </CardContent>
        </Card>
      </>
    );
  }

  if (!invoice || !savedDraft || !editor) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <>
        <PageHeader
          title="Invoice"
          purpose="This invoice could not be opened."
          actions={
            <Button variant="secondary" asChild>
              <Link to="/invoices">
                <ArrowLeft aria-hidden="true" className="size-4" />
                Back to invoices
              </Link>
            </Button>
          }
        />
        <Card className="border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              {missing ? 'That invoice could not be found' : 'Could not load this invoice'}
            </p>
            <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {missing
                ? 'It may belong to a department whose invoices are not yours to see.'
                : (errorMessage(error) ?? 'The request did not complete.')}
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  const actions = invoice.actions;
  const currentDraft = draftFrom(editor.values);
  const busy = save.isPending || request.isPending;
  const current = editor;

  function handleChange(next: InvoiceFormValues) {
    const touched = new Set(current.touched);
    for (const key of Object.keys(next) as (keyof InvoiceFormValues)[]) {
      if (next[key] !== current.values[key]) touched.add(SERVER_FIELD[key] ?? key);
    }
    setEditor({ ...current, values: next, touched });
  }

  function persist(then?: () => void) {
    setSavedAt(null);
    save.mutate(currentDraft, {
      onSuccess: () => {
        setEditor({ ...current, touched: new Set(), flagged: true });
        setSavedAt(new Date().toISOString());
        then?.();
      },
    });
  }

  function askForConfirmation() {
    setEditor({ ...current, flagged: true });
    // Saved first when there are unsaved changes, so the button means what it
    // says. Refusing to send because somebody pressed one button and not two is
    // a rule about this software rather than about paying suppliers.
    if (dirty) persist(() => request.mutate(undefined));
    else request.mutate(undefined);
  }

  const blockers = invoice.problems.filter((problem) => problem.is_blocking);
  const unfinished = invoice.problems.filter((problem) => !problem.is_blocking);

  return (
    <>
      <PageHeader
        title={invoice.reference}
        purpose={purposeFor(invoice)}
        meta={
          <div className="flex flex-wrap items-center gap-[var(--space-3)]">
            <StatusBadge state={invoice.state} />
            <span className="text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              Recorded by {invoice.created_by_label} ·{' '}
              <time dateTime={invoice.created_at} data-visual-volatile>
                {formatMoment(invoice.created_at)}
              </time>
            </span>
          </div>
        }
        actions={
          <>
            <Button variant="ghost" asChild>
              <Link to="/invoices">
                <ArrowLeft aria-hidden="true" className="size-4" />
                All invoices
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
                  onClick={askForConfirmation}
                  // Enabled while there are unsaved changes even when the saved
                  // version is incomplete, because the changes may be what
                  // completes it. The server decides after the save.
                  disabled={busy || (!actions.may_request_sign_off && !dirty)}
                  isLoading={request.isPending}
                  loadingLabel="Sending"
                >
                  <Send aria-hidden="true" className="size-4" />
                  Ask for confirmation
                </Button>
              </>
            ) : null}

            {actions.may_recall ? (
              <Button variant="secondary" onClick={() => setDialog('recall')}>
                <Undo2 aria-hidden="true" className="size-4" />
                Take it back
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
        {save.error || request.error ? (
          <Card className="mb-[var(--space-5)] border-[var(--color-danger-600)]">
            <CardContent>
              <p className="m-0 font-semibold text-[var(--color-danger-700)]">
                {request.error ? 'Nobody has been asked to confirm this' : 'Your changes were not saved'}
              </p>
              <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text)]">
                {errorMessage(request.error ?? save.error)}
              </p>
              <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                {request.error
                  ? 'No email has gone out, and what you have typed is still here.'
                  : 'What you have typed is still on the screen. Nothing was lost.'}
              </p>
            </CardContent>
          </Card>
        ) : savedAt && !dirty ? (
          <p className="mb-[var(--space-5)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-success-700)]">
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
            . Nobody has been asked about it yet.
          </p>
        ) : null}
      </div>

      <div className="grid gap-[var(--space-6)] xl:grid-cols-[minmax(0,3fr)_minmax(21rem,2fr)]">
        <div className="flex min-w-0 flex-col gap-[var(--space-6)]">
          {/* Controls that have fired come before anything else on the page, and
              stay visible whether or not this reader can edit. An overrun is not
              the drafter's typing mistake to quietly correct; it is the fact the
              next person to look at this needs first. */}
          {blockers.length > 0 ? (
            <Card className="border-[var(--color-danger-600)]">
              <CardHeader>
                <CardTitle>
                  <span className="inline-flex items-center gap-[var(--space-2)]">
                    <ShieldAlert
                      aria-hidden="true"
                      className="size-4 text-[var(--color-danger-600)]"
                    />
                    {blockers.length === 1
                      ? 'A control has stopped this invoice'
                      : `${blockers.length} controls have stopped this invoice`}
                  </span>
                </CardTitle>
                <CardDescription>
                  These are not gaps in the form. Each one needs a decision from somebody, and
                  none of them can be overridden here.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="m-0 flex list-disc flex-col gap-[var(--space-2)] pl-[var(--space-5)]">
                  {blockers.map((problem) => (
                    <li
                      key={problem.problem}
                      className="text-[length:var(--text-body-sm)] text-[var(--color-text)]"
                    >
                      {problem.explanation}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          {actions.may_edit && unfinished.length > 0 ? (
            <Card className="border-[color-mix(in_srgb,var(--color-warning-600)_38%,white)]">
              <CardHeader>
                <CardTitle>
                  <span className="inline-flex items-center gap-[var(--space-2)]">
                    <AlertTriangle
                      aria-hidden="true"
                      className="size-4 text-[var(--color-warning-600)]"
                    />
                    Before anybody can be asked to confirm this
                  </span>
                </CardTitle>
                <CardDescription>
                  All of it at once, so you can finish in one pass rather than one refusal at a
                  time.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="m-0 flex list-disc flex-col gap-[var(--space-2)] pl-[var(--space-5)]">
                  {unfinished.map((problem) => (
                    <li
                      key={problem.problem}
                      className="text-[length:var(--text-body-sm)] text-[var(--color-text)]"
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
              <CardTitle>{actions.may_edit ? 'The invoice' : 'What was billed'}</CardTitle>
              <CardDescription>
                {actions.may_edit
                  ? 'Saved when you press Save draft, and again when you ask for confirmation.'
                  : 'As it stood when confirmation was asked for. Changing it means taking it back first.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {actions.may_edit ? (
                <InvoiceForm
                  values={editor.values}
                  onChange={handleChange}
                  reference={reference}
                  linkable={linkable}
                  problems={editor.flagged ? fieldProblems(invoice) : {}}
                  touched={editor.touched}
                  disabled={busy}
                />
              ) : (
                <InvoiceDetails invoice={invoice} />
              )}
            </CardContent>
          </Card>

          {invoice.transitions.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>History</CardTitle>
                <CardDescription>
                  Every state this invoice has been in, who moved it and why. Newest first.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <ol className="m-0 list-none p-0">
                  {[...invoice.transitions].reverse().map((entry) => (
                    <li
                      key={`${entry.occurred_at}-${entry.to_state}`}
                      className="border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0"
                    >
                      <p className="m-0 flex flex-wrap items-center gap-x-[var(--space-3)]">
                        <span className="font-semibold text-[var(--color-text-strong)]">
                          {entry.to_state_label}
                        </span>
                        <span className="text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                          {entry.actor_label ?? 'The system'} ·{' '}
                          <time dateTime={entry.occurred_at} data-visual-volatile>
                            {formatMoment(entry.occurred_at)}
                          </time>
                        </span>
                      </p>
                      {entry.reason ? (
                        <p className="mt-[var(--space-2)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text)]">
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
          <SignOffPanel
            invoice={invoice}
            isConfirming={confirm.isPending}
            error={errorMessage(confirm.error)}
            onConfirm={(note) => confirm.mutate(note === undefined ? {} : { note })}
            onDecline={() => setDialog('decline')}
          />

          <LinkagePanel invoice={invoice} />

          <Card>
            <CardHeader>
              <CardTitle>Approval</CardTitle>
              <CardDescription>
                {invoice.route
                  ? `${invoice.route.amount_formatted}${
                      invoice.route_history.length > 0 ? `, round ${invoice.route.attempt}` : ''
                    }.`
                  : 'Who will have to approve paying this, worked out from the amount and the cost centre.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {invoice.route ? (
                <ApprovalRoute
                  route={invoice.route}
                  renderDecision={(step) => (
                    <DecisionPanel
                      step={step}
                      amountFormatted={invoice.route?.amount_formatted ?? ''}
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
              ) : invoice.planned_route && invoice.planned_route.length > 0 ? (
                <>
                  <PlannedRoute steps={invoice.planned_route} />
                  <p className="mt-[var(--space-4)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                    The route this amount would take once receipt has been confirmed. Changing the
                    amount can change it.
                  </p>
                </>
              ) : invoice.planned_route_problem ? (
                <>
                  <p className="m-0 font-semibold text-[var(--color-warning-700)]">
                    No route can be worked out yet
                  </p>
                  <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text)]">
                    {invoice.planned_route_problem}
                  </p>
                </>
              ) : (
                <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                  Enter the total and its currency, and the approvals it will need appear here.
                </p>
              )}
            </CardContent>
          </Card>

          {invoice.route_history.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Earlier rounds</CardTitle>
                <CardDescription>
                  Kept in full. An approval given before the invoice changed is still something
                  somebody did.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-[var(--space-6)]">
                {invoice.route_history.map((route) => (
                  <div key={route.id}>
                    <p className="mb-[var(--space-3)] m-0 text-[length:var(--text-body-sm)] font-semibold text-[var(--color-text-strong)]">
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
        <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text)]">
          Nobody has been asked to confirm anything either way. Staying here lets you press Save
          draft first, and a saved draft sends no email.
        </p>
      </Modal>

      <ReasonDialog
        open={dialog === 'decline'}
        title="Say this did not arrive as billed"
        description="This sends the invoice back to finance with your reason and stops the reminders. Nothing is paid until they resolve it with the supplier."
        label="What is wrong with it"
        help="Finance reads this. Say what arrived, or did not, rather than only that something is wrong."
        confirmLabel="Send it back"
        isPending={decline.isPending}
        error={errorMessage(decline.error)}
        onClose={() => setDialog(null)}
        onConfirm={(reason) => decline.mutate({ reason }, { onSuccess: () => setDialog(null) })}
      />

      <ReasonDialog
        open={dialog === 'recall'}
        title="Take this back from confirmation"
        description="This returns the invoice to your drafts and stops the reminders going to the person you asked. They are not told why unless you tell them."
        label="Why you are taking it back"
        help="Recorded against the invoice."
        confirmLabel="Take it back"
        isPending={recall.isPending}
        error={errorMessage(recall.error)}
        onClose={() => setDialog(null)}
        onConfirm={(reason) => recall.mutate({ reason }, { onSuccess: () => setDialog(null) })}
      />

      <ReasonDialog
        open={dialog === 'cancel'}
        title="Cancel this invoice"
        description="This ends it for good. It cannot be reopened, and recording the same bill again means starting a new invoice."
        label="Why you are cancelling it"
        help="Recorded against the invoice permanently."
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
function fieldProblems(invoice: Invoice): Record<string, string> {
  return Object.fromEntries(invoice.problems.map((problem) => [problem.field, problem.explanation]));
}

/**
 * The line under the title.
 *
 * Says the most urgent true thing. A control that has fired outranks everything,
 * because it is the reason nothing else is happening. Then whoever is being
 * waited on by name, since "awaiting sign-off" names nobody and the person
 * arriving from an email wants to know whether it is them.
 */
function purposeFor(invoice: Invoice): string {
  if (invoice.blocker_count > 0) {
    return invoice.blocker_count === 1
      ? 'A control has stopped this invoice. It is set out below.'
      : `${invoice.blocker_count} controls have stopped this invoice. They are set out below.`;
  }
  if (invoice.state === 'draft' && invoice.problem_count > 0) {
    const count = invoice.problem_count;
    return `${count} ${count === 1 ? 'thing' : 'things'} still to fill in before anybody can be asked to confirm this.`;
  }
  const declined = declineOf(invoice);
  if (declined) {
    return `${declined.actor_label ?? 'The person asked'} says this did not arrive as billed. Correct it and ask again, or cancel it.`;
  }
  if (invoice.state === 'pending_sign_off') {
    return invoice.sign_off.is_mine_to_sign
      ? 'You have been asked to confirm that this arrived. Nothing moves until you answer.'
      : `Waiting on ${invoice.sign_off.requester_label ?? 'the requester'} to confirm this arrived.`;
  }
  if (invoice.route?.state === 'open') return invoice.route.summary;
  return WORKFLOW_STATE_DESCRIPTIONS[invoice.state];
}
