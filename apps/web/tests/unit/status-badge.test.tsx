import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { StatusBadge } from '@/components/workflow/status-badge';
import { WORKFLOW_STATE_LABELS, WORKFLOW_STATES } from '@/lib/workflow';

describe('StatusBadge', () => {
  it('always carries the label text, never colour alone', () => {
    for (const state of WORKFLOW_STATES) {
      const { unmount } = render(<StatusBadge state={state} />);
      expect(screen.getByText(WORKFLOW_STATE_LABELS[state])).toBeInTheDocument();
      unmount();
    }
  });

  it('reads as its label alone, with no decoration for assistive technology to skip', () => {
    const { container } = render(<StatusBadge state="paid" />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(container.firstElementChild).toHaveTextContent(/^Paid$/);
  });

  it('appends a qualifier without losing the state label', () => {
    render(<StatusBadge state="pending_approval" detail="Step 2 of 3" />);
    expect(screen.getByText('Pending approval')).toBeInTheDocument();
    expect(screen.getByText('· Step 2 of 3')).toBeInTheDocument();
  });

  it('gives visually distinct treatment to settled and unsettled payment states', () => {
    const paid = render(<StatusBadge state="paid" />);
    const paidClass = paid.container.firstElementChild?.className ?? '';
    paid.unmount();

    const outstanding = render(<StatusBadge state="outstanding" />);
    const outstandingClass =
      outstanding.container.firstElementChild?.className ?? '';

    expect(paidClass).not.toBe(outstandingClass);
    expect(paidClass).toContain('success');
    expect(outstandingClass).toContain('warning');
  });
});
