import { Module } from '@nestjs/common';
import { AccrualsController } from './accruals.controller.js';
import { AccrualsService } from './accruals.service.js';

@Module({
  controllers: [AccrualsController],
  providers: [AccrualsService],
  exports: [AccrualsService],
})
export class AccrualsModule {}
