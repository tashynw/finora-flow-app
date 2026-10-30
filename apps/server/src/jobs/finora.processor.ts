import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { DocumentsJob } from './documents/documents.job.js';
import { InboxJob } from './inbox/inbox.job.js';
import { RemindersJob } from './reminders/reminders.job.js';

@Processor('{finora}')
export class FinoraProcessor extends WorkerHost {
  private readonly logger = new Logger(FinoraProcessor.name);

  constructor(
    private readonly inbox: InboxJob,
    private readonly documents: DocumentsJob,
    private readonly reminders: RemindersJob,
  ) {
    super();
  }

  async process(job: Job) {
    this.logger.log(`Running job ${job.name}`);
    switch (job.name) {
      case 'inbox':
        return this.inbox.run();
      case 'documents':
        return this.documents.run();
      case 'remind-unreviewed':
        return this.reminders.remindUnreviewed();
      case 'remind-sign-off':
        return this.reminders.remindSignOff();
      case 'remind-approval':
        return this.reminders.remindApprovals();
      case 'remind-payment-package':
        return this.reminders.remindPaymentPackages();
      case 'remind-vendor-check-in':
        return this.reminders.remindVendorCheckIns();
      default:
        this.logger.warn(`Unknown job ${job.name}`);
        return null;
    }
  }
}
