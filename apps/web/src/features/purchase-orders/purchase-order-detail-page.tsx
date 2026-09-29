import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  PencilLine,
  Save,
  Send,
  ShieldAlert,
  Undo2,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import type { PurchaseOrderDetail as Order } from '@finora/shared-types';

import { ApiError, errorMessage } from '@/lib/api-client';
import { formatMoment } from '@/lib/dates';
import { parseAmount } from '@/lib/money';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';
import { WORKFLOW_STATE_DESCRIPTIONS } from '@/lib/workflow';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { StatusBadge, ToneBadge } from '@/components/workflow/status-badge';
import { DetailRow } from '@/features/shared/detail-row';
import { PageHeader } from '@/features/shared/page-header';
import { ReasonDialog } from '@/features/shared/reason-dialog';
import { useReferenceData } from '@/features/shared/use-reference-data';
import { ApprovalRoute, PlannedRoute } from '@/features/estimates/approval-route';
import { DecisionPanel } from '@/features/estimates/decision-panel';
import { AmendDialog } from '@/features/purchase-orders/amend-dialog';
import { orderStanding } from '@/features/purchase-orders/purchase-order-vocabulary';
import {
  PurchaseOrderForm,
  type OrderFormValues,
  draftFrom,
  isBlankDraft,
  isSameDraft,
  valuesFrom,
} from '@/features/purchase-orders/purchase-order-form';
import {
  useAmendPurchaseOrder,
  useCancelPurchaseOrder,
  useClosePurchaseOrder,
  useDecidePurchaseOrder,
  useOrderReferenceData,
  usePurchaseOrder,
  useSavePurchaseOrder,
  useSubmitPurchaseOrder,
  useWithdrawPurchaseOrder,
} from '@/features/purchase-orders/use-purchase-orders';

/**
 * One purchase order: what was committed to, how much of it is left, and what
 * had to be agreed before it counted.
 *
 * The page turns on one distinction that no other record in the platform has.
 * A draft commits nothing and can be freely changed. Everything after that is a
 * commitment a supplier may act on, and the only ways out of it are amending the
 * figure, closing it because it was honoured, or cancelling it on the claim it
 * should never have existed. The last of those is offered only while nothing has
 * been billed, because an invoice against the order is evidence against the
 * claim.
 *
 * Every control comes from the server's decision, not from reading the state
 * here. Whether this order needs anybody's approval at all depends on an
 * estimate somebody else approved, and a second implementation of that rule in
 * the browser would eventually disagree with the one that opens the order.
 */

const SERVER_FIELD: Partial<Record<keyof OrderFormValues, string>> = {
  vendorId: 'vendor_id',
  costCentreId: 'cost_centre_id',
  glAccountId: 'gl_account_id',
  estimateId: 'estimate_id',
  amount: 'total',
  currency: 'total',
};

interface Editor {
  baseline: string;
  values: OrderFormValues;
  touched: Set<string>;
  /**
   * Whether outstanding fields are marked on the form itself. False on a blank
   * order nobody has typed into; true from the first time somebody asks the
   * system to do something with it.
   */
  flagged: boolean;
}

type Dialog = 'withdraw' | 'amend' | 'close' | 'cancel';

