import { Check, CircleDashed, Clock, MinusCircle, X } from 'lucide-react';

import type { PlannedStepOut, RouteOut, StepOut, StepState } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { formatMoment } from '@/lib/dates';
import { ToneBadge } from '@/components/workflow/status-badge';
import { ROUTE_STATE, STEP_STATE } from '@/features/estimates/estimate-vocabulary';

/**
 * An approval route, drawn as the sequence it is.
 *
 * A route is a set of people who each have to say yes, in a defined order, and
 * what a reader wants from it is "where has this got to and who is holding it".
 * So it is drawn as a vertical run of steps with a connecting line rather than as
 * a table: the order is the meaning, and a table of rows with a `step_order`
 * column leaves the reader to reconstruct it.
 *
 * Steps that share a `step_order` are parallel — either may decide first — and
 * are grouped so the line does not claim an order between them that does not
 * exist.
 *
 * Every decided step carries the name of the person who decided it and when.
 * That is the point of the record. A step reading "Approved" with nobody against
 * it is not an approval, and this platform does not have approvals nobody made.
 */

const STEP_ICONS: Record<StepState, typeof Check> = {
  waiting: CircleDashed,
  ready: Clock,
  approved: Check,
  rejected: X,
  withdrawn: MinusCircle,
};

const STEP_MARKER_CLASSES: Record<StepState, string> = {
  waiting:
    'border-[var(--color-border-strong)] bg-[var(--color-surface-subtle)] text-[var(--color-text-subtle)]',
  ready:
    'border-[var(--color-primary-600)] bg-[var(--color-primary-50)] text-[var(--color-primary-700)]',
  approved:
    'border-[var(--color-success-600)] bg-[var(--color-success-50)] text-[var(--color-success-700)]',
  rejected:
    'border-[var(--color-danger-600)] bg-[var(--color-danger-50)] text-[var(--color-danger-700)]',
  withdrawn:
    'border-[var(--color-border-strong)] bg-[var(--color-surface-subtle)] text-[var(--color-text-subtle)]',
};

/** Steps grouped by the order they sit at, orders ascending. */
function byStepOrder<T extends { step_order: number }>(steps: T[]): T[][] {
  const groups = new Map<number, T[]>();
  for (const step of steps) {
    const existing = groups.get(step.step_order);
    if (existing) existing.push(step);
    else groups.set(step.step_order, [step]);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, group]) => group);
}

