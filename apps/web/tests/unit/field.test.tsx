import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Field, Input } from '@/components/ui/field';

function renderField(props: Partial<React.ComponentProps<typeof Field>> = {}) {
  return render(
    <Field label="Vendor name" {...props}>
      {({ inputId, describedBy, invalid }) => (
        <Input id={inputId} aria-describedby={describedBy} invalid={invalid} />
      )}
    </Field>,
  );
}

describe('Field', () => {
  it('binds a visible persistent label to the control', () => {
    renderField();
    expect(screen.getByLabelText(/Vendor name/)).toBeInTheDocument();
  });

  it('states optional explicitly rather than leaving it to inference', () => {
    renderField();
    expect(screen.getByText('(optional)')).toBeInTheDocument();
  });

  it('marks required fields for both sighted and screen reader users', () => {
    renderField({ required: true });
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('(required)')).toBeInTheDocument();
    expect(screen.queryByText('(optional)')).not.toBeInTheDocument();
  });

  it('wires help text to the control through aria-describedby', () => {
    renderField({ help: 'As it appears on the invoice.' });

    const input = screen.getByLabelText(/Vendor name/);
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      'As it appears on the invoice.',
    );
  });

  it('leaves aria-describedby unset when there is nothing to describe', () => {
    renderField();
    expect(screen.getByLabelText(/Vendor name/)).not.toHaveAttribute(
      'aria-describedby',
    );
  });

  it('marks the control invalid and describes it with the error', () => {
    renderField({ error: 'Enter the vendor name shown on the invoice.' });

    const input = screen.getByLabelText(/Vendor name/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain('-error');
    expect(
      screen.getByText('Enter the vendor name shown on the invoice.'),
    ).toBeInTheDocument();
  });

  it('reports an error politely rather than interrupting the typist', () => {
    // `role="alert"` is assertive and cuts across whatever the user is saying or
    // typing. A field being incomplete never warrants that.
    renderField({ error: 'Required.' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Required.')).toHaveAttribute('aria-live', 'polite');
  });

  it('keeps the help text when there is also an error', () => {
    // The two answer different questions, and a field is flagged exactly when the
    // reader still needs the format and the policy in front of them.
    renderField({
      help: 'As it appears on the invoice.',
      formatHint: 'DD MMM YYYY',
      error: 'Required.',
    });

    expect(screen.getByText('Required.')).toBeInTheDocument();
    expect(screen.getByText(/As it appears on the invoice/)).toBeInTheDocument();
    expect(screen.getByText('DD MMM YYYY')).toBeInTheDocument();
  });

  it('describes the control with both the error and the help', () => {
    renderField({ help: 'As it appears on the invoice.', error: 'Required.' });

    const describedBy =
      screen.getByLabelText(/Vendor name/).getAttribute('aria-describedby') ?? '';
    const described = describedBy
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '');

    expect(described.join(' ')).toContain('Required.');
    expect(described.join(' ')).toContain('As it appears on the invoice.');
  });

  it('shows a format hint alongside the help text', () => {
    renderField({ help: 'Invoice date.', formatHint: 'DD MMM YYYY' });
    expect(screen.getByText('DD MMM YYYY')).toBeInTheDocument();
  });

  it('generates distinct ids so two fields on a page never collide', () => {
    render(
      <>
        <Field label="First">
          {({ inputId }) => <Input id={inputId} />}
        </Field>
        <Field label="Second">
          {({ inputId }) => <Input id={inputId} />}
        </Field>
      </>,
    );

    const [first, second] = screen.getAllByRole('textbox');
    expect(first?.id).not.toBe(second?.id);
  });
});

describe('Input', () => {
  it('uses tabular figures and right alignment for amounts', () => {
    render(<Input numeric aria-label="Amount" />);
    const input = screen.getByLabelText('Amount');
    expect(input.className).toContain('text-right');
    expect(input.className).toContain('tabular');
  });

  it('omits aria-invalid entirely when valid, rather than setting it to false', () => {
    render(<Input aria-label="Amount" />);
    expect(screen.getByLabelText('Amount')).not.toHaveAttribute('aria-invalid');
  });
});
