import type { ApprovalLevel } from '../generated/prisma/index.js';

const LEVEL_ORDER: ApprovalLevel[] = ['UNIT_HEAD', 'MANAGER', 'HOD', 'COO'];

export const LEVEL_LABELS: Record<ApprovalLevel, string> = {
  UNIT_HEAD: 'Unit Head',
  MANAGER: 'Manager',
  HOD: 'Head of Department',
  COO: 'Chief Operating Officer',
};

export function approvalLevelToApi(level: ApprovalLevel): string {
  return level.toLowerCase();
}

export function approvalLevelFromApi(value: string): ApprovalLevel {
  const normalized = value.toUpperCase().replace(/-/g, '_');
  if (
    normalized === 'UNIT_HEAD' ||
    normalized === 'MANAGER' ||
    normalized === 'HOD' ||
    normalized === 'COO'
  ) {
    return normalized;
  }
  throw new Error(`Unknown approval level: ${value}`);
}

export function compareLevels(a: ApprovalLevel, b: ApprovalLevel): number {
  return LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b);
}
