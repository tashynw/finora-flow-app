import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  MessageSquare,
  Plus,
  Save,
  Send,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import type {
  PackageDraftRequest,
  PaymentMethod,
  PaymentPackageDetail as Package,
  RefusedOut,
} from '@finora/shared-types';

import { ApiError, errorMessage } from '@/lib/api-client';
import { formatDate, formatMoment } from '@/lib/dates';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { MoneyDisplay } from '@/components/finance/money-display';
import { ToneBadge } from '@/components/workflow/status-badge';
import { DetailRow } from '@/features/shared/detail-row';
import { PageHeader } from '@/features/shared/page-header';
import { ReasonDialog } from '@/features/shared/reason-dialog';
import { AddInvoicesDialog } from '@/features/payments/add-invoices-dialog';
import { CurrencyTotals, toMoneyValue } from '@/features/payments/currency-totals';
import { ManifestPanel } from '@/features/payments/manifest-panel';
import { SubmitDialog } from '@/features/payments/submit-dialog';
import {
  contentsSummary,
  lineStanding,
  packageStanding,
} from '@/features/payments/payment-vocabulary';
import {
  useAddToPackage,
  useCancelPackage,
  useEligibleInvoices,
  useManifest,
  usePaymentPackage,
  useRemoveFromPackage,
  useSavePaymentPackage,
  useSubmitPackage,
} from '@/features/payments/use-payment-packages';
import { useRaiseCheckIns } from '@/features/vendor-confirmations/use-vendor-check-ins';
import { useAuth } from '@/features/auth/auth-context';

/**
 * One payment package: what is going out, what it comes to in each currency,
 * and — once it has gone — what was sent and how that can be proved.
 *
 * The page is arranged around the one question the whole phase exists to make
 * askable: how much is about to leave, and to whom. The contents and their
 * totals occupy the main column; everything else is support. Approval is
 * deliberately absent, because nothing in a package is waiting to be approved —
 * every invoice in it was approved before it could be added, and offering a
 * decision here would be inviting a second one.
 *
 * Every control comes from the server's own answer. Assembling a package and
 * sending it are separate authorities, so the person looking at a full package
 * may well have no Send button, and that is the intended outcome rather than a
 * gap.
 */

const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'wire', label: 'Wire' },
  { value: 'direct_debit', label: 'Direct debit' },
];

interface FormValues {
  description: string;
  paymentMethod: PaymentMethod | '';
  intendedPaymentDate: string;
}

function valuesFrom(pkg: Package): FormValues {
  return {
    description: pkg.description,
    paymentMethod: pkg.payment_method ?? '',
    intendedPaymentDate: pkg.intended_payment_date ?? '',
  };
}

function draftFrom(values: FormValues): PackageDraftRequest {
  return {
    description: values.description.trim(),
    payment_method: values.paymentMethod === '' ? null : values.paymentMethod,
    intended_payment_date: values.intendedPaymentDate || null,
  };
}

function isSameDraft(a: PackageDraftRequest, b: PackageDraftRequest): boolean {
  return (
    a.description === b.description &&
    a.payment_method === b.payment_method &&
    a.intended_payment_date === b.intended_payment_date
  );
}

type Dialog = 'add' | 'submit' | 'cancel';

/**
 * Opening one conversation per supplier about a package that has gone.
 *
 * Lives here rather than on the confirmations queue because a check-in is
 * always about a particular package, and this is the only screen that knows
 * which one. Deliberately not automatic on submission: a coordinator sending a
 * package at four in the afternoon should decide when a dozen suppliers are
 * emailed, and a run that fires on submit would make that decision for them
 * every time.
 *
 * Raising is not sending. This creates the questions; each is emailed from its
 * own page, which is what lets somebody see who is about to be written to
 * before anybody is.
 */
