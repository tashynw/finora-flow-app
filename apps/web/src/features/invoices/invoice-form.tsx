import { useMemo, useState } from 'react';

import type {
  InvoiceDetail,
  InvoiceDraftRequest,
  InvoiceReferenceData,
  ReferenceData,
} from '@finora/shared-types';

import { Field, Input, Select } from '@/components/ui/field';
import { amountInputValue, parseAmount } from '@/lib/money';

/**
 * The editor for an invoice that has not yet been sent for confirmation.
 *
 * Laid out in the order somebody transcribes a supplier's bill: who sent it,
 * their reference for it, what it is for, what it costs, when they expect
 * payment, what approved spend it draws on, and who can vouch that the goods
 * arrived. Nothing is behind a step, because whoever is filling this in has the
 * document open beside them and wants to copy it once.
 *
 * Two things separate this from the estimate form.
 *
 * The linkage selectors carry running balances — what is left of an estimate,
 * what is left of an order — because the question a person actually has when
 * choosing one is "will this fit", and making them subtract two numbers to find
 * out is how overruns get recorded by accident.
 *
 * The completeness and control rules are not evaluated here at all. The server
 * returns what is outstanding on every read and this form marks the fields that
 * list names. A copy of the tolerance rules in the browser would eventually
 * disagree with the server's copy, and the server's is the one that stops a
 * payment.
 */

const OTHER_VENDOR = '__other__';

export interface InvoiceFormValues {
  vendorId: string;
  vendorName: string;
  description: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  amount: string;
  currency: string;
  estimateId: string;
  purchaseOrderId: string;
  costCentreId: string;
  glAccountId: string;
  requesterId: string;
}

/** The saved invoice as form text. */
export function valuesFrom(invoice: InvoiceDetail): InvoiceFormValues {
  const currency = invoice.currency ?? 'JMD';
  return {
    vendorId: invoice.vendor_id ?? (invoice.vendor_name ? OTHER_VENDOR : ''),
    vendorName: invoice.vendor_name,
    description: invoice.description,
    invoiceNumber: invoice.invoice_number ?? '',
    invoiceDate: invoice.invoice_date ?? '',
    dueDate: invoice.due_date ?? '',
    amount: amountInputValue(invoice.total_minor_units, currency),
    currency,
    estimateId: invoice.estimate?.id ?? '',
    purchaseOrderId: invoice.purchase_order?.id ?? '',
    costCentreId: invoice.cost_centre?.id ?? '',
    glAccountId: invoice.gl_account?.id ?? '',
    requesterId: invoice.sign_off.requester_id ?? invoice.suggested_requester_id ?? '',
  };
}

/** The form as the request body the API takes. */
export function draftFrom(values: InvoiceFormValues): InvoiceDraftRequest {
  const minorUnits = parseAmount(values.amount, values.currency);
  return {
    vendor_name: values.vendorName.trim(),
    description: values.description.trim(),
    vendor_id: values.vendorId && values.vendorId !== OTHER_VENDOR ? values.vendorId : null,
    invoice_number: values.invoiceNumber.trim() || null,
    invoice_date: values.invoiceDate || null,
    due_date: values.dueDate || null,
    total_minor_units: minorUnits,
    // Sent whenever an amount is, because an amount without a currency is not a
    // sum of money. Sent as null with no amount so a currency chosen and then
    // emptied does not linger on the record.
    currency: minorUnits === null ? null : values.currency,
    estimate_id: values.estimateId || null,
    purchase_order_id: values.purchaseOrderId || null,
    cost_centre_id: values.costCentreId || null,
    gl_account_id: values.glAccountId || null,
    requester_id: values.requesterId || null,
  };
}

export function isSameDraft(a: InvoiceDraftRequest, b: InvoiceDraftRequest): boolean {
  return (Object.keys(a) as (keyof InvoiceDraftRequest)[]).every((key) => a[key] === b[key]);
}

/**
 * Whether nothing has been entered on this invoice yet.
 *
 * Used to decide whether to mark the empty boxes as problems. A brand-new
 * invoice is missing everything by definition, and colouring the whole form red
 * before anybody has typed a character accuses them of a mistake they have not
 * had the chance to make. The checklist above the form still lists all of it.
 *
 * The currency is ignored because it defaults and is therefore never empty;
 * counting it would make every invoice look started.
 */
