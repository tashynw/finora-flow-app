import { describe, expect, it } from 'vitest';

import {
  isTerminal,
  needsAction,
  WORKFLOW_STATE_DESCRIPTIONS,
  WORKFLOW_STATE_LABELS,
  WORKFLOW_STATES,
  type WorkflowState,
} from '@/lib/workflow';

describe('workflow state vocabulary', () => {
  it('gives every state a human label and an explanation', () => {
    for (const state of WORKFLOW_STATES) {
      expect(WORKFLOW_STATE_LABELS[state]).toBeTruthy();
      expect(WORKFLOW_STATE_DESCRIPTIONS[state]).toBeTruthy();
    }
  });

  it('carries no extra states beyond the declared list', () => {
    expect(Object.keys(WORKFLOW_STATE_LABELS).sort()).toEqual(
      [...WORKFLOW_STATES].sort(),
    );
    expect(Object.keys(WORKFLOW_STATE_DESCRIPTIONS).sort()).toEqual(
      [...WORKFLOW_STATES].sort(),
    );
  });

  it('never shows a raw snake_case identifier to the reader', () => {
    for (const label of Object.values(WORKFLOW_STATE_LABELS)) {
      expect(label).not.toMatch(/_/);
    }
  });
});

describe('isTerminal', () => {
  it('treats only settled outcomes as terminal', () => {
    const terminal = WORKFLOW_STATES.filter(isTerminal);
    expect(terminal).toEqual(['paid', 'rejected', 'cancelled']);
  });

  it('does not treat a submitted-but-unconfirmed record as finished', () => {
    expect(isTerminal('submitted')).toBe(false);
    expect(isTerminal('outstanding')).toBe(false);
  });
});

describe('needsAction', () => {
  it('flags every state where a person is the blocker', () => {
    const waiting: WorkflowState[] = [
      'pending_sign_off',
      'pending_approval',
      'exception',
      'outstanding',
      'accrual_needed',
    ];
    for (const state of waiting) {
      expect(needsAction(state)).toBe(true);
    }
  });

  it('does not nag about states the system is progressing on its own', () => {
    for (const state of ['draft', 'approved', 'ready_for_submission', 'submitted'] as const) {
      expect(needsAction(state)).toBe(false);
    }
  });

  it('never asks for action on a terminal record', () => {
    for (const state of WORKFLOW_STATES) {
      if (isTerminal(state)) {
        expect(needsAction(state)).toBe(false);
      }
    }
  });
});
