import { useState } from 'react';
import { AlertTriangle, Info, Plus, Scale } from 'lucide-react';

import type { MatrixOut, MatrixRuleOut } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import { ReasonDialog } from '@/features/shared/reason-dialog';
import { RuleDialog } from '@/features/administration/rule-dialog';
import { RoutePreview } from '@/features/administration/route-preview';
import {
  RECORD_TYPES,
  useAddRule,
  useMatrix,
  useRetireRule,
} from '@/features/administration/use-administration';

/**
 * The approval matrix, one record type at a time.
 *
 * Three things are on this screen and the order of them is the argument. The
 * rules come first because they are what is being edited. What the matrix
 * currently does at a spread of amounts comes next, because a list of bands is
 * not a route and reading one off the other by eye is how a hole gets missed.
 * The faults and gaps come first of all when there are any, because a matrix
 * that contradicts itself will refuse work at submission time, in front of
 * somebody who cannot fix it.
 *
 * Rules are never edited in place. Changing one retires it and writes a new one
 * pointing back, so a decision made last quarter can still be explained by the
 * rule that was live when it was made.
 */
export function MatrixPage() {
  const [recordType, setRecordType] = useState<string>(RECORD_TYPES[0].id);
  const [showRetired, setShowRetired] = useState(false);
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<MatrixRuleOut | null>(null);
  const [retiring, setRetiring] = useState<MatrixRuleOut | null>(null);

  const { data, isLoading, isError, error } = useMatrix(recordType, showRetired);
  const addRule = useAddRule(recordType);
  const retireRule = useRetireRule(recordType);

  const rules = data?.rules ?? [];
  const live = rules.filter((rule) => rule.is_active);

  return (
    <>
      <PageHeader
        title="Approval matrix"
        purpose="Who has to agree to what, by amount. A change here takes effect on the next record submitted; records already in flight keep the route they were given."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" className="size-4" />
            Add a rule
          </Button>
        }
      />

      <div
        role="group"
        aria-label="Choose a record type"
        className="mb-[var(--space-4)] flex flex-wrap gap-[var(--space-2)]"
      >
        {RECORD_TYPES.map((option) => (
          <Button
            key={option.id}
            variant={recordType === option.id ? 'primary' : 'ghost'}
            size="sm"
            aria-pressed={recordType === option.id}
            onClick={() => setRecordType(option.id)}
          >
            {option.label}
          </Button>
        ))}
      </div>

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not load the matrix
            </p>
            <p className="mt-2 m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              {errorMessage(error) ?? 'The request did not complete.'} Nothing has been changed.
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
      ) : data ? (
        <div className="flex flex-col gap-[var(--space-6)]">
          <MatrixVerdict matrix={data} />

          <Card>
            <CardHeader className="flex-row items-start justify-between gap-[var(--space-4)]">
              <div>
                <CardTitle>Rules</CardTitle>
                <CardDescription>
                  Each rule puts one level into the route for records in its band. Two levels
                  sharing a step number decide together rather than one after the other.
                </CardDescription>
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={showRetired}
                onClick={() => setShowRetired(!showRetired)}
              >
                {showRetired ? 'Hide retired' : 'Show retired'}
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {rules.length === 0 ? (
                <EmptyState
                  icon={Scale}
                  title="No rules for this record type"
                  explanation="With no rules, nothing of this kind can be submitted: the platform will not invent a route, and refuses rather than letting spend through unapproved."
                  nextStep="Add a rule for the lowest band first, then work upwards. Leave the top band with no ceiling so there is nothing above the matrix."
                  action={{ label: 'Add a rule', onClick: () => setAdding(true) }}
                />
              ) : (
                <ul className="m-0 list-none p-0">
                  {rules.map((rule) => (
                    <RuleRow
                      key={rule.id}
                      rule={rule}
                      onReplace={() => setReplacing(rule)}
                      onRetire={() => setRetiring(rule)}
                    />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <RoutePreview recordType={recordType} />
        </div>
      ) : null}

      <RuleDialog
        open={adding || replacing !== null}
        recordType={recordType}
        replacing={replacing}
        liveRules={live}
        isPending={addRule.isPending}
        error={errorMessage(addRule.error)}
        onClose={() => {
          setAdding(false);
          setReplacing(null);
          addRule.reset();
        }}
        onConfirm={(body) => {
          addRule.mutate(body, {
            onSuccess: () => {
              setAdding(false);
              setReplacing(null);
            },
          });
        }}
      />

      <ReasonDialog
        open={retiring !== null}
        title="Retire this rule"
        description={
          retiring
            ? `“${retiring.name}” stops applying to records submitted from now on. Records already routed keep the route they were given. Nothing is deleted: the rule stays on the record of what was in force.`
            : ''
        }
        label="Why it is being retired"
        help="Whoever reviews this matrix later sees this sentence next to the rule."
        confirmLabel="Retire it"
        isPending={retireRule.isPending}
        error={errorMessage(retireRule.error)}
        onClose={() => {
          setRetiring(null);
          retireRule.reset();
        }}
        onConfirm={(reason) => {
          if (!retiring) return;
          retireRule.mutate(
            { ruleId: retiring.id, reason },
            { onSuccess: () => setRetiring(null) },
          );
        }}
      />
    </>
  );
}

/**
 * What is wrong with the matrix, if anything.
 *
 * Faults and gaps are separated because they need different reactions. A fault
 * is a contradiction the planner cannot resolve and work will be refused; a gap
 * is an amount with no route, which is the same refusal but arrived at by
 * omission rather than by conflict. Both are shown; neither blocks editing,
 * because the way out of a gap is usually to add the rule that fills it.
 */
function MatrixVerdict({ matrix }: { matrix: MatrixOut }) {
  const { faults, gaps, readings } = matrix.audit;

  if (faults.length === 0 && gaps.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-start gap-[var(--space-3)]">
          <Info
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-[var(--color-success-700)]"
          />
          <div>
            <p className="m-0 font-semibold text-[var(--color-text-strong)]">
              Every amount has a route
            </p>
            <p className="mt-1 m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              {readings.length > 0
                ? `Checked at ${readings.length} amounts across the bands, including the boundaries between them.`
                : 'Nothing is configured to check.'}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn(faults.length > 0 && 'border-[var(--color-danger-600)]')}>
      <CardContent className="flex items-start gap-[var(--space-3)]">
        <AlertTriangle
          aria-hidden="true"
          className={cn(
            'mt-0.5 size-5 shrink-0',
            faults.length > 0
              ? 'text-[var(--color-danger-700)]'
              : 'text-[var(--color-warning-700)]',
          )}
        />
        <div className="min-w-0">
          <p
            className={cn(
              'm-0 font-semibold',
              faults.length > 0
                ? 'text-[var(--color-danger-700)]'
                : 'text-[var(--color-text-strong)]',
            )}
          >
            {faults.length > 0
              ? 'This matrix contradicts itself'
              : 'Some amounts have no route'}
          </p>
          <ul className="mt-2 mb-0 flex list-disc flex-col gap-1 pl-5 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
            {faults.map((note) => (
              <li key={`${note.kind}-${note.message}`}>{note.message}</li>
            ))}
            {gaps.map((note) => (
              <li key={`${note.kind}-${note.message}`}>{note.message}</li>
            ))}
          </ul>
          <p className="mt-2 m-0 text-[var(--text-caption)] text-[var(--color-text-subtle)]">
            A record that lands in one of these cannot be submitted at all. It is refused at
            the point of submission, in front of somebody who cannot fix it from there.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function RuleRow({
  rule,
  onReplace,
  onRetire,
}: {
  rule: MatrixRuleOut;
  onReplace: () => void;
  onRetire: () => void;
}) {
  return (
    <li
      className={cn(
        'flex flex-col gap-[var(--space-3)] border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0',
        'sm:flex-row sm:items-center',
        !rule.is_active && 'bg-[var(--color-surface-subtle)]',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="m-0 flex flex-wrap items-baseline gap-x-[var(--space-2)]">
          <span
            className={cn(
              'font-semibold',
              rule.is_active
                ? 'text-[var(--color-text-strong)]'
                : 'text-[var(--color-text-muted)]',
            )}
          >
            {rule.name}
          </span>
          {rule.department ? (
            <span className="text-[var(--text-caption)] text-[var(--color-text-subtle)]">
              {rule.department} only
            </span>
          ) : null}
        </p>
        <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
          <span className="tabular">{rule.band_label}</span> · step {rule.step_order} ·{' '}
          {rule.level_label}
          {rule.is_parallel ? ' · decides alongside others at this step' : ''}
        </p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-[var(--space-2)]">
        {rule.is_active ? (
          <>
            <Button variant="ghost" size="sm" onClick={onReplace}>
              Replace
            </Button>
            <Button variant="ghost" size="sm" onClick={onRetire}>
              Retire
            </Button>
          </>
        ) : (
          <ToneBadge label="Retired" tone="neutral" />
        )}
      </div>
    </li>
  );
}
