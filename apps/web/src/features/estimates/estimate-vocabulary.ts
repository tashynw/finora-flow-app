/**
 * The words the interface uses for an estimate and its approval route.
 *
 * The API sends the label for a state, a level and a route, so none of those are
 * repeated here. What it cannot send is tone, and tone is a presentation
 * decision: it belongs in one place so an awaiting step is never amber in a list
 * and blue on the page.
 *
 * One rule runs through the wording. An approval is described as a person's act,
 * never as a state a record drifted into. "Waiting on the Unit Head" names who
 * has to do something; "pending" names nobody.
 */

import type { RouteState, StepState } from '@finora/shared-types';

import type { StatusTone } from '@/components/workflow/status-badge';
import type { StatusDescriptor } from '@/features/intake/intake-vocabulary';

export const ROUTE_STATE: Record<RouteState, StatusDescriptor> = {
  open: {
    label: 'Awaiting approval',
    tone: 'progress',
    description: 'Somebody has to decide this before it can go any further.',
  },
  approved: {
    label: 'Fully approved',
    tone: 'success',
    description: 'Every approval this amount requires has been given.',
  },
  rejected: {
    label: 'Rejected',
    tone: 'danger',
    description: 'An approver refused this, and their reason is recorded against the step.',
  },
  withdrawn: {
    label: 'Withdrawn',
    tone: 'neutral',
    description:
      'This route ended without a verdict. Any approval already given is still recorded against it.',
  },
};

/**
 * The state of one step in a route.
 *
 * `waiting` reads as neutral rather than as a caution. A step that is not this
 * approver's turn is not a problem, and marking it as one would put amber
 * against every route with more than one step.
 */
export const STEP_STATE: Record<StepState, StatusDescriptor> = {
  waiting: {
    label: 'Not yet due',
    tone: 'neutral',
    description: 'An earlier approval has to be given before this one is open.',
  },
  ready: {
    label: 'Waiting on this',
    tone: 'progress',
    description: 'Open for a decision now.',
  },
  approved: {
    label: 'Approved',
    tone: 'success',
    description: 'Approved, by the person named beside it.',
  },
  rejected: {
    label: 'Rejected',
    tone: 'danger',
    description: 'Refused, with the reason recorded.',
  },
  withdrawn: {
    label: 'Never reached',
    tone: 'neutral',
    description: 'The route ended before this approval was due.',
  },
};

/**
 * The tone for a level, used where a route is drawn as a sequence.
 *
 * Every level is the same: an amount that needs the Chief Operating Officer is
 * not more alarming than one that needs a Unit Head, it is larger, and the
 * amount is already on the screen saying so.
 */
export const LEVEL_TONE: StatusTone = 'neutral';