function StepMarker({ state }: { state: StepState }) {
  const Icon = STEP_ICONS[state];
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full border-2',
        STEP_MARKER_CLASSES[state],
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

interface StepRowProps {
  step: StepOut;
  /** Whether a connecting line should run down from this step towards the next. */
  showConnector: boolean;
  children?: React.ReactNode;
}

function StepRow({ step, showConnector, children }: StepRowProps) {
  const descriptor = STEP_STATE[step.state];
  const decided = step.state === 'approved' || step.state === 'rejected';

  return (
    <li className="relative flex gap-[var(--space-4)] pb-[var(--space-5)] last:pb-0">
      {showConnector ? (
        <span
          aria-hidden="true"
          className="absolute top-8 left-4 h-[calc(100%-2rem)] w-px -translate-x-1/2 bg-[var(--color-divider)]"
        />
      ) : null}

      <StepMarker state={step.state} />

      <div className="min-w-0 flex-1 pt-[var(--space-1)]">
        <div className="flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-2)]">
          <p className="m-0 font-semibold text-[var(--color-text-strong)]">{step.level_label}</p>
          <ToneBadge label={descriptor.label} tone={descriptor.tone} />
          {step.is_mine_to_decide ? <ToneBadge label="Yours to decide" tone="progress" /> : null}
        </div>

        {decided && step.decided_by_label ? (
          <p className="mt-[var(--space-1)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
            {step.state === 'rejected' ? 'Rejected' : 'Approved'} by{' '}
            <span className="font-semibold text-[var(--color-text-strong)]">
              {step.decided_by_label}
            </span>
            {step.on_behalf_of_label ? <> on behalf of {step.on_behalf_of_label}</> : null} ·{' '}
            <time {...(step.decided_at ? { dateTime: step.decided_at } : {})} data-visual-volatile>
              {formatMoment(step.decided_at)}
            </time>
          </p>
        ) : (
          <p className="mt-[var(--space-1)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
            {descriptor.description}
          </p>
        )}

        {step.comment ? (
          // Quoted rather than paraphrased, for an approval as much as for a
          // rejection. What an approver wrote is the record; summarising it would
          // put words in their mouth.
          <blockquote
            className={cn(
              'mt-[var(--space-3)] m-0 border-l-2 pl-[var(--space-3)]',
              'text-[length:var(--text-body-sm)] text-[var(--color-text)]',
              step.state === 'rejected'
                ? 'border-[var(--color-danger-600)]'
                : 'border-[var(--color-border-strong)]',
            )}
          >
            {step.comment}
          </blockquote>
        ) : null}

        {step.would_act_for ? (
          <p className="mt-[var(--space-2)] m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
            You would be deciding this as {step.would_act_for}&rsquo;s delegate, and their name
            will be recorded alongside yours.
          </p>
        ) : null}

        {children}
      </div>
    </li>
  );
}

export interface ApprovalRouteProps {
  route: RouteOut;
  /** Rendered inside whichever step this caller may decide. */
  renderDecision?: (step: StepOut) => React.ReactNode;
  className?: string;
}

export function ApprovalRoute({ route, renderDecision, className }: ApprovalRouteProps) {
  const descriptor = ROUTE_STATE[route.state];
  const groups = byStepOrder(route.steps);

  return (
    <div className={className}>
      {/* The state, and nothing else. The route's one-line summary says who is
          holding it and how far it has got, and every word of that is in the
          steps immediately below, so printing it here as well left the same
          sentence on the screen twice. It is kept where it is genuinely useful:
          under the page title, where somebody arriving from a link reads it
          before they reach this card at all. */}
      <div className="mb-[var(--space-4)]">
        <ToneBadge label={descriptor.label} tone={descriptor.tone} />
      </div>

      <ol className="m-0 list-none p-0">
        {groups.map((group, groupIndex) => {
          const isLastGroup = groupIndex === groups.length - 1;
          return (
            <li key={group[0]?.step_order ?? groupIndex}>
              {group.length > 1 ? (
                <p className="mb-[var(--space-2)] ml-12 m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
                  Both are needed, in either order.
                </p>
              ) : null}
              <ol className="m-0 list-none p-0">
                {group.map((step, index) => (
                  <StepRow
                    key={`${step.step_order}-${step.level}`}
                    step={step}
                    showConnector={!isLastGroup || index < group.length - 1}
                  >
                    {step.is_mine_to_decide && renderDecision ? renderDecision(step) : null}
                  </StepRow>
                ))}
              </ol>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The route an estimate *would* take, shown on a draft.
 *
 * Drawn as a horizontal run rather than in the shape of a real route, and without
 * markers, because none of it has happened: a column of empty circles reads as a
 * route that has stalled.
 */
export function PlannedRoute({
  steps,
  className,
}: {
  steps: PlannedStepOut[];
  className?: string;
}) {
  const groups = byStepOrder(steps);

  return (
    <ol
      className={cn(
        'm-0 flex list-none flex-wrap items-center gap-[var(--space-2)] p-0',
        className,
      )}
    >
      {groups.map((group, index) => (
        <li
          key={group[0]?.step_order ?? index}
          className="flex flex-wrap items-center gap-[var(--space-2)]"
        >
          {group.map((step) => (
            <ToneBadge key={step.level} label={step.level_label} tone="neutral" />
          ))}
          {index === groups.length - 1 ? null : (
            <span aria-hidden="true" className="text-[var(--color-text-subtle)]">
              &rarr;
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
