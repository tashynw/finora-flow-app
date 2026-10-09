import { describe, expect, it } from 'vitest';
import {
  openStepOrder,
  planRoute,
  routeState,
  validateDecision,
  withReadyStates,
  type MatrixRule,
} from './approval-domain.js';

const rule = (overrides: Partial<MatrixRule> = {}): MatrixRule => ({
  level: 'MANAGER',
  stepOrder: 1,
  minAmountMinorUnits: 0n,
  maxAmountMinorUnits: null,
  currency: 'JMD',
  departmentId: null,
  isParallel: false,
  ...overrides,
});

describe('planRoute', () => {
  it('orders steps and prefers a department-specific rule over the global one', () => {
    const route = planRoute(
      [
        rule({ level: 'COO', stepOrder: 2 }),
        rule({ level: 'UNIT_HEAD', stepOrder: 1, departmentId: null }),
        rule({
          level: 'UNIT_HEAD',
          stepOrder: 1,
          departmentId: 'finance',
        }),
      ],
      50_000n,
      'JMD',
      'finance',
    );

    expect(route).toEqual([
      { stepOrder: 1, level: 'UNIT_HEAD' },
      { stepOrder: 2, level: 'COO' },
    ]);
  });

  it('refuses an amount no rule covers', () => {
    expect(() =>
      planRoute([rule({ minAmountMinorUnits: 100n })], 50n, 'JMD', null),
    ).toThrow(/No approval levels configured for this amount/);
  });

  it('refuses parallel levels that are not marked parallel', () => {
    expect(() =>
      planRoute(
        [
          rule({ level: 'MANAGER', stepOrder: 1, isParallel: false }),
          rule({ level: 'HOD', stepOrder: 1, isParallel: false }),
        ],
        10n,
        'JMD',
        null,
      ),
    ).toThrow(/parallel/);
  });
});

describe('route progress', () => {
  const steps = [
    { stepOrder: 1, level: 'MANAGER' as const, status: 'READY' as const },
    { stepOrder: 2, level: 'COO' as const, status: 'WAITING' as const },
  ];

  it('keeps only the current step ready', () => {
    const advanced = withReadyStates([
      { ...steps[0], status: 'APPROVED' },
      steps[1],
    ]);
    expect(advanced[1].status).toBe('READY');
    expect(openStepOrder(advanced)).toBe(2);
  });

  it('is approved only when every step is approved', () => {
    expect(
      routeState([
        { stepOrder: 1, level: 'MANAGER', status: 'APPROVED' },
        { stepOrder: 2, level: 'COO', status: 'APPROVED' },
      ]),
    ).toBe('APPROVED');
  });

  it('rejects a decision from the requester or on a waiting step', () => {
    expect(() =>
      validateDecision({
        steps,
        stepOrder: 1,
        level: 'MANAGER',
        outcome: 'approved',
        actorId: 'requester',
        requesterId: 'requester',
        actorMayDecide: true,
      }),
    ).toThrow(/own request/);

    expect(() =>
      validateDecision({
        steps,
        stepOrder: 2,
        level: 'COO',
        outcome: 'approved',
        actorId: 'approver',
        requesterId: 'requester',
        actorMayDecide: true,
      }),
    ).toThrow(/not ready/);
  });

  it('requires a reason when rejecting', () => {
    expect(() =>
      validateDecision({
        steps,
        stepOrder: 1,
        level: 'MANAGER',
        outcome: 'rejected',
        actorId: 'approver',
        requesterId: 'requester',
        actorMayDecide: true,
        comment: '  ',
      }),
    ).toThrow(/reason is required/);
  });
});
