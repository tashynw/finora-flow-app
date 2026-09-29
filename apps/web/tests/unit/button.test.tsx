import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Button } from '@/components/ui/button';

describe('Button', () => {
  it('renders its label as accessible text', () => {
    render(<Button>Approve invoice</Button>);
    expect(
      screen.getByRole('button', { name: 'Approve invoice' }),
    ).toBeInTheDocument();
  });

  it('announces a loading action instead of falling silent', () => {
    render(
      <Button isLoading loadingLabel="Submitting for approval">
        Submit
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Submitting for approval' });
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('cannot be double-submitted while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button isLoading loadingLabel="Working" onClick={onClick}>
        Submit
      </Button>,
    );

    await userEvent.click(screen.getByRole('button'), { pointerEventsCheck: 0 });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('respects an explicit enabled state over the loading default', () => {
    render(
      <Button isLoading disabled={false}>
        Submit
      </Button>,
    );
    expect(screen.getByRole('button')).toBeEnabled();
  });

  it('meets the 44px minimum target height on every size', () => {
    for (const size of ['sm', 'md', 'lg', 'icon'] as const) {
      const { unmount } = render(<Button size={size}>Act</Button>);
      const className = screen.getByRole('button').className;
      expect(className).toMatch(/\bh-(11|12)\b/);
      unmount();
    }
  });

  it('reserves the brand fill for the primary variant alone', () => {
    const { unmount } = render(<Button variant="primary">Approve</Button>);
    expect(screen.getByRole('button').className).toContain(
      'bg-[var(--color-primary-600)]',
    );
    unmount();

    for (const variant of ['secondary', 'ghost', 'danger', 'link'] as const) {
      const rendered = render(<Button variant={variant}>Act</Button>);
      const className = screen.getByRole('button').className;
      expect(className).not.toContain('bg-[var(--color-primary-600)]');
      expect(className).not.toContain('gradient-signature');
      rendered.unmount();
    }
  });

  it('delegates to a link when asChild is used, keeping real navigation semantics', () => {
    render(
      <Button asChild>
        <a href="/invoices">Open invoices</a>
      </Button>,
    );
    expect(screen.getByRole('link', { name: 'Open invoices' })).toHaveAttribute(
      'href',
      '/invoices',
    );
  });
});
