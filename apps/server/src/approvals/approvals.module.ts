import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module.js';
import { ApprovalsController } from './approvals.controller.js';
import { ApprovalsEngineService } from './approvals-engine.service.js';
import { ApprovalsService } from './approvals.service.js';

@Module({
  imports: [CommonModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsEngineService, ApprovalsService],
  exports: [ApprovalsEngineService, ApprovalsService],
})
export class ApprovalsModule {}
