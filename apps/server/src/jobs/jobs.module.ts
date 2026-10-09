import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { resolveCacheTarget } from './elasticache-auth.js';
import { useCacheTarget } from './redis-client.js';
import { SampleJobScheduler } from './sample-job.scheduler.js';
import { SampleProcessor } from './sample.processor.js';

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
    BullModule.registerQueue({ name: '{sample}' }),
  ],
  providers: [SampleProcessor, SampleJobScheduler],
})
export class JobsModule {}
