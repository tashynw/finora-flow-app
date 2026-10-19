import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { FinoraProcessor } from './finora.processor.js';

function processor() {
  const inbox = { run: vi.fn().mockResolvedValue('inbox') };
  const documents = { run: vi.fn().mockResolvedValue('documents') };
  const reminders = {
    remindUnreviewed: vi.fn().mockResolvedValue('unreviewed'),
    remindSignOff: vi.fn().mockResolvedValue('sign-off'),
    remindApprovals: vi.fn().mockResolvedValue('approval'),
    remindPaymentPackages: vi.fn().mockResolvedValue('package'),
    remindVendorCheckIns: vi.fn().mockResolvedValue('vendor'),
  };
  return {
    inbox,
    documents,
    reminders,
    worker: new FinoraProcessor(inbox as never, documents as never, reminders as never),
  };
}

describe('FinoraProcessor', () => {
  it.each([
    ['inbox', 'run', 'inbox'],
    ['documents', 'run', 'documents'],
    ['remind-unreviewed', 'remindUnreviewed', 'reminders'],
    ['remind-sign-off', 'remindSignOff', 'reminders'],
    ['remind-approval', 'remindApprovals', 'reminders'],
    ['remind-payment-package', 'remindPaymentPackages', 'reminders'],
    ['remind-vendor-check-in', 'remindVendorCheckIns', 'reminders'],
  ] as const)('runs the %s job', async (name, method, owner) => {
    const built = processor();
    const target = built[owner] as Record<string, ReturnType<typeof vi.fn>>;
    await expect(built.worker.process({ name } as Job)).resolves.toBeTypeOf('string');
    expect(target[method]).toHaveBeenCalledOnce();
  });

  it('ignores a job name that is not one of the Finora jobs', async () => {
    const built = processor();
    await expect(built.worker.process({ name: 'not-a-job' } as Job)).resolves.toBeNull();
    expect(built.inbox.run).not.toHaveBeenCalled();
    expect(built.documents.run).not.toHaveBeenCalled();
  });
});
