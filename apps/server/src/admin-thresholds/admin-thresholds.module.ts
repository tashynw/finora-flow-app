import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module.js';
import { AdminThresholdsController } from './admin-thresholds.controller.js';
import { AdminThresholdsService } from './admin-thresholds.service.js';

@Module({
  imports: [CommonModule],
  controllers: [AdminThresholdsController],
  providers: [AdminThresholdsService],
})
export class AdminThresholdsModule {}
