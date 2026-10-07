import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { CommonModule } from '../common/common.module.js';
import { EstimatesController } from './estimates.controller.js';
import { EstimatesService } from './estimates.service.js';

@Module({
  imports: [CommonModule, ApprovalsModule],
  controllers: [EstimatesController],
  providers: [EstimatesService],
})
export class EstimatesModule {}
