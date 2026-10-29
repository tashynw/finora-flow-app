import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { resolveCacheTarget } from './elasticache-auth.js';
import { DocumentsJob } from './documents/documents.job.js';
import { FinoraJobScheduler } from './finora-job.scheduler.js';
import { FinoraProcessor } from './finora.processor.js';
import { InboxJob } from './inbox/inbox.job.js';
import { useCacheTarget } from './redis-client.js';
import { RemindersJob } from './reminders/reminders.job.js';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: async () => {
        const target = await resolveCacheTarget();
        useCacheTarget(target);
        return {
          connection: {
            host: target.host,
            port: target.port,
            username: target.username,
            password: '',
            tls: { minVersion: 'TLSv1.3' },
            disableClientInfo: true,
            protocol: 2,
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
    BullModule.registerQueue({ name: '{finora}' }),
    ApprovalsModule,
    AiModule,
  ],
  providers: [
    InboxJob,
    DocumentsJob,
    RemindersJob,
    FinoraProcessor,
    FinoraJobScheduler,
  ],
})
export class JobsModule {}
