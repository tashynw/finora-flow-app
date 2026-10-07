import { Module } from '@nestjs/common';
import { CostCentresController } from './cost-centres.controller.js';
import { CostCentresService } from './cost-centres.service.js';

@Module({
  controllers: [CostCentresController],
  providers: [CostCentresService],
  exports: [CostCentresService],
})
export class CostCentresModule {}
