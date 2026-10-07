import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { TransitionsService } from './transitions.service.js';

@Global()
@Module({
  providers: [AuditService, TransitionsService],
  exports: [AuditService, TransitionsService],
})
export class CommonModule {}
