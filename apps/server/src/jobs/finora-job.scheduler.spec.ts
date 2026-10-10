import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { FinoraJobScheduler } from './finora-job.scheduler.js';

describe('FinoraJobScheduler', () => {
  it('registers the inbox and document polls every minute and the reminders every fifteen minutes', async () => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        FinoraJobScheduler,
        { provide: getQueueToken('{finora}'), useValue: queue },
      ],
    }).compile();

    await moduleRef.get(FinoraJobScheduler).onModuleInit();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(7);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'inbox',
      { pattern: '0 * * * * *' },
      { name: 'inbox' },
    );
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'documents',
      { pattern: '0 * * * * *' },
      { name: 'documents' },
    );
    for (const name of [
      'remind-unreviewed',
      'remind-sign-off',
      'remind-approval',
      'remind-payment-package',
      'remind-vendor-check-in',
    ]) {
      expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
        name,
        { pattern: '0 */15 * * * *' },
        { name },
      );
    }
  });
});
