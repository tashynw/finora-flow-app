import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

const EVERY_MINUTE = '0 * * * * *';
const EVERY_FIFTEEN_MINUTES = '0 */15 * * * *';

@Injectable()
export class FinoraJobScheduler implements OnModuleInit {
  constructor(@InjectQueue('{finora}') private readonly queue: Queue) {}

  async onModuleInit() {
    await this.schedule('inbox', EVERY_MINUTE);
    await this.schedule('documents', EVERY_MINUTE);
    await this.schedule('remind-unreviewed', EVERY_FIFTEEN_MINUTES);
    await this.schedule('remind-sign-off', EVERY_FIFTEEN_MINUTES);
    await this.schedule('remind-approval', EVERY_FIFTEEN_MINUTES);
    await this.schedule('remind-payment-package', EVERY_FIFTEEN_MINUTES);
    await this.schedule('remind-vendor-check-in', EVERY_FIFTEEN_MINUTES);
  }

  private schedule(name: string, pattern: string) {
    return this.queue.upsertJobScheduler(name, { pattern }, { name });
  }
}
