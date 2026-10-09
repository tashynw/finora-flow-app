import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

@Processor('{sample}')
export class SampleProcessor extends WorkerHost {
  async process(_job: Job) {
    console.log('Hi Job');
  }
}