export function PurchaseOrderDetailPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const { data: order, isLoading, isError, error } = usePurchaseOrder(orderId);
  const { data: reference } = useOrderReferenceData();
  const { data: shared } = useReferenceData();

  const save = useSavePurchaseOrder(orderId);
  const submit = useSubmitPurchaseOrder(orderId);
  const withdraw = useWithdrawPurchaseOrder(orderId);
  const amend = useAmendPurchaseOrder(orderId);
  const close = useClosePurchaseOrder(orderId);
  const cancel = useCancelPurchaseOrder(orderId);
  const decide = useDecidePurchaseOrder(orderId);

  const [editor, setEditor] = useState<Editor | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const baseline = order ? `${order.id}:${order.state}:${order.version}` : '';
  if (order && editor?.baseline !== baseline) {
    setEditor({
      baseline,
      values: valuesFrom(order),
      touched: new Set(),
      flagged: !isBlankDraft(draftFrom(valuesFrom(order))),
    });
    setSavedAt(null);
  }

  const savedDraft = useMemo(() => (order ? draftFrom(valuesFrom(order)) : null), [order]);

  // Worked out before the early returns below: the guard on leaving the page is
  // a hook, and a hook cannot be called conditionally.
  const dirty = Boolean(
    order?.can_edit && savedDraft && editor && !isSameDraft(savedDraft, draftFrom(editor.values)),
  );
  const leaving = useUnsavedChanges(dirty);

  if (isLoading || (!order && !isError)) {
    return (
      <>
        <PageHeader title="Purchase order" purpose="Opening this order." />
        <Card>
          <CardContent>
            <SkeletonText lines={8} />
          </CardContent>
        </Card>
      </>
    );
  }

  if (!order || !savedDraft || !editor) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <>
        <PageHeader
          title="Purchase order"
          purpose="This order could not be opened."
          actions={
            <Button variant="secondary" asChild>
              <Link to="/purchase-orders">
                <ArrowLeft aria-hidden="true" className="size-4" />
                Back to orders
              </Link>
            </Button>
          }
        />
        <Card className="border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              {missing ? 'That order could not be found' : 'Could not load this order'}
            </p>
            <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {missing
                ? 'It may belong to a department whose orders are not yours to see.'
                : (errorMessage(error) ?? 'The request did not complete.')}
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  const currentDraft = draftFrom(editor.values);
  const busy = save.isPending || submit.isPending;
  const current = editor;
  const standing = orderStanding(order.state_label, order.is_open);

  function handleChange(next: OrderFormValues) {
    const touched = new Set(current.touched);
    for (const key of Object.keys(next) as (keyof OrderFormValues)[]) {
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

  function commit() {
    setEditor({ ...current, flagged: true });
    // Saved first when there are unsaved changes, so the button means what it
    // says. Refusing to commit because somebody pressed one button and not two
    // is a rule about this software rather than about committing spend.
    if (dirty) persist(() => submit.mutate(undefined));
    else submit.mutate(undefined);
  }

  const blockers = order.blockers;
  const unfinished = order.problems.filter((problem) => !problem.is_blocking);

  return (
    <>
      <PageHeader
        title={order.number}
        purpose={purposeFor(order)}
        meta={
          <div className="flex flex-wrap items-center gap-[var(--space-3)]">
            {/* One badge, not two. "Approved" is the workflow state an open
                order happens to sit in, and beside "Open" it either repeats it
                or contradicts it: an order under the threshold opens without
                anybody approving anything, and a chip saying otherwise is the
                first thing an auditor would read. */}
            {order.state === 'approved' ? (
              <ToneBadge label={order.state_label} tone={standing.tone} detail={standing.description} />
            ) : (
              <StatusBadge state={order.state} />
            )}
            <span className="text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              Raised by {order.raised_by_label}
              {order.opened_at ? (
                <>
                  {' · opened '}
                  <time dateTime={order.opened_at} data-visual-volatile>
                    {formatMoment(order.opened_at)}
                  </time>
                </>
              ) : null}
            </span>
          </div>
        }
        actions={
          <>
            <Button variant="ghost" asChild>
              <Link to="/purchase-orders">
                <ArrowLeft aria-hidden="true" className="size-4" />
                All orders
              </Link>
            </Button>

            {order.can_edit ? (
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
                  onClick={commit}
                  // Enabled while there are unsaved changes even when the saved
                  // version is incomplete, because the changes may be what
                  // completes it. The server decides after the save.
                  disabled={busy || (!order.can_submit && !dirty)}
                  isLoading={submit.isPending}
                  loadingLabel="Committing"
                >
                  <Send aria-hidden="true" className="size-4" />
                  {order.needs_approval ? 'Send for approval' : 'Commit this order'}
                </Button>
              </>
            ) : null}

            {order.can_withdraw ? (
              <Button variant="secondary" onClick={() => setDialog('withdraw')}>
                <Undo2 aria-hidden="true" className="size-4" />
                Take it back
              </Button>
            ) : null}

            {order.can_amend ? (
              <Button variant="secondary" onClick={() => setDialog('amend')}>
                <PencilLine aria-hidden="true" className="size-4" />
                Change the figure
              </Button>
            ) : null}

            {order.can_close ? (
              <Button variant="secondary" onClick={() => setDialog('close')}>
                <CheckCircle2 aria-hidden="true" className="size-4" />
                Close it
              </Button>
            ) : null}

            {order.can_cancel ? (
              <Button variant="ghost" onClick={() => setDialog('cancel')}>
                <Ban aria-hidden="true" className="size-4" />
                Cancel
              </Button>
            ) : null}
          </>
        }
      />

      <div aria-live="polite">
        {save.error || submit.error ? (
          <Card className="mb-[var(--space-5)] border-[var(--color-danger-600)]">
            <CardContent>
              <p className="m-0 font-semibold text-[var(--color-danger-700)]">
                {submit.error ? 'Nothing has been committed' : 'Your changes were not saved'}
              </p>
              <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text)]">
                {errorMessage(submit.error ?? save.error)}
              </p>
              <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                {submit.error
                  ? 'The order is still a draft and no supplier has been told anything.'
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
            . Nothing is committed until you commit it.
          </p>
        ) : null}
      </div>

      <div className="grid gap-[var(--space-6)] xl:grid-cols-[minmax(0,3fr)_minmax(21rem,2fr)]">
        <div className="flex min-w-0 flex-col gap-[var(--space-6)]">
          {/* Controls that have fired come first and stay visible whether or not
              this reader can edit. An order below what has already been billed
              is not a typing mistake to quietly correct. */}
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
                      ? 'A control has stopped this order'
                      : `${blockers.length} controls have stopped this order`}
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

          {order.can_edit && unfinished.length > 0 ? (
            <Card className="border-[color-mix(in_srgb,var(--color-warning-600)_38%,white)]">
              <CardHeader>
                <CardTitle>
                  <span className="inline-flex items-center gap-[var(--space-2)]">
                    <AlertTriangle
                      aria-hidden="true"
                      className="size-4 text-[var(--color-warning-600)]"
                    />
                    Before this can be committed
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
              <CardTitle>{order.can_edit ? 'The order' : 'What was committed'}</CardTitle>
              <CardDescription>
                {order.can_edit
                  ? 'A draft commits nothing. It becomes a commitment when you commit it, which is also when it is checked.'
                  : 'As it stood when it was committed. Changing the figure is a separate act, and raising it needs approving again.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {order.can_edit ? (
                <PurchaseOrderForm
                  values={editor.values}
                  onChange={handleChange}
                  reference={reference}
                  currencies={shared?.currencies ?? [editor.values.currency]}
                  problems={editor.flagged ? fieldProblems(order) : {}}
                  touched={editor.touched}
                  disabled={busy}
                />
              ) : (
                // One column, as on the estimate and invoice pages. Two columns
                // inside a card that is itself half the page leave the value about
                // thirty pixels wide, so a supplier's name arrives broken across
                // three lines.
                <dl className="m-0">
                  <DetailRow label="Supplier">{order.vendor?.name ?? 'Not named'}</DetailRow>
                  <DetailRow label="Order total">{order.total_formatted ?? 'Not stated'}</DetailRow>
                  <DetailRow label="What was ordered">{order.description || 'Not stated'}</DetailRow>
                  <DetailRow label="Cost centre">{order.cost_centre?.name ?? 'Not stated'}</DetailRow>
                  <DetailRow label="Account code">{order.gl_account?.name ?? 'Not coded'}</DetailRow>
                  <DetailRow label="Against estimate">
                    {order.estimate_reference ?? 'Not against an estimate'}
                  </DetailRow>
                </dl>
              )}
            </CardContent>
          </Card>

          {order.transitions.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>History</CardTitle>
                <CardDescription>
                  Every state this order has been in, who moved it and why. Newest first.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <ol className="m-0 list-none p-0">
                  {[...order.transitions].reverse().map((entry) => (
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
          <Card>
            <CardHeader>
              <CardTitle>What is left</CardTitle>
              <CardDescription>
                How much of this commitment suppliers have billed against, and how much they still
                can.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {order.total_formatted ? (
                <dl className="m-0">
                  <DetailRow label="Committed">{order.total_formatted}</DetailRow>
                  <DetailRow label="Billed so far">{order.billed_formatted ?? '—'}</DetailRow>
                  <DetailRow label="Still available">
                    {/* Red only when it has gone negative. An order with nothing
                        left is finished, which is an ordinary end rather than an
                        alarm; an order billed past its figure is money committed
                        by nobody. */}
                    <span
                      className={
                        order.remaining_minor_units !== null && order.remaining_minor_units < 0
                          ? 'font-semibold text-[var(--color-danger-700)]'
                          : undefined
                      }
                    >
                      {order.remaining_formatted ?? '—'}
                    </span>
                  </DetailRow>
                </dl>
              ) : (
                <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                  Enter the order total and its currency, and what is left appears here.
                </p>
              )}

              {order.closed_at ? (
                <p className="mt-[var(--space-4)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                  Closed by {order.closed_by_label ?? 'somebody'} on{' '}
                  <time dateTime={order.closed_at} data-visual-volatile>
                    {formatMoment(order.closed_at)}
                  </time>
                  {order.closed_reason ? `: ${order.closed_reason}` : '.'}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Approval</CardTitle>
              <CardDescription>
                {/* Nothing here may promise names. On an order that opened
                    without a round there are none, and "who agreed to this"
                    sitting above "nobody did" reads as a list that failed to
                    load rather than as an answer. */}
                {order.route
                  ? `${order.route.amount_formatted}.`
                  : order.state === 'draft'
                    ? 'Who has to agree to this commitment, worked out from the amount and the cost centre.'
                    : 'What had to be agreed before this became a commitment.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {order.route ? (
                <ApprovalRoute
                  route={order.route}
                  renderDecision={(step) => (
                    <DecisionPanel
                      step={step}
                      amountFormatted={order.route?.amount_formatted ?? ''}
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
              ) : !order.needs_approval && order.estimate_reference ? (
                // A route of length zero on purpose, said in words. An empty
                // approval panel reads as a route nobody has configured, which
                // is the opposite of what has happened here.
                <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text)]">
                  No further approval is needed. {order.estimate_reference} is already approved for
                  this supplier at this amount or more, and sending it round again would be a
                  second signature on one decision.
                </p>
              ) : order.state === 'draft' && order.planned_route.length > 0 ? (
                <>
                  <PlannedRoute steps={order.planned_route} />
                  <p className="mt-[var(--space-4)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                    The route this amount would take when the order is committed. Changing the
                    amount can change it.
                  </p>
                </>
              ) : order.state !== 'draft' ? (
                // Committed, and no round on the record. A forecast belongs to a
                // draft; offered here it would read as approval still to come on
                // an order suppliers are already billing against.
                <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text)]">
                  This order was committed without going round for approval, so nothing is waiting
                  on anybody. How it reached that point is on the record with it.
                </p>
              ) : order.route_unavailable ? (
                <>
                  <p className="m-0 font-semibold text-[var(--color-warning-700)]">
                    No route can be worked out yet
                  </p>
                  <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text)]">
                    {order.route_unavailable}
                  </p>
                </>
              ) : (
                <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                  Enter the total and its currency, and the approvals it will need appear here.
                </p>
              )}
            </CardContent>
          </Card>
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
          Nothing has been committed either way. Staying here lets you press Save draft first, and
          a saved draft commits nothing.
        </p>
      </Modal>

      <ReasonDialog
        open={dialog === 'withdraw'}
        title="Take this back from approval"
        description="This returns the order to a draft so you can correct it. Anybody part-way through deciding on it stops seeing it."
        label="Why you are taking it back"
        help="Recorded against the order."
        confirmLabel="Take it back"
        isPending={withdraw.isPending}
        error={errorMessage(withdraw.error)}
        onClose={() => setDialog(null)}
        onConfirm={(reason) => withdraw.mutate({ reason }, { onSuccess: () => setDialog(null) })}
      />

      <AmendDialog
        open={dialog === 'amend'}
        currency={order.currency ?? 'JMD'}
        currentFormatted={order.total_formatted ?? ''}
        billedFormatted={order.billed_formatted}
        isPending={amend.isPending}
        error={errorMessage(amend.error)}
        onClose={() => setDialog(null)}
        onConfirm={({ amount, reason }) => {
          const minorUnits = parseAmount(amount, order.currency ?? 'JMD');
          if (minorUnits === null) return;
          amend.mutate(
            { totalMinorUnits: minorUnits, reason },
            { onSuccess: () => setDialog(null) },
          );
        }}
      />

      <ReasonDialog
        open={dialog === 'close'}
        title="Close this order"
        description="This says the commitment was honoured and nothing further is expected against it. Invoices already billed to it are untouched, and no new ones can name it."
        label="Why you are closing it"
        help="Recorded against the order. “Delivered in full” is usually enough."
        confirmLabel="Close it"
        isPending={close.isPending}
        error={errorMessage(close.error)}
        onClose={() => setDialog(null)}
        onConfirm={(reason) => close.mutate({ reason }, { onSuccess: () => setDialog(null) })}
      />

      <ReasonDialog
        open={dialog === 'cancel'}
        title="Cancel this order"
        description="This says the commitment should never have existed. It is not the same as closing, which says it was honoured. If anything has been billed against it, close it instead."
        label="Why you are cancelling it"
        help="Recorded against the order permanently."
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
function fieldProblems(order: Order): Record<string, string> {
  return Object.fromEntries(order.problems.map((problem) => [problem.field, problem.explanation]));
}

/**
 * The line under the title.
 *
 * Says the most urgent true thing. A control that has fired outranks everything
 * because it is the reason nothing else is happening; then whether this is still
 * a live commitment, which is the question the page is usually opened to answer.
 */
function purposeFor(order: Order): string {
  if (order.blockers.length > 0) {
    return order.blockers.length === 1
      ? 'A control has stopped this order. It is set out below.'
      : `${order.blockers.length} controls have stopped this order. They are set out below.`;
  }
  if (order.state === 'draft') {
    const count = order.problems.length;
    if (count > 0) {
      return `${count} ${count === 1 ? 'thing' : 'things'} still to fill in before this can be committed.`;
    }
    return order.needs_approval
      ? 'Ready to commit. It will go for approval before it opens.'
      : 'Ready to commit. An approved estimate covers it, so it opens straight away.';
  }
  if (order.state === 'approved') {
    if (!order.is_open) {
      return 'Closed. Nothing further can be billed against this commitment.';
    }
    return order.remaining_formatted
      ? `Open, with ${order.remaining_formatted} still available to bill against.`
      : 'Open and receiving invoices.';
  }
  if (order.route?.state === 'open') return order.route.summary;
  return WORKFLOW_STATE_DESCRIPTIONS[order.state];
}
