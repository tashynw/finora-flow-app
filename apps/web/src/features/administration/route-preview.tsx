import { useState } from 'react';
import { ArrowRight, CircleSlash } from 'lucide-react';

import { errorMessage } from '@/lib/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/field';
import { SkeletonText } from '@/components/ui/skeleton';
import { useRoutePreview } from '@/features/administration/use-administration';

/**
 * What a given amount would actually do.
 *
 * Answered by the same endpoint the submission path uses. Working the route out
 * in the browser would produce a second implementation of the routing rules, and
 * the moment the two disagreed this screen would be the more convincing of the
 * pair while the platform quietly did something else.
 *
 * An amount with no route says so in words. An empty list would read as "no
 * approval needed", which is the opposite of what an unroutable amount means:
 * the record cannot be submitted at all.
 */
export function RoutePreview({ recordType }: { recordType: string }) {
  const [amount, setAmount] = useState('250000');
  const [currency, setCurrency] = useState('JMD');
  const [department, setDepartment] = useState('');

  const trimmed = amount.trim().replace(/,/g, '');
  const parsed = Number(trimmed);
  const minorUnits =
    trimmed && Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : null;

  const { data, isFetching, isError, error } = useRoutePreview(
    recordType,
    minorUnits,
    currency,
    department,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Try an amount</CardTitle>
        <CardDescription>
          What the live rules would do with a record of this size. Worked out by the platform
          itself, so what is shown here is what would happen.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-[var(--space-5)]">
        <div className="grid gap-[var(--space-4)] sm:grid-cols-3">
          <Field label="Amount" formatHint="1234.56">
            {({ inputId, describedBy, invalid }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                numeric
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            )}
          </Field>
          <Field label="Currency">
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={currency}
                maxLength={3}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              />
            )}
          </Field>
          <Field label="Department" help="Leave empty for a record from anywhere.">
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={department}
                maxLength={200}
                onChange={(event) => setDepartment(event.target.value)}
              />
            )}
          </Field>
        </div>

        <div aria-live="polite">
          {minorUnits === null ? (
            <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              Enter an amount to see what it would do.
            </p>
          ) : isError ? (
            <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-danger-700)]">
              {errorMessage(error) ?? 'The route could not be worked out.'}
            </p>
          ) : isFetching && !data ? (
            <SkeletonText lines={2} />
          ) : data?.unreachable ? (
            <p className="m-0 flex items-start gap-[var(--space-2)] text-[var(--text-body-sm)] text-[var(--color-danger-700)]">
              <CircleSlash aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="font-semibold">
                  {data.amount_formatted} cannot be submitted at all.
                </span>{' '}
                {data.unreachable}
              </span>
            </p>
          ) : data ? (
            <div>
              <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                {data.amount_formatted}
                {data.department ? ` from ${data.department}` : ''} goes to:
              </p>
              <ol className="mt-2 mb-0 flex flex-wrap items-center gap-[var(--space-2)] p-0">
                {data.steps.map((step, index) => (
                  <li key={step} className="flex list-none items-center gap-[var(--space-2)]">
                    {index > 0 ? (
                      <ArrowRight
                        aria-hidden="true"
                        className="size-4 text-[var(--color-text-subtle)]"
                      />
                    ) : null}
                    <span className="rounded-[var(--radius-sm)] bg-[var(--color-surface-subtle)] px-[var(--space-3)] py-1 text-[var(--text-body-sm)] font-semibold text-[var(--color-text-strong)]">
                      {step}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
