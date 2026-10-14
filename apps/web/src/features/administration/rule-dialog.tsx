import { useEffect, useId, useState } from 'react';

import type { ApprovalLevel, MatrixRuleOut, MatrixRuleRequest } from '@finora/shared-types';

import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { useDepartments } from '@/features/administration/use-departments';

/**
 * Writing a rule into the matrix.
 *
 * The same dialog adds and replaces, because replacing is adding with the old
 * rule named: there is no edit. A rule that could be edited in place would
 * rewrite history, and an approval given last quarter has to remain explicable
 * by the rule that was live when it was given.
 *
 * Amounts are typed in major units and converted once, on submit. Asking an
 * administrator to think in cents is how a band ends up a hundred times too
 * wide.
 */
/** Matches the Prisma `Currency` enum. A rule accepts only these. */
const RULE_CURRENCIES = ['JMD', 'USD'] as const;

const LEVELS: { id: ApprovalLevel; label: string }[] = [
  { id: 'unit_head', label: 'Unit Head' },
  { id: 'manager', label: 'Manager' },
  { id: 'hod', label: 'Head of Department' },
  { id: 'coo', label: 'COO' },
];

interface RuleFormValues {
  name: string;
  level: ApprovalLevel;
  stepOrder: string;
  min: string;
  max: string;
  currency: string;
  department: string;
  isParallel: boolean;
  reason: string;
}

function blankValues(): RuleFormValues {
  return {
    name: '',
    level: 'unit_head',
    stepOrder: '1',
    min: '',
    max: '',
    currency: 'JMD',
    department: '',
    isParallel: false,
    reason: '',
  };
}

function valuesFrom(rule: MatrixRuleOut): RuleFormValues {
  return {
    name: rule.name,
    level: rule.level,
    stepOrder: String(rule.step_order),
    min: majorUnits(rule.min_amount_minor_units),
    max: rule.max_amount_minor_units === null ? '' : majorUnits(rule.max_amount_minor_units),
    currency: rule.currency,
    department: rule.department ?? '',
    isParallel: rule.is_parallel,
    reason: '',
  };
}

function majorUnits(minorUnits: number): string {
  return (minorUnits / 100).toFixed(2);
}

/**
 * Minor units from what was typed, or null when it is not a number.
 *
 * Rounded rather than truncated, because 10.005 typed by a person means the cent
 * above and not the cent below, and floating point will present it as
 * 10.004999999 given the chance.
 */