export function isBlankDraft(draft: InvoiceDraftRequest): boolean {
  return (
    !draft.vendor_id &&
    !draft.vendor_name &&
    !draft.description &&
    !draft.invoice_number &&
    !draft.invoice_date &&
    !draft.due_date &&
    draft.total_minor_units === null &&
    !draft.estimate_id &&
    !draft.purchase_order_id &&
    !draft.cost_centre_id &&
    !draft.gl_account_id &&
    !draft.requester_id
  );
}

export interface InvoiceFormProps {
  values: InvoiceFormValues;
  onChange: (values: InvoiceFormValues) => void;
  reference: ReferenceData | undefined;
  /** Approved estimates and open orders, with what is left of each. */
  linkable: InvoiceReferenceData | undefined;
  /** Field names the server says are outstanding, keyed to their explanation. */
  problems: Record<string, string>;
  /** Fields edited since the last save, whose saved problems no longer apply. */
  touched: Set<string>;
  disabled?: boolean;
}

export function InvoiceForm({
  values,
  onChange,
  reference,
  linkable,
  problems,
  touched,
  disabled = false,
}: InvoiceFormProps) {
  const [showVendorName, setShowVendorName] = useState(
    () => values.vendorId === OTHER_VENDOR || (!values.vendorId && Boolean(values.vendorName)),
  );

  const vendors = reference?.vendors ?? [];
  const currencies = reference?.currencies ?? [values.currency];

  /**
   * A problem for this field, unless it has been edited since the save the
   * problem was computed from. Once somebody types in a box, what the server
   * last said about it is out of date and repeating it is a lie about their work.
   */
  const errorFor = useMemo(
    () => (name: string) => (touched.has(name) ? undefined : problems[name]),
    [problems, touched],
  );

  const set = (patch: Partial<InvoiceFormValues>) => onChange({ ...values, ...patch });

  /**
   * Only what this invoice could actually be billed against.
   *
   * Filtered to the chosen supplier once there is one, because an estimate for a
   * different supplier is not a shorter list to read past — it is an option that
   * cannot be right. Whatever is already linked stays in the list regardless, so
   * changing the supplier does not silently blank a link somebody made.
   */
  const estimates = (linkable?.approved_estimates ?? []).filter(
    (row) => !values.vendorId || row.id === values.estimateId || row.vendor_name === values.vendorName,
  );
  const orders = (linkable?.open_purchase_orders ?? []).filter(
    (row) =>
      !values.vendorId || row.id === values.purchaseOrderId || row.vendor_name === values.vendorName,
  );

  return (
    <div className="flex flex-col gap-[var(--space-5)]">
      <div className="grid gap-[var(--space-5)] md:grid-cols-2">
        <Field
          label="Supplier"
          required
          // Carried by the name box instead when one is showing, so a missing
          // supplier is not reported twice for one gap.
          error={showVendorName ? undefined : (errorFor('vendor_name') ?? errorFor('vendor_id'))}
          help="Choose from the suppliers finance has set up. Payment only ever goes to a recorded supplier."
        >
          {({ inputId, describedBy, invalid }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={disabled}
              value={values.vendorId}
              onChange={(event) => {
                const choice = event.target.value;
                if (choice === OTHER_VENDOR) {
                  setShowVendorName(true);
                  set({ vendorId: OTHER_VENDOR, vendorName: '' });
                  return;
                }
                setShowVendorName(false);
                const vendor = vendors.find((row) => row.id === choice);
                set({ vendorId: choice, vendorName: vendor?.name ?? '' });
              }}
            >
              <option value="">Choose a supplier</option>
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendor.name}
                </option>
              ))}
              <option value={OTHER_VENDOR}>Not in this list</option>
            </Select>
          )}
        </Field>

        {showVendorName ? (
          <Field
            label="Supplier name"
            required
            error={errorFor('vendor_name') ?? errorFor('vendor_id')}
            help="Typed in because this supplier is not set up yet. Finance has to add them to the supplier master before this can be paid."
          >
            {({ inputId, describedBy, invalid }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                disabled={disabled}
                value={values.vendorName}
                maxLength={300}
                onChange={(event) => set({ vendorName: event.target.value })}
              />
            )}
          </Field>
        ) : null}

        <Field
          label="Supplier’s invoice number"
          required
          error={errorFor('invoice_number')}
          help="Their reference, exactly as printed. It is how they will refer to it, and it is what stops the same bill being paid twice."
        >
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={disabled}
              value={values.invoiceNumber}
              maxLength={120}
              onChange={(event) => set({ invoiceNumber: event.target.value })}
            />
          )}
        </Field>
      </div>

      <Field
        label="What was supplied"
        required
        error={errorFor('description')}
        help="One line the person confirming receipt can recognise without opening the document."
      >
        {({ inputId, describedBy, invalid }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            invalid={invalid}
            disabled={disabled}
            value={values.description}
            maxLength={500}
            onChange={(event) => set({ description: event.target.value })}
          />
        )}
      </Field>

      <div className="grid gap-[var(--space-5)] md:grid-cols-[2fr_1fr]">
        <Field
          label="Invoice total"
          required
          error={errorFor('total')}
          // The hint is a fragment of the sentence before it rather than a token
          // dropped after it, because a bare "1234.56" under a box reads as a
          // value somebody left behind.
          help="The amount the supplier is charging, as the invoice states it. Figures only, in the form"
          formatHint="1234.56"
        >
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={disabled}
              numeric
              inputMode="decimal"
              value={values.amount}
              onChange={(event) => set({ amount: event.target.value })}
            />
          )}
        </Field>

        <Field label="Currency" required>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              disabled={disabled}
              value={values.currency}
              onChange={(event) => set({ currency: event.target.value })}
            >
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <div className="grid gap-[var(--space-5)] md:grid-cols-2">
        <Field
          label="Date on the invoice"
          required
          error={errorFor('invoice_date')}
          help="As printed by the supplier, not today’s date."
        >
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              type="date"
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={disabled}
              value={values.invoiceDate}
              onChange={(event) => set({ invoiceDate: event.target.value })}
            />
          )}
        </Field>

        <Field
          label="Payment due"
          error={errorFor('due_date')}
          help="When the supplier expects to be paid. It sets how hard this is chased through approval."
        >
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              type="date"
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={disabled}
              value={values.dueDate}
              onChange={(event) => set({ dueDate: event.target.value })}
            />
          )}
        </Field>
      </div>

      <div className="grid gap-[var(--space-5)] md:grid-cols-2">
        <Field
          label="Approved estimate"
          error={errorFor('estimate_id')}
          help="The approved spend this bill draws on. Leave it unset only if there was never an estimate."
        >
          {({ inputId, describedBy, invalid }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={disabled}
              value={values.estimateId}
              onChange={(event) => set({ estimateId: event.target.value })}
            >
              <option value="">No estimate</option>
              {estimates.map((estimate) => (
                <option key={estimate.id} value={estimate.id}>
                  {estimate.reference} — {estimate.vendor_name}
                  {estimate.remaining_formatted ? ` — ${estimate.remaining_formatted} left` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label="Purchase order"
          error={errorFor('purchase_order_id')}
          help="Required above the order threshold. The amount left on each order is shown beside it."
        >
          {({ inputId, describedBy, invalid }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={disabled}
              value={values.purchaseOrderId}
              onChange={(event) => set({ purchaseOrderId: event.target.value })}
            >
              <option value="">No order</option>
              {orders.map((order) => (
                <option key={order.id} value={order.id}>
                  {order.number} — {order.vendor_name} — {order.remaining_formatted} left
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <div className="grid gap-[var(--space-5)] md:grid-cols-2">
        <Field
          label="Cost centre"
          required
          error={errorFor('cost_centre_id')}
          help="Whose budget this comes out of. It decides who has to approve it."
        >
          {({ inputId, describedBy, invalid }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={disabled}
              value={values.costCentreId}
              onChange={(event) => set({ costCentreId: event.target.value })}
            >
              <option value="">Choose a cost centre</option>
              {(reference?.cost_centres ?? []).map((centre) => (
                <option key={centre.id} value={centre.id}>
                  {centre.code} — {centre.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label="GL account"
          help="Optional. Set it now and the coding is done before month end asks for it."
        >
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              disabled={disabled}
              value={values.glAccountId}
              onChange={(event) => set({ glAccountId: event.target.value })}
            >
              <option value="">Leave for finance</option>
              {(reference?.gl_accounts ?? []).map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} — {account.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <Field
        label="Who confirms it arrived"
        required
        error={errorFor('requester_id')}
        help="The person who asked for this and can say the goods or services turned up. They are asked before it goes to any approver, and chased every three working hours until they answer."
      >
        {({ inputId, describedBy, invalid }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            invalid={invalid}
            disabled={disabled}
            value={values.requesterId}
            onChange={(event) => set({ requesterId: event.target.value })}
          >
            <option value="">Choose a person</option>
            {(linkable?.people ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </div>
  );
}