function AskSuppliersCard({ packageId }: { packageId: string }) {
  const raise = useRaiseCheckIns();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ask the suppliers</CardTitle>
        <CardDescription>
          One question per supplier in this package, asking whether the money reached them.
          Nothing is emailed until you send each one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {raise.isSuccess ? (
          <div aria-live="polite">
            <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text)]">
              {raise.data.raised.length === 0
                ? 'Every supplier in this package had already been asked.'
                : `${raise.data.raised.length === 1 ? '1 question' : `${raise.data.raised.length} questions`} opened.`}
              {/* Named rather than silently skipped: "nothing happened" and
                  "nothing needed to happen" look identical otherwise. */}
              {raise.data.already_raised.length > 0 && raise.data.raised.length > 0
                ? ` Already open for ${raise.data.already_raised.join(', ')}.`
                : ''}
            </p>
            <Button variant="secondary" className="mt-[var(--space-4)]" asChild>
              <Link to="/vendor-confirmations">Go to the confirmations queue</Link>
            </Button>
          </div>
        ) : (
          <>
            <Button
              variant="secondary"
              onClick={() => raise.mutate({ packageId })}
              isLoading={raise.isPending}
              loadingLabel="Opening"
            >
              <MessageSquare aria-hidden="true" className="size-4" />
              Ask the suppliers
            </Button>
            {raise.isError ? (
              <p
                role="alert"
                className="mt-[var(--space-3)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-danger-700)]"
              >
                {errorMessage(raise.error) ?? 'Nobody was asked.'}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function PaymentPackageDetailPage() {
  const { packageId } = useParams<{ packageId: string }>();
  const { can } = useAuth();
  const { data: pkg, isLoading, isError, error } = usePaymentPackage(packageId);

  // Not a `can_*` flag from the payload, unlike every other control here. Those
  // answer questions about this package; this one asks whether the reader works
  // on supplier confirmations at all, which the package knows nothing about.
  const asksSuppliers = can('vendor:confirmation_review');

  const save = useSavePaymentPackage(packageId);
  const add = useAddToPackage(packageId);
  const remove = useRemoveFromPackage(packageId);
  const submit = useSubmitPackage(packageId);
  const cancel = useCancelPackage(packageId);

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [values, setValues] = useState<FormValues | null>(null);
  const [baseline, setBaseline] = useState('');
  const [opened, setOpened] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [refused, setRefused] = useState<RefusedOut[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);

  const key = pkg ? `${pkg.id}:${pkg.version}` : '';
  if (pkg && baseline !== key) {
    setBaseline(key);
    setValues(valuesFrom(pkg));
  }

  // The confirmation of a save is deliberately not cleared above. Saving is what
  // moves the version on, so clearing it there discards the answer to "did that
  // work" in the same render that produced it, and the screen reports nothing at
  // all. It is cleared when a different package is opened, when the next edit
  // starts (below, through `dirty`), and by the actions that change the package
  // some other way.
  if (pkg && opened !== pkg.id) {
    setOpened(pkg.id);
    setSavedAt(null);
  }

  // Fetched only while the picker is open. The list is short-lived by design and
  // there is no reason to keep re-asking for it behind a closed dialog.
  const eligible = useEligibleInvoices(dialog === 'add');

  // A manifest exists only once the package has a method and a date, and the
  // server answers 409 until then. Asked for anyway on an open package, because
  // seeing the file before it goes is the point of previewing it.
  const manifest = useManifest(packageId, Boolean(pkg));

  const savedDraft = useMemo(() => (pkg ? draftFrom(valuesFrom(pkg)) : null), [pkg]);
  const dirty = Boolean(
    pkg?.can_edit && savedDraft && values && !isSameDraft(savedDraft, draftFrom(values)),
  );
  const leaving = useUnsavedChanges(dirty);

  if (isLoading || (!pkg && !isError)) {
    return (
      <>
        <PageHeader title="Payment package" purpose="Opening this package." />
        <Card>
          <CardContent>
            <SkeletonText lines={8} />
          </CardContent>
        </Card>
      </>
    );
  }

  if (!pkg || !values) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <>
        <PageHeader
          title="Payment package"
          purpose="This package could not be opened."
          actions={
            <Button variant="secondary" asChild>
              <Link to="/payments">
                <ArrowLeft aria-hidden="true" className="size-4" />
                Back to packages
              </Link>
            </Button>
          }
        />
        <Card className="border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              {missing ? 'That package could not be found' : 'Could not load this package'}
            </p>
            <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {missing
                ? 'It may have been cancelled, or the link may be to a package that never existed.'
                : (errorMessage(error) ?? 'The request did not complete.')}
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  const current = values;
  const standing = packageStanding(pkg.standing, pkg.standing_label);
  const submitted = pkg.standing === 'submitted';
  const busy = save.isPending || submit.isPending;
  const unfinished = pkg.problems.filter((problem) => !problem.is_blocking);
  const fieldProblem = (field: string) =>
    pkg.problems.find((problem) => problem.field === field)?.explanation;

  function change(next: Partial<FormValues>) {
    setValues({ ...current, ...next });
  }

  function persist() {
    setSavedAt(null);
    save.mutate(draftFrom(current), { onSuccess: () => setSavedAt(new Date().toISOString()) });
  }

  return (
    <>
      <PageHeader
        title={pkg.reference}
        purpose={purposeFor(pkg)}
        meta={
          <div className="flex flex-wrap items-center gap-[var(--space-3)]">
            <ToneBadge label={standing.label} tone={standing.tone} />
            <span className="text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              Started by {pkg.created_by_label || 'somebody'} ·{' '}
              <time dateTime={pkg.created_at} data-visual-volatile>
                {formatMoment(pkg.created_at)}
              </time>
            </span>
          </div>
        }
        actions={
          <>
            <Button variant="ghost" asChild>
              <Link to="/payments">
                <ArrowLeft aria-hidden="true" className="size-4" />
                All packages
              </Link>
            </Button>

            {pkg.can_edit ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => setDialog('add')}
                  disabled={busy}
                >
                  <Plus aria-hidden="true" className="size-4" />
                  Add invoices
                </Button>
                <Button
                  variant="secondary"
                  onClick={persist}
                  disabled={!dirty || busy}
                  isLoading={save.isPending}
                  loadingLabel="Saving"
                >
                  <Save aria-hidden="true" className="size-4" />
                  Save
                </Button>
              </>
            ) : null}

            {pkg.can_submit ? (
              <Button
                variant="primary"
                onClick={() => setDialog('submit')}
                // Refused while there are unsaved changes rather than saving
                // silently first. Everywhere else that shortcut is a courtesy;
                // here it would mean the figure somebody confirmed was not the
                // figure the package held when it went.
                disabled={busy || dirty}
                title={dirty ? 'Save your changes first.' : undefined}
              >
                <Send aria-hidden="true" className="size-4" />
                Send to the bank
              </Button>
            ) : null}

            {pkg.can_cancel ? (
              <Button variant="ghost" onClick={() => setDialog('cancel')}>
                <Ban aria-hidden="true" className="size-4" />
                Abandon
              </Button>
            ) : null}
          </>
        }
      />

      <div aria-live="polite">
        {save.error || remove.error ? (
          <Card className="mb-[var(--space-5)] border-[var(--color-danger-600)]">
            <CardContent>
              <p className="m-0 font-semibold text-[var(--color-danger-700)]">
                {remove.error ? 'That invoice was not taken out' : 'Your changes were not saved'}
              </p>
              <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text)]">
                {errorMessage(remove.error ?? save.error)}
              </p>
            </CardContent>
          </Card>
        ) : savedAt && !dirty ? (
          <p className="mb-[var(--space-5)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-success-700)]">
            Saved at{' '}
            {/* Fixed width so a longer clock reading cannot shift the rest of
                the sentence when the visual suite hides the time. */}
            <time
              dateTime={savedAt}
              data-visual-volatile
              className="inline-block w-[12rem] overflow-hidden align-bottom"
            >
              {formatMoment(savedAt)}
            </time>
            . Nothing has left the account.
          </p>
        ) : null}

        {refused.length > 0 ? (
          <Card className="mb-[var(--space-5)] border-[color-mix(in_srgb,var(--color-warning-600)_38%,white)]">
            <CardHeader>
              <CardTitle>
                <span className="inline-flex items-center gap-[var(--space-2)]">
                  <AlertTriangle
                    aria-hidden="true"
                    className="size-4 text-[var(--color-warning-600)]"
                  />
                  {refused.length === 1
                    ? 'One invoice could not go in'
                    : `${refused.length} invoices could not go in`}
                </span>
              </CardTitle>
              <CardDescription>
                The rest were added. These are named individually so you can see which, rather
                than being told the batch failed.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="m-0 flex list-none flex-col gap-[var(--space-2)] p-0">
                {refused.map((item) => (
                  <li
                    key={item.invoice_id}
                    className="text-[length:var(--text-body-sm)] text-[var(--color-text)]"
                  >
                    <span className="font-semibold">{item.invoice_reference}</span>{' '}
                    {item.explanation}
                  </li>
                ))}
              </ul>
              <Button
                variant="ghost"
                size="sm"
                className="mt-[var(--space-3)]"
                onClick={() => setRefused([])}
              >
                Dismiss
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="grid gap-[var(--space-6)] xl:grid-cols-[minmax(0,3fr)_minmax(21rem,2fr)]">
        <div className="flex min-w-0 flex-col gap-[var(--space-6)]">
          {pkg.blockers.length > 0 ? (
            <Card className="border-[var(--color-danger-600)]">
              <CardHeader>
                <CardTitle>
                  <span className="inline-flex items-center gap-[var(--space-2)]">
                    <ShieldAlert
                      aria-hidden="true"
                      className="size-4 text-[var(--color-danger-600)]"
                    />
                    {pkg.blockers.length === 1
                      ? 'A control has stopped this package'
                      : `${pkg.blockers.length} controls have stopped this package`}
                  </span>
                </CardTitle>
                <CardDescription>
                  Something in the package changed after it was added. None of these can be
                  overridden here.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="m-0 flex list-disc flex-col gap-[var(--space-2)] pl-[var(--space-5)]">
                  {pkg.blockers.map((problem) => (
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
              {/* Not "what was paid". Submitting sends an instruction; whether
                  the money arrived is a separate fact this platform learns from
                  the supplier, and a heading that pre-empted it would be the
                  one place the screen contradicted itself. */}
              <CardTitle>{submitted ? 'What went to the bank' : 'What is going out'}</CardTitle>
              <CardDescription>
                {submitted
                  ? 'Fixed at submission. These figures are what the bank was told, whatever has happened to the invoices since.'
                  : 'Each invoice was approved before it could be added. Taking one out returns it to approved and unpaid, ready for another package.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {pkg.lines.length === 0 ? (
                <p className="m-0 px-[var(--space-5)] py-[var(--space-5)] text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                  Nothing in it yet. Add the approved invoices this package is meant to pay.
                </p>
              ) : (
                <ul className="m-0 list-none p-0">
                  {pkg.lines.map((line) => {
                    const problem = lineStanding(line.is_still_payable, line.invoice_state_label);
                    return (
                      <li
                        key={line.invoice_id}
                        className="flex flex-col gap-[var(--space-2)] border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0 sm:flex-row sm:items-center sm:gap-[var(--space-4)]"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="m-0 truncate font-semibold text-[var(--color-text-strong)]">
                            {line.vendor_name}
                          </p>
                          <p className="m-0 truncate text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                            <Link
                              to={`/invoices/${line.invoice_id}`}
                              className="text-[var(--color-primary-700)]"
                            >
                              {line.invoice_number ?? line.invoice_reference}
                            </Link>
                            {line.due_date ? ` · due ${formatDate(line.due_date)}` : ''}
                          </p>
                        </div>

                        {problem ? (
                          <ToneBadge
                            label={problem.label}
                            tone={problem.tone}
                            className="shrink-0"
                          />
                        ) : null}

                        <MoneyDisplay
                          value={toMoneyValue(line.amount)}
                          size="md"
                          className="shrink-0 sm:min-w-[8rem] sm:text-right"
                        />

                        {pkg.can_edit ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            isLoading={remove.isPending && removing === line.invoice_id}
                            loadingLabel="Removing"
                            onClick={() => {
                              setRemoving(line.invoice_id);
                              setSavedAt(null);
                              remove.mutate({ invoiceId: line.invoice_id });
                            }}
                          >
                            <Trash2 aria-hidden="true" className="size-4" />
                            <span className="sr-only">
                              Take {line.invoice_number ?? line.invoice_reference} out of this
                              package
                            </span>
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <ManifestPanel
            packageId={pkg.id}
            manifest={manifest.data}
            isLoading={manifest.isLoading}
            unavailable={
              manifest.error instanceof ApiError && manifest.error.status === 409
                ? manifest.error.message
                : manifest.isError
                  ? (errorMessage(manifest.error) ?? 'The manifest could not be built.')
                  : undefined
            }
            isSubmitted={submitted}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-[var(--space-6)]">
          <Card>
            <CardHeader>
              <CardTitle>What it comes to</CardTitle>
              <CardDescription>
                {pkg.totals.length > 1
                  ? 'One figure per currency. They are separate amounts and there is no rate at which they add up.'
                  : 'The total the bank is being asked for.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CurrencyTotals totals={pkg.totals} emphasis />
              <p className="mt-[var(--space-3)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                {contentsSummary(pkg.lines.length, pkg.vendor_count)}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{pkg.can_edit ? 'How and when' : 'How it was paid'}</CardTitle>
              <CardDescription>
                {pkg.can_edit
                  ? 'Both are needed before a manifest can be produced, because the bank needs to know which instruction this is and for what date.'
                  : 'As it stood when the package was sent.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {pkg.can_edit ? (
                <div className="flex flex-col gap-[var(--space-4)]">
                  <Field
                    label="How it is paid"
                    required
                    help="Changes what the bank needs from the manifest."
                    error={fieldProblem('payment_method')}
                  >
                    {({ inputId, describedBy, invalid }) => (
                      <Select
                        id={inputId}
                        aria-describedby={describedBy}
                        invalid={invalid}
                        value={current.paymentMethod}
                        disabled={busy}
                        onChange={(event) =>
                          change({ paymentMethod: event.target.value as PaymentMethod | '' })
                        }
                      >
                        <option value="">Not chosen yet</option>
                        {METHODS.map((method) => (
                          <option key={method.value} value={method.value}>
                            {method.label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>

                  <Field
                    label="Intended payment date"
                    required
                    help="The date the money is meant to leave. It goes on the manifest."
                    error={fieldProblem('intended_payment_date')}
                  >
                    {({ inputId, describedBy, invalid }) => (
                      <Input
                        id={inputId}
                        type="date"
                        aria-describedby={describedBy}
                        invalid={invalid}
                        value={current.intendedPaymentDate}
                        disabled={busy}
                        onChange={(event) => change({ intendedPaymentDate: event.target.value })}
                      />
                    )}
                  </Field>

                  <Field
                    label="What this package is for"
                    help="For the people who will read this months from now. “Suppliers, week of 12 May” is enough."
                  >
                    {({ inputId, describedBy }) => (
                      <Textarea
                        id={inputId}
                        aria-describedby={describedBy}
                        rows={3}
                        maxLength={500}
                        value={current.description}
                        disabled={busy}
                        onChange={(event) => change({ description: event.target.value })}
                      />
                    )}
                  </Field>
                </div>
              ) : (
                <dl className="m-0">
                  <DetailRow label="How it is paid">
                    {pkg.payment_method_label ?? 'Not stated'}
                  </DetailRow>
                  <DetailRow label="Intended payment date">
                    {formatDate(pkg.intended_payment_date)}
                  </DetailRow>
                  <DetailRow label="What it is for">{pkg.description || 'Not stated'}</DetailRow>
                </dl>
              )}
            </CardContent>
          </Card>

          {pkg.can_edit && unfinished.length > 0 ? (
            <Card className="border-[color-mix(in_srgb,var(--color-warning-600)_38%,white)]">
              <CardHeader>
                <CardTitle>Before this can be sent</CardTitle>
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

          {submitted ? (
            <Card>
              <CardHeader>
                <CardTitle>Evidence of submission</CardTitle>
                <CardDescription>
                  What was sent, by whom, and under what reference. This is what a payment is
                  traced back to.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="m-0">
                  <DetailRow label="The bank's reference">
                    {pkg.submission_reference ?? '—'}
                  </DetailRow>
                  <DetailRow label="Sent by">{pkg.submitted_by_label ?? '—'}</DetailRow>
                  <DetailRow label="Sent at">
                    <time dateTime={pkg.submitted_at ?? undefined} data-visual-volatile>
                      {formatMoment(pkg.submitted_at)}
                    </time>
                  </DetailRow>
                  <DetailRow label="Invoices sent">{pkg.manifest_line_count ?? '—'}</DetailRow>
                </dl>
                <p className="mt-[var(--space-4)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                  Every invoice in this package is now with the bank and not yet confirmed paid.
                  Each supplier is asked to confirm the payment arrived, and only that turns an
                  invoice into a paid one.
                </p>
              </CardContent>
            </Card>
          ) : null}

          {submitted && asksSuppliers ? <AskSuppliersCard packageId={pkg.id} /> : null}

          {pkg.cancelled_at ? (
            <Card>
              <CardHeader>
                <CardTitle>Abandoned</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text)]">
                  Abandoned on{' '}
                  <time dateTime={pkg.cancelled_at} data-visual-volatile>
                    {formatMoment(pkg.cancelled_at)}
                  </time>
                  {pkg.cancelled_reason ? `: ${pkg.cancelled_reason}` : '.'}
                </p>
                <p className="mt-[var(--space-3)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                  Everything it held went back to being approved and unpaid, and can go into
                  another package.
                </p>
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
          Nothing has been sent either way. The invoices in this package stay in it.
        </p>
      </Modal>

      <AddInvoicesDialog
        open={dialog === 'add'}
        invoices={eligible.data ?? []}
        isLoading={eligible.isLoading}
        isPending={add.isPending}
        error={errorMessage(add.error)}
        onClose={() => setDialog(null)}
        onConfirm={(invoiceIds) => {
          setSavedAt(null);
          add.mutate(
            { invoiceIds },
            {
              onSuccess: (result) => {
                setRefused(result.refused);
                setDialog(null);
              },
            },
          );
        }}
      />

      <SubmitDialog
        open={dialog === 'submit'}
        reference={pkg.reference}
        totals={pkg.totals}
        invoiceCount={pkg.lines.length}
        vendorCount={pkg.vendor_count}
        digest={manifest.data?.digest}
        isPending={submit.isPending}
        error={errorMessage(submit.error)}
        onClose={() => setDialog(null)}
        onConfirm={(submissionReference) => {
          // "Nothing has left the account" stops being true the moment this
          // succeeds, so the line saying it goes before the request does.
          setSavedAt(null);
          submit.mutate({ submissionReference }, { onSuccess: () => setDialog(null) });
        }}
      />

      <ReasonDialog
        open={dialog === 'cancel'}
        title="Abandon this package"
        description="Everything in it goes back to being approved and unpaid, and can be put in another package. Nothing has been sent, so nothing is being recalled."
        label="Why you are abandoning it"
        help="Recorded against the package permanently."
        confirmLabel="Abandon it"
        danger
        isPending={cancel.isPending}
        error={errorMessage(cancel.error)}
        onClose={() => setDialog(null)}
        onConfirm={(reason) => {
          setSavedAt(null);
          cancel.mutate({ reason }, { onSuccess: () => setDialog(null) });
        }}
      />
    </>
  );
}

/**
 * The line under the title.
 *
 * Says the most urgent true thing. A control that has fired outranks everything,
 * because it is the reason nothing else is happening; then what the package is
 * waiting on, which is the question it was opened to answer.
 */
function purposeFor(pkg: Package): string {
  if (pkg.standing === 'submitted') {
    return pkg.submission_reference
      ? `Sent to the bank under ${pkg.submission_reference}. What it contained can no longer change.`
      : 'Sent to the bank. What it contained can no longer change.';
  }
  if (pkg.standing === 'cancelled') {
    return 'Abandoned. Everything it held went back to being approved and unpaid.';
  }
  if (pkg.blockers.length > 0) {
    return pkg.blockers.length === 1
      ? 'A control has stopped this package. It is set out below.'
      : `${pkg.blockers.length} controls have stopped this package. They are set out below.`;
  }
  if (pkg.lines.length === 0) {
    return 'Empty. Add the approved invoices this package is meant to pay.';
  }
  const outstanding = pkg.problems.length;
  if (outstanding > 0) {
    return `${outstanding} ${outstanding === 1 ? 'thing' : 'things'} still to settle before this can be sent.`;
  }
  return 'Ready to send. Nothing has left the account until you record it as sent.';
}
