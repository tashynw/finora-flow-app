import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Modal } from '@/components/ui/modal';

beforeAll(() => {
  // jsdom implements the `<dialog>` element but not its modal behaviour, so the
  // two methods the component calls have to be provided.
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false;
    };
  }
});

function renderModal(props: Partial<React.ComponentProps<typeof Modal>> = {}) {
  const onClose = vi.fn();
  const result = render(
    <Modal
      open
      onClose={onClose}
      title="Upload a document"
      description="It is scanned before anyone can open it."
      footer={<button type="button">Upload</button>}
      {...props}
    >
      <p>Body content</p>
    </Modal>,
  );
  return { ...result, onClose };
}

describe('Modal', () => {
  it('names itself and its purpose to assistive technology', () => {
    renderModal();
    const dialog = screen.getByRole('dialog', { hidden: true });

    // The accessible name and description come from the title and description,
    // so a screen reader user learns why the dialog opened.
    const labelledBy = dialog.getAttribute('aria-labelledby');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)).toHaveTextContent('Upload a document');
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      'It is scanned before anyone can open it.',
    );
  });

  it('gives each dialog its own ids so two on a page never collide', () => {
    // A page may hold several dialogs at once with only one of them open. Fixed
    // ids would put duplicates in the document and leave the association
    // resolving to whichever came first.
    render(
      <>
        <Modal open={false} onClose={vi.fn()} title="Withdraw it">
          <p>First</p>
        </Modal>
        <Modal open={false} onClose={vi.fn()} title="Cancel it">
          <p>Second</p>
        </Modal>
      </>,
    );

    const [first, second] = screen.getAllByRole('dialog', { hidden: true });
    expect(first?.getAttribute('aria-labelledby')).not.toBe(
      second?.getAttribute('aria-labelledby'),
    );
  });

  it('omits the description association when there is no description', () => {
    renderModal({ description: undefined });
    expect(screen.getByRole('dialog', { hidden: true })).not.toHaveAttribute(
      'aria-describedby',
    );
  });

  it('offers a labelled close control', async () => {
    const { onClose } = renderModal();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('refuses to close while an action is in flight', async () => {
    // Closing mid-request would leave the user unsure whether a financial action
    // took effect.
    const { onClose } = renderModal({ busy: true });
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toBeDisabled();

    await userEvent.click(close);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders its footer actions', () => {
    renderModal();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    renderModal({ open: false });
    expect(screen.getByRole('dialog', { hidden: true })).not.toHaveAttribute('open');
  });

  it('never sets a display that would survive being closed', () => {
    // A closed dialog is hidden by the browser's own `display: none`, and any
    // unguarded display utility beats it. The dialog then lays itself out inside
    // the page, so every screen holding an unopened dialog silently grows a
    // second copy of its form. jsdom applies no user agent stylesheet, so the
    // class list is the only place this is visible from a unit test.
    renderModal({ open: false });
    const classes = screen.getByRole('dialog', { hidden: true }).className.split(/\s+/);

    const displays = ['block', 'flex', 'grid', 'inline-flex', 'inline-grid', 'contents'];
    const unguarded = classes.filter((name) => displays.includes(name));
    expect(unguarded).toEqual([]);
  });
});
