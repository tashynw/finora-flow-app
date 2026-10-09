import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

@Injectable()
export class SampleJobScheduler implements OnModuleInit {
  constructor(@InjectQueue('{sample}') private readonly queue: Queue) {}

  async onModuleInit() {
    await this.queue.upsertJobScheduler(
      'hi-job',
      { pattern: '0 * * * * *' },
      { name: 'hi-job' },
    );
  }
}
