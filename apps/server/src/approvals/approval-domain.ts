import type {
  ApprovalLevel,
  ApprovalStepStatus,
  Currency,
} from '../generated/prisma/index.js';
import { compareLevels } from './approval-levels.js';

export type ApprovalOutcome = 'approved' | 'rejected';

export type StepProgress = {
  stepOrder: number;
  level: ApprovalLevel;
  status: ApprovalStepStatus;
};

export type MatrixRule = {
  level: ApprovalLevel;
  stepOrder: number;
  minAmountMinorUnits: bigint;
  maxAmountMinorUnits: bigint | null;
  currency: Currency;
  departmentId: string | null;
  isParallel: boolean;
};

const DECIDED: ApprovalStepStatus[] = ['APPROVED', 'REJECTED'];

export function ruleCovers(
  rule: MatrixRule,
  amountMinorUnits: bigint,
  currency: Currency,
): boolean {
  if (rule.currency !== currency) return false;
  if (amountMinorUnits < rule.minAmountMinorUnits) return false;
  if (
    rule.maxAmountMinorUnits != null &&
    amountMinorUnits > rule.maxAmountMinorUnits
  ) {
    return false;
  }
  return true;
}

export function ruleAppliesInDepartment(
  rule: MatrixRule,
  departmentId: string | null,
): boolean {
  if (rule.departmentId == null) return true;
  return departmentId != null && rule.departmentId === departmentId;
}

function resolveOverrides(rules: MatrixRule[]): MatrixRule[] {
  const best = new Map<string, MatrixRule>();
  for (const rule of rules) {
    const key = `${rule.stepOrder}:${rule.level}`;
    const incumbent = best.get(key);
    if (
      incumbent == null ||
      (incumbent.departmentId == null && rule.departmentId != null)
    ) {
      best.set(key, rule);
    }
  }
  return [...best.values()];
}

function assertParallelism(rules: MatrixRule[]) {
  const byOrder = new Map<number, MatrixRule[]>();
  for (const rule of rules) {
    const group = byOrder.get(rule.stepOrder) ?? [];
    group.push(rule);
    byOrder.set(rule.stepOrder, group);
  }
  for (const [, group] of byOrder) {
    if (group.length > 1 && !group.every((r) => r.isParallel)) {
      throw new Error(
        'Approval matrix has parallel levels without isParallel flag',
      );
    }
  }
}

export function planRoute(
  rules: MatrixRule[],
  amountMinorUnits: bigint,
  currency: Currency,
  departmentId: string | null,
): Array<{ stepOrder: number; level: ApprovalLevel }> {
  const inBand = rules.filter((r) => ruleCovers(r, amountMinorUnits, currency));
  if (inBand.length === 0) {
    throw new Error('No approval levels configured for this amount and currency');
  }
  const applicable = inBand.filter((r) =>
    ruleAppliesInDepartment(r, departmentId),
  );
  if (applicable.length === 0) {
    throw new Error('No approval levels configured for this department');
  }
  const chosen = resolveOverrides(applicable);
  assertParallelism(chosen);
  return chosen
    .sort(
      (a, b) =>
        a.stepOrder - b.stepOrder || compareLevels(a.level, b.level),
    )
    .map((r) => ({ stepOrder: r.stepOrder, level: r.level }));
}

export function isDecided(status: ApprovalStepStatus): boolean {
  return DECIDED.includes(status);
}

export type RouteState = 'OPEN' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';

export function routeState(steps: StepProgress[]): RouteState {
  if (steps.length === 0) return 'WITHDRAWN';
  if (steps.some((s) => s.status === 'REJECTED')) return 'REJECTED';
  if (steps.every((s) => s.status === 'APPROVED')) return 'APPROVED';
  if (steps.some((s) => s.status === 'WITHDRAWN')) return 'WITHDRAWN';
  return 'OPEN';
}

export function openStepOrder(steps: StepProgress[]): number | null {
  if (routeState(steps) !== 'OPEN') return null;
  const outstanding = steps
    .filter((s) => s.status !== 'APPROVED')
    .map((s) => s.stepOrder);
  return outstanding.length ? Math.min(...outstanding) : null;
}

export function withReadyStates(steps: StepProgress[]): StepProgress[] {
  const openAt = openStepOrder(steps);
  return steps.map((step) => {
    if (isDecided(step.status)) return step;
    if (openAt == null) {
      return { ...step, status: 'WITHDRAWN' };
    }
    return {
      ...step,
      status: step.stepOrder === openAt ? 'READY' : 'WAITING',
    };
  });
}

export function validateDecision(input: {
  steps: StepProgress[];
  stepOrder: number;
  level: ApprovalLevel;
  outcome: ApprovalOutcome;
  actorId: string;
  requesterId: string;
  actorMayDecide: boolean;
  comment?: string | null;
}) {
  const current = withReadyStates(input.steps);
  const state = routeState(current);
  if (state !== 'OPEN') {
    throw new Error('This approval request is no longer open');
  }
  const target = current.find(
    (s) => s.stepOrder === input.stepOrder && s.level === input.level,
  );
  if (!target) {
    throw new Error('Approval step not found');
  }
  if (isDecided(target.status)) {
    throw new Error('This step has already been decided');
  }
  if (input.actorId === input.requesterId) {
    throw new Error('You cannot approve your own request');
  }
  if (!input.actorMayDecide) {
    throw new Error('You are not assigned to decide this step');
  }
  if (target.status !== 'READY') {
    throw new Error('This step is not ready for a decision');
  }
  const cleaned = (input.comment ?? '').trim();
  if (input.outcome === 'rejected' && !cleaned) {
    throw new Error('A reason is required when rejecting');
  }
  return { comment: cleaned || null };
}