function minorUnits(typed: string): number | null {
  const trimmed = typed.trim().replace(/,/g, '');
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

export interface RuleDialogProps {
  open: boolean;
  recordType: string;
  /** The rule being replaced, or null when adding a new one. */
  replacing: MatrixRuleOut | null;
  liveRules: MatrixRuleOut[];
  isPending: boolean;
  error: string | undefined;
  onClose: () => void;
  onConfirm: (body: MatrixRuleRequest) => void;
}

export function RuleDialog({
  open,
  recordType,
  replacing,
  liveRules,
  isPending,
  error,
  onClose,
  onConfirm,
}: RuleDialogProps) {
  const [values, setValues] = useState<RuleFormValues>(blankValues);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const parallelId = useId();
  const departments = useDepartments(true, open);

  // Reset on open rather than on close, so a refusal from the server leaves what
  // was typed on screen to correct.
  useEffect(() => {
    if (!open) return;
    setValues(replacing ? valuesFrom(replacing) : blankValues());
    setErrors({});
  }, [open, replacing]);

  useEffect(() => {
    if (!open || !replacing?.department) return;
    const named = replacing.department.trim();
    const match = (departments.data ?? []).find(
      (row) => row.name.toLowerCase() === named.toLowerCase(),
    );
    if (!match) return;
    setValues((current) =>
      current.department === named ? { ...current, department: match.costCentreNumber } : current,
    );
  }, [open, replacing, departments.data]);

  const set = <K extends keyof RuleFormValues>(key: K, value: RuleFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const floor = minorUnits(values.min);
  const ceiling = values.max.trim() ? minorUnits(values.max) : null;
  const step = Number(values.stepOrder);

  const inverted = floor !== null && ceiling !== null && ceiling < floor;

  function submit() {
    const next: Record<string, string> = {};
    if (!values.name.trim()) next.name = 'A name is required.';
    if (!Number.isInteger(step) || step < 1) next.step = 'Step must be a whole number of at least 1.';
    if (floor === null) next.min = 'Enter the bottom of the band.';
    if (values.max.trim() && ceiling === null) next.max = 'Enter a number, or leave the top empty.';
    else if (inverted) next.max = 'The top of the band is below the bottom of it.';
    if (!values.reason.trim()) next.reason = 'A reason is required.';
    setErrors(next);
    if (Object.keys(next).length > 0 || floor === null) return;
    onConfirm({
      name: values.name.trim(),
      record_type: recordType,
      level: values.level,
      step_order: step,
      min_amount_minor_units: floor,
      max_amount_minor_units: ceiling,
      currency: values.currency,
      department: values.department.trim() || null,
      is_parallel: values.isParallel,
      reason: values.reason.trim(),
      supersedes_id: replacing?.id ?? null,
    });
  }

  // Somebody else already at this step number in this band is what parallelism
  // means, so the box explains itself against what is actually there rather than
  // in the abstract.
  const selectedDepartment = (departments.data ?? []).find(
    (row) => row.costCentreNumber === values.department || row.name === values.department,
  );
  const departmentName = selectedDepartment?.name ?? values.department.trim();

  const alongside = liveRules.filter(
    (rule) =>
      rule.step_order === step &&
      rule.id !== replacing?.id &&
      (rule.department ?? '') === departmentName,
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={replacing ? 'Replace this rule' : 'Add a rule'}
      description={
        replacing
          ? `“${replacing.name}” is retired and this rule takes its place, from the next record submitted. Records already routed keep the route they were given.`
          : 'The rule applies to records submitted from now on. Nothing already in flight changes.'
      }
      busy={isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            Back
          </Button>
          <Button
            variant="primary"
            isLoading={isPending}
            loadingLabel="Saving"
            onClick={submit}
          >
            {replacing ? 'Replace it' : 'Add it'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[var(--space-5)]">
        {error ? (
          <p
            role="alert"
            className="m-0 rounded-[var(--radius-sm)] border border-[var(--color-danger-600)] bg-[var(--color-danger-50)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-body-sm)] text-[var(--color-danger-700)]"
          >
            {error}
          </p>
        ) : null}

        <Field
          label="What this rule is called"
          required
          help="Written for whoever reads the matrix next. “Manager for spend over a million” beats “Rule 4”."
          error={errors.name}
        >
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              value={values.name}
              maxLength={200}
              disabled={isPending}
              onChange={(event) => set('name', event.target.value)}
            />
          )}
        </Field>

        <div className="grid gap-[var(--space-4)] sm:grid-cols-2">
          <Field label="Who approves" required help="The level, not the person. Who holds that level is set separately.">
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={values.level}
                disabled={isPending}
                onChange={(event) => set('level', event.target.value as ApprovalLevel)}
              >
                {LEVELS.map((level) => (
                  <option key={level.id} value={level.id}>
                    {level.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            label="Step"
            required
            help="Steps run in order. Two rules on the same step decide together."
            error={errors.step}
          >
            {({ inputId, describedBy, invalid }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                numeric
                inputMode="numeric"
                value={values.stepOrder}
                disabled={isPending}
                onChange={(event) => set('stepOrder', event.target.value)}
              />
            )}
          </Field>
        </div>

        <div className="grid gap-[var(--space-4)] sm:grid-cols-3">
          <Field label="Currency" required help="Bands are per currency.">
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={values.currency}
                disabled={isPending}
                onChange={(event) => set('currency', event.target.value)}
              >
                {RULE_CURRENCIES.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="From" required help="Included in the band." formatHint="1234.56" error={errors.min}>
            {({ inputId, describedBy, invalid }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                numeric
                inputMode="decimal"
                value={values.min}
                disabled={isPending}
                onChange={(event) => set('min', event.target.value)}
              />
            )}
          </Field>

          <Field
            label="To"
            help="Also included. Leave empty for the top band, so nothing is above the matrix."
            formatHint="1234.56"
            error={errors.max ?? (inverted ? 'The top of the band is below the bottom of it.' : undefined)}
          >
            {({ inputId, describedBy, invalid }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                numeric
                inputMode="decimal"
                value={values.max}
                disabled={isPending}
                onChange={(event) => set('max', event.target.value)}
              />
            )}
          </Field>
        </div>

        <Field
          label="Department"
          help="Leave empty to apply everywhere. A rule for one department applies only to records from it."
        >
          {({ inputId, describedBy }) => (
            <Combobox
              id={inputId}
              describedBy={describedBy}
              value={values.department}
              disabled={isPending}
              placeholder="All departments"
              emptyLabel="No department found."
              clearLabel="All departments"
              onChange={(value) => set('department', value)}
              items={(departments.data ?? [])
                .filter(
                  (row) =>
                    row.isActive ||
                    row.costCentreNumber === values.department ||
                    row.name.toLowerCase() === (replacing?.department ?? '').trim().toLowerCase(),
                )
                .map((row) => ({
                  value: row.costCentreNumber,
                  label: `${row.name} · ${row.costCentreNumber}`,
                }))}
            />
          )}
        </Field>

        <div className="flex items-start gap-[var(--space-3)]">
          <input
            id={parallelId}
            type="checkbox"
            checked={values.isParallel}
            disabled={isPending}
            aria-describedby={`${parallelId}-help`}
            onChange={(event) => set('isParallel', event.target.checked)}
            className="mt-1 size-4 accent-[var(--color-primary-600)]"
          />
          <div>
            <label
              htmlFor={parallelId}
              className="block text-[length:var(--text-body-sm)] font-semibold text-[var(--color-text-strong)]"
            >
              Decides alongside others on this step
            </label>
            <p
              id={`${parallelId}-help`}
              className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]"
            >
              {alongside.length > 0
                ? `${alongside.map((rule) => rule.level_label).join(' and ')} ${
                    alongside.length === 1 ? 'is' : 'are'
                  } already on step ${step}. Both must agree, in any order, before the route moves on.`
                : 'Nothing else is on this step yet, so this changes nothing until something is.'}
            </p>
          </div>
        </div>

        <Field
          label="Why this rule exists"
          required
          help="Recorded against the change. Whoever audits the matrix reads this rather than guessing."
          error={errors.reason}
        >
          {({ inputId, describedBy, invalid }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              rows={3}
              value={values.reason}
              maxLength={500}
              disabled={isPending}
              onChange={(event) => set('reason', event.target.value)}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}
