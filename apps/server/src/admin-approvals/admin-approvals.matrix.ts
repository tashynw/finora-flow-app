import type { ApprovalLevel, ApprovalRecordType, ApprovalRule } from '../generated/prisma/index.js';
import {
  formatMoney,
  LEVEL_LABELS,
  RECORD_TYPE_LABELS,
  RECORD_TYPE_TO_SLUG,
  type RecordTypeSlug,
} from './admin-approvals.constants.js';

type RuleRow = Pick<
  ApprovalRule,
  | 'id'
  | 'name'
  | 'recordType'
  | 'level'
  | 'stepOrder'
  | 'minAmountMinorUnits'
  | 'maxAmountMinorUnits'
  | 'currency'
  | 'isParallel'
  | 'isActive'
  | 'retiredAt'
  | 'departmentId'
> & {
  department?: { name: string } | null;
};

export function bandLabel(rule: RuleRow): string {
  const floor = formatMoney(rule.minAmountMinorUnits, rule.currency);
  if (rule.maxAmountMinorUnits === null) return `${floor} and above`;
  return `${floor} to ${formatMoney(rule.maxAmountMinorUnits, rule.currency)}`;
}

export function ruleToOut(rule: RuleRow) {
  const slug = RECORD_TYPE_TO_SLUG[rule.recordType];
  return {
    id: rule.id,
    name: rule.name,
    record_type: slug,
    record_type_label: RECORD_TYPE_LABELS[slug as RecordTypeSlug],
    level: rule.level.toLowerCase(),
    level_label: LEVEL_LABELS[rule.level],
    step_order: rule.stepOrder,
    min_amount_minor_units: rule.minAmountMinorUnits.toString(),
    max_amount_minor_units: rule.maxAmountMinorUnits?.toString() ?? null,
    currency: rule.currency,
    band_label: bandLabel(rule),
    department: rule.department?.name ?? null,
    is_parallel: rule.isParallel,
    is_active: rule.isActive,
    retired_at: rule.retiredAt,
    supersedes_id: null,
  };
}

export function matchRulesForAmount(
  rules: RuleRow[],
  opts: {
    recordType: ApprovalRecordType;
    currency: string;
    amountMinorUnits: bigint;
    departmentId: string | null;
  },
): RuleRow[] {
  return rules
    .filter(
      (rule) =>
        rule.isActive &&
        rule.recordType === opts.recordType &&
        rule.currency === opts.currency &&
        rule.minAmountMinorUnits <= opts.amountMinorUnits &&
        (rule.maxAmountMinorUnits === null ||
          rule.maxAmountMinorUnits >= opts.amountMinorUnits) &&
        (rule.departmentId === null || rule.departmentId === opts.departmentId),
    )
    .sort(
      (a, b) =>
        a.stepOrder - b.stepOrder ||
        Number(a.minAmountMinorUnits - b.minAmountMinorUnits),
    );
}

export function stepsToLabels(
  steps: { stepOrder: number; level: ApprovalLevel }[],
): string[] {
  const atOrder = new Map<number, number>();
  for (const step of steps) {
    atOrder.set(step.stepOrder, (atOrder.get(step.stepOrder) ?? 0) + 1);
  }
  return steps.map((step) => {
    const together = (atOrder.get(step.stepOrder) ?? 0) > 1;
    return `${step.stepOrder}. ${LEVEL_LABELS[step.level]}${together ? ' (together)' : ''}`;
  });
}

export function emptyMatrixAudit() {
  return {
    is_coherent: true,
    faults: [] as { kind: string; message: string }[],
    gaps: [] as { kind: string; message: string }[],
    readings: [] as {
      currency: string;
      department: string | null;
      amount_minor_units: number;
      amount_formatted: string;
      steps: string[];
      unreachable: string | null;
    }[],
  };
}
