/**
 * Workflow states, mirroring the backend state machine.
 *
 * Labels live here so the interface never invents its own wording for a state.
 * The permitted transitions are decided by the API, not by this file; the client
 * only asks what is allowed and renders the answer.
 */

export const WORKFLOW_STATES = [
  'draft',
  'pending_sign_off',
  'pending_approval',
  'approved',
  'ready_for_submission',
  'submitted',
  'paid',
  'outstanding',
  'exception',
  'accrual_needed',
  'rejected',
  'cancelled',
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const WORKFLOW_STATE_LABELS: Record<WorkflowState, string> = {
  draft: 'Draft',
  pending_sign_off: 'Pending sign-off',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  ready_for_submission: 'Ready for submission',
  submitted: 'Submitted',
  paid: 'Paid',
  outstanding: 'Outstanding',
  exception: 'Exception',
  accrual_needed: 'Accrual needed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

/** Plain-language explanation of what each state means for the reader. */
export const WORKFLOW_STATE_DESCRIPTIONS: Record<WorkflowState, string> = {
  draft: 'Being prepared. Not yet sent for review.',
  pending_sign_off: 'Waiting for the requester to confirm the goods or services were received.',
  pending_approval: 'Waiting for an approver to decide.',
  approved: 'Approved and ready to be added to a payment package.',
  ready_for_submission: 'In a payment package that has not been submitted yet.',
  submitted: 'Submitted for payment. Awaiting confirmation.',
  paid: 'Payment confirmed. This record is final.',
  outstanding: 'Submitted but not confirmed as paid. Needs follow-up.',
  exception: 'Something needs attention before this can continue.',
  accrual_needed: 'Unpaid at period end, so it must be accrued.',
  rejected: 'Rejected. See the reason in the history.',
  cancelled: 'Cancelled and no longer being processed.',
};

const TERMINAL_STATES = new Set<WorkflowState>(['paid', 'rejected', 'cancelled']);

export function isTerminal(state: WorkflowState): boolean {
  return TERMINAL_STATES.has(state);
}

/** States that mean someone must act. Drives "needs attention" counts. */
const ACTION_REQUIRED_STATES = new Set<WorkflowState>([
  'pending_sign_off',
  'pending_approval',
  'exception',
  'outstanding',
  'accrual_needed',
]);

export function needsAction(state: WorkflowState): boolean {
  return ACTION_REQUIRED_STATES.has(state);
}
