import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module.js';
import { AdminApprovalsController } from './admin-approvals.controller.js';
import { AdminApprovalsService } from './admin-approvals.service.js';

@Module({
  imports: [CommonModule],
  controllers: [AdminApprovalsController],
  providers: [AdminApprovalsService],
})
export class AdminApprovalsModule {}
